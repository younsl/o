use anyhow::{Context, Result, anyhow};
use aya::{
    Ebpf,
    maps::{MapData, PerCpuArray},
    programs::{Lsm, TracePoint},
};
use std::fs;
use tracing::{info, warn};

pub static EBPF_OBJECT: &[u8] = include_bytes!(env!("COPYFAIL_GUARD_EBPF_OBJ"));

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Lsm,
    Tracepoint,
}

const LSM_PATH: &str = "/sys/kernel/security/lsm";

pub fn detect_mode() -> Mode {
    match fs::read_to_string(LSM_PATH) {
        Ok(s) if s.split(',').any(|m| m.trim() == "bpf") => {
            info!(file = LSM_PATH, content = s.trim(), "BPF LSM enabled");
            Mode::Lsm
        }
        Ok(s) => {
            warn!(
                file = LSM_PATH,
                content = s.trim(),
                "BPF LSM not enabled; falling back to tracepoint killer"
            );
            Mode::Tracepoint
        }
        Err(e) => {
            warn!(error = %e, "cannot read {}; falling back to tracepoint killer", LSM_PATH);
            Mode::Tracepoint
        }
    }
}

pub struct ProgramLoader {
    bpf: Ebpf,
    mode: Mode,
}

impl ProgramLoader {
    pub fn load(mode: Mode) -> Result<Self> {
        let bpf = Ebpf::load(EBPF_OBJECT).context("parse embedded eBPF object")?;
        Ok(Self { bpf, mode })
    }

    pub fn attach(&mut self) -> Result<()> {
        match self.mode {
            Mode::Lsm => {
                let prog: &mut Lsm = self
                    .bpf
                    .program_mut("copyfail_guard_filter")
                    .ok_or_else(|| anyhow!("program copyfail_guard_filter not found"))?
                    .try_into()?;

                let btf =
                    aya::Btf::from_sys_fs().context("load kernel BTF (/sys/kernel/btf/vmlinux)")?;
                prog.load("socket_create", &btf)
                    .context("load LSM socket_create program — kernel may lack BPF LSM support")?;
                prog.attach().context("attach LSM hook")?;
            }
            Mode::Tracepoint => {
                let prog: &mut TracePoint = self
                    .bpf
                    .program_mut("copyfail_guard_killer")
                    .ok_or_else(|| anyhow!("program copyfail_guard_killer not found"))?
                    .try_into()?;
                prog.load().context("load tracepoint program")?;
                prog.attach("syscalls", "sys_enter_socket")
                    .context("attach syscalls/sys_enter_socket")?;
            }
        }
        Ok(())
    }

    pub fn events_map(&mut self) -> Result<aya::maps::RingBuf<MapData>> {
        let map = self
            .bpf
            .take_map("EVENTS")
            .ok_or_else(|| anyhow!("map EVENTS not found"))?;
        Ok(aya::maps::RingBuf::try_from(map)?)
    }

    pub fn dropped_map(&mut self) -> Result<DroppedCounter> {
        let map = self
            .bpf
            .take_map("DROPPED")
            .ok_or_else(|| anyhow!("map DROPPED not found"))?;
        let inner: PerCpuArray<MapData, u64> = PerCpuArray::try_from(map)?;
        Ok(DroppedCounter { inner })
    }
}

pub struct DroppedCounter {
    inner: PerCpuArray<MapData, u64>,
}

impl DroppedCounter {
    pub fn total(&self) -> Result<u64> {
        let values = self.inner.get(&0, 0)?;
        Ok(values.iter().sum())
    }
}
