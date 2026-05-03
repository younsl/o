use std::sync::Arc;

use anyhow::Result;
use aya::maps::{MapData, RingBuf};
use tokio::io::unix::AsyncFd;
use tracing::{error, info};

use crate::abi::{ACTION_BLOCKED, ACTION_KILLED, COMM_LEN, Event};
use crate::metrics::Metrics;

#[derive(Clone)]
pub struct NodeContext {
    pub node: String,
    pub pod: String,
}

pub async fn run(ring: RingBuf<MapData>, metrics: Arc<Metrics>, ctx: NodeContext) -> Result<()> {
    let mut async_fd = AsyncFd::new(ring)?;
    info!(node = %ctx.node, pod = %ctx.pod, "ring buffer consumer started");
    loop {
        let mut guard = async_fd.readable_mut().await?;
        let ring = guard.get_inner_mut();
        while let Some(item) = ring.next() {
            handle_event(&item, &metrics, &ctx);
        }
        guard.clear_ready();
    }
}

fn handle_event(bytes: &[u8], metrics: &Metrics, ctx: &NodeContext) {
    if bytes.len() < std::mem::size_of::<Event>() {
        error!(len = bytes.len(), "event smaller than expected struct");
        return;
    }
    let ev: Event = unsafe { std::ptr::read_unaligned(bytes.as_ptr() as *const Event) };

    let comm = comm_to_str(&ev.comm);
    let action = match ev.action {
        ACTION_BLOCKED => "blocked",
        ACTION_KILLED => "killed",
        _ => "unknown",
    };

    let (pod_uid, container_id) = resolve_cgroup(ev.tgid);

    info!(
        action,
        node = %ctx.node,
        agent_pod = %ctx.pod,
        pid = ev.pid,
        tgid = ev.tgid,
        uid = ev.uid,
        gid = ev.gid,
        comm = %comm,
        target_pod_uid = %pod_uid.as_deref().unwrap_or("-"),
        container_id = %container_id.as_deref().unwrap_or("-"),
        "AF_ALG socket creation intercepted"
    );

    metrics.record_event(action);
}

fn comm_to_str(comm: &[u8; COMM_LEN]) -> String {
    let end = comm.iter().position(|&b| b == 0).unwrap_or(COMM_LEN);
    String::from_utf8_lossy(&comm[..end]).into_owned()
}

fn resolve_cgroup(tgid: u32) -> (Option<String>, Option<String>) {
    let path = format!("/proc/{}/cgroup", tgid);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return (None, None);
    };
    parse_cgroup_line(&content)
}

fn parse_cgroup_line(content: &str) -> (Option<String>, Option<String>) {
    // cgroup v2 line: "0::/kubepods.slice/.../kubepods-pod<UID>.slice/cri-containerd-<ID>.scope"
    // cgroup v1 line: "<id>:<controller>:/kubepods/.../pod<UID>/<containerID>"
    let line = content.lines().next().unwrap_or("");
    let path = line.rsplit_once("::").map(|(_, p)| p).unwrap_or(line);

    let pod_uid = path
        .split('/')
        .find_map(|seg| {
            seg.strip_prefix("kubepods-pod")
                .or_else(|| seg.strip_prefix("kubepods-besteffort-pod"))
                .or_else(|| seg.strip_prefix("kubepods-burstable-pod"))
                .or_else(|| seg.strip_prefix("pod"))
                .and_then(|s| s.strip_suffix(".slice").or(Some(s)))
        })
        .map(|s| s.replace('_', "-"));

    let container_id = path
        .rsplit('/')
        .find_map(|seg| {
            seg.strip_prefix("cri-containerd-")
                .or_else(|| seg.strip_prefix("crio-"))
                .or_else(|| seg.strip_prefix("docker-"))
                .and_then(|s| s.strip_suffix(".scope").or(Some(s)))
        })
        .map(|s| s.to_string());

    (pod_uid, container_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_v2_kubepods() {
        let line = "0::/kubepods.slice/kubepods-burstable.slice/kubepods-burstable-pod1234abcd_5678_90ef_aabb_ccddeeff0011.slice/cri-containerd-deadbeef00.scope\n";
        let (uid, cid) = parse_cgroup_line(line);
        assert_eq!(uid.as_deref(), Some("1234abcd-5678-90ef-aabb-ccddeeff0011"));
        assert_eq!(cid.as_deref(), Some("deadbeef00"));
    }

    #[test]
    fn parse_non_kube() {
        let line = "0::/user.slice/user-1000.slice/session-1.scope\n";
        let (uid, cid) = parse_cgroup_line(line);
        assert!(uid.is_none());
        assert!(cid.is_none());
    }
}
