#![no_std]
#![no_main]

mod abi;

use aya_ebpf::{
    bindings::BPF_F_CURRENT_CPU,
    helpers::{
        bpf_get_current_comm, bpf_get_current_pid_tgid, bpf_get_current_uid_gid, bpf_send_signal,
    },
    macros::{lsm, map, tracepoint},
    maps::{PerCpuArray, RingBuf},
    programs::{LsmContext, TracePointContext},
};

use abi::{ACTION_BLOCKED, ACTION_KILLED, AF_ALG, COMM_LEN, Event};

const SIGKILL: u32 = 9;
const EPERM: i32 = -1;

#[map]
static EVENTS: RingBuf = RingBuf::with_byte_size(16 * 1024 * 1024, 0);

#[map]
static DROPPED: PerCpuArray<u64> = PerCpuArray::with_max_entries(1, 0);

#[lsm(hook = "socket_create")]
pub fn copyfail_guard_filter(ctx: LsmContext) -> i32 {
    match try_filter(ctx) {
        Ok(ret) => ret,
        Err(_) => 0,
    }
}

fn try_filter(ctx: LsmContext) -> Result<i32, i64> {
    let family: i32 = unsafe { ctx.arg(0) };
    let kern: i32 = unsafe { ctx.arg(3) };

    if kern != 0 {
        return Ok(0);
    }
    if family as u16 != AF_ALG {
        return Ok(0);
    }

    emit_event(ACTION_BLOCKED);
    Ok(EPERM)
}

#[tracepoint(name = "copyfail_guard_killer", category = "syscalls")]
pub fn copyfail_guard_killer(ctx: TracePointContext) -> u32 {
    match try_killer(ctx) {
        Ok(ret) => ret,
        Err(_) => 0,
    }
}

fn try_killer(ctx: TracePointContext) -> Result<u32, i64> {
    // offset 16 = args[0] in trace_event_raw_sys_enter (8B common + 8B syscall id).
    let family: u64 = unsafe { ctx.read_at(16)? };
    if family as u16 != AF_ALG {
        return Ok(0);
    }

    emit_event(ACTION_KILLED);
    let _ = unsafe { bpf_send_signal(SIGKILL) };
    Ok(0)
}

#[inline(always)]
fn emit_event(action: u32) {
    let Some(mut entry) = EVENTS.reserve::<Event>(0) else {
        bump_dropped();
        return;
    };
    let pid_tgid = bpf_get_current_pid_tgid();
    let uid_gid = bpf_get_current_uid_gid();
    let comm = bpf_get_current_comm().unwrap_or([0u8; COMM_LEN]);

    let ev = Event {
        pid: pid_tgid as u32,
        tgid: (pid_tgid >> 32) as u32,
        uid: uid_gid as u32,
        gid: (uid_gid >> 32) as u32,
        action,
        comm,
    };
    entry.write(ev);
    entry.submit(BPF_F_CURRENT_CPU as u64);
}

#[inline(always)]
fn bump_dropped() {
    if let Some(slot) = DROPPED.get_ptr_mut(0) {
        // PerCpuArray: per-CPU storage, eBPF non-preemptible per-CPU.
        unsafe { *slot = (*slot).wrapping_add(1) };
    }
}

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    loop {}
}

#[unsafe(link_section = "license")]
#[unsafe(no_mangle)]
static LICENSE: [u8; 13] = *b"Dual MIT/GPL\0";
