#[allow(dead_code)]
pub const AF_ALG: u16 = 38;
pub const COMM_LEN: usize = 16;

pub const ACTION_BLOCKED: u32 = 1;
pub const ACTION_KILLED: u32 = 2;

#[repr(C)]
#[derive(Copy, Clone)]
pub struct Event {
    pub pid: u32,
    pub tgid: u32,
    pub uid: u32,
    pub gid: u32,
    pub action: u32,
    pub comm: [u8; COMM_LEN],
}

#[cfg(not(target_arch = "bpf"))]
unsafe impl aya::Pod for Event {}
