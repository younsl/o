//! Karpenter `NodePool` node replacement phase (forward-only).
//!
//! Runs after managed node groups. For each target `NodePool`, kuo replaces stale
//! nodes (kubelet minor below the target) by deleting their `NodeClaims` and
//! letting Karpenter cordon, drain, and reprovision. Between nodes it waits for
//! the controllers that owned the evicted pods to recover.
//!
//! Like the node group phase, this is non-blocking: each reconcile advances one
//! step and requeues. All progress lives in
//! `status.phases.karpenterNodePools`, so a restart resumes from live state.

use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use tracing::{debug, info, warn};

use crate::aws::AwsClients;
use crate::crd::{
    ComponentStatus, CurrentBatchEntry, EKSUpgradeSpec, EKSUpgradeStatus, KarpenterNodePoolsStatus,
    KarpenterPoolStatus, UpgradePhase,
};
use crate::eks::client::EksClient;
use crate::k8s::workload::ControllerRef;
use crate::k8s::{karpenter, node, workload};
use crate::phases::transition;
use crate::status;

/// Poll cadence while waiting on drain or controller recovery.
pub const POLL_INTERVAL: Duration = Duration::from_secs(30);

const STATE_DRAINING: &str = "Draining";
const STATE_WAIT_STABLE: &str = "WaitingControllerStable";

/// What to do with an in-flight batch entry this reconcile.
#[derive(Debug, PartialEq, Eq)]
enum EntryOutcome {
    /// Old node still draining; keep waiting.
    Draining,
    /// Old node gone; waiting for controllers to recover.
    WaitStable,
    /// Replacement complete.
    Done,
    /// Timeout exceeded; the reason string explains which.
    Failed(String),
}

/// Decide an entry's next state from live observations. Pure and unit-tested.
fn decide_entry(
    state: &str,
    node_exists: bool,
    controllers_stable: bool,
    elapsed_secs: i64,
    drain_to_secs: i64,
    stable_to_secs: i64,
) -> EntryOutcome {
    if state == STATE_DRAINING && node_exists {
        return if elapsed_secs > drain_to_secs {
            EntryOutcome::Failed(format!(
                "NodeDrainTimeout after {}m, the old node was not removed in time",
                drain_to_secs / 60
            ))
        } else {
            EntryOutcome::Draining
        };
    }
    // Old node is gone (or we were already past draining): judge recovery.
    if controllers_stable {
        EntryOutcome::Done
    } else if elapsed_secs > drain_to_secs + stable_to_secs {
        EntryOutcome::Failed(format!(
            "ControllerStableTimeout after {}m, workloads did not become Ready again in time",
            stable_to_secs / 60
        ))
    } else {
        EntryOutcome::WaitStable
    }
}

/// Determine which `NodeClaims` are stale replacement targets. Pure.
///
/// A candidate is `(claim_name, backing_node_kubelet_version)`. A claim is stale
/// when its backing node's kubelet minor is below `target_minor` and it is not
/// already completed. Claims with no backing node yet (still provisioning) or an
/// unparseable kubelet version are not targeted.
fn stale_targets(
    candidates: &[(String, Option<String>)],
    completed: &[String],
    target_minor: u32,
) -> Vec<String> {
    candidates
        .iter()
        .filter(|(name, kubelet)| {
            !completed.contains(name)
                && kubelet
                    .as_deref()
                    .is_some_and(|kv| node::is_stale_kubelet(kv, target_minor))
        })
        .map(|(name, _)| name.clone())
        .collect()
}

/// Identify the `NodeClaim` Karpenter provisioned to replace a removed one. Pure.
///
/// Picks the first claim whose name is not in `known` (all old/tracked names)
/// and, when both timestamps are available, was created at or after `after`
/// (the moment the old claim was deleted). For the default sequential
/// replacement this uniquely identifies the new node; with higher concurrency it
/// is best-effort. Returns `None` if no candidate matches.
fn pick_new_nodeclaim(
    candidates: &[karpenter::NodeClaimInfo],
    known: &[String],
    after: Option<DateTime<Utc>>,
) -> Option<String> {
    candidates
        .iter()
        .filter(|c| !known.contains(&c.name))
        .find(|c| match (after, c.created_at) {
            (Some(a), Some(created)) => created >= a,
            // Missing timestamps: fall back to name novelty alone.
            _ => true,
        })
        .map(|c| c.name.clone())
}

/// Select up to `max` stale `NodeClaim` names not yet completed. Pure.
fn select_batch(stale: &[String], completed: &[String], max: usize) -> Vec<String> {
    stale
        .iter()
        .filter(|n| !completed.contains(n))
        .take(max.max(1))
        .cloned()
        .collect()
}

fn encode_controller(c: &ControllerRef) -> String {
    format!("{}|{}|{}", c.kind, c.namespace, c.name)
}

fn decode_controller(s: &str) -> Option<ControllerRef> {
    let mut parts = s.splitn(3, '|');
    Some(ControllerRef {
        kind: parts.next()?.to_string(),
        namespace: parts.next()?.to_string(),
        name: parts.next()?.to_string(),
    })
}

/// Build the phase-entry log line naming the cluster and `NodePool` order. Pure.
///
/// Returns `Some` only on the first reconcile of the phase, i.e. when every pool
/// is still `Pending` (nothing started), so the line is logged once. Empty pool
/// sets return `None`.
fn phase_start_line(cluster: &str, pools: &[KarpenterPoolStatus]) -> Option<String> {
    if pools.is_empty()
        || !pools
            .iter()
            .all(|p| matches!(p.status, ComponentStatus::Pending))
    {
        return None;
    }
    let order = pools
        .iter()
        .map(|p| p.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "Starting Karpenter NodePool replacement for cluster {cluster}, processing {} NodePools in order {order}",
        pools.len()
    ))
}

/// Index of the first pool still needing work.
fn active_pool_index(pools: &[KarpenterPoolStatus]) -> Option<usize> {
    pools.iter().position(|p| {
        !matches!(
            p.status,
            ComponentStatus::Completed | ComponentStatus::Skipped | ComponentStatus::Failed
        )
    })
}

fn elapsed_secs(started_at: Option<DateTime<Utc>>, now: DateTime<Utc>) -> i64 {
    started_at.map_or(0, |s| (now - s).num_seconds())
}

/// Execute one reconcile step of the Karpenter `NodePool` replacement phase.
pub async fn execute(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
    aws: &AwsClients,
) -> Result<(EKSUpgradeStatus, Option<Duration>)> {
    let config = spec
        .karpenter_node_pools
        .as_ref()
        .expect("karpenter phase entered without karpenterNodePools config");

    let mut new_status = current_status.clone();
    let Some(mut kp) = new_status.phases.karpenter_node_pools.clone() else {
        // No planned Karpenter work; nothing to do.
        transition::transition_to(&mut new_status, UpgradePhase::Completed);
        return Ok((new_status, Some(Duration::from_secs(0))));
    };

    // On phase entry (nothing started yet), log the cluster and the order in
    // which NodePools will be processed.
    if let Some(line) = phase_start_line(&spec.cluster_name, &kp.pools) {
        info!("{line}");
    }

    let Some(idx) = active_pool_index(&kp.pools) else {
        // All pools done: finish the phase.
        kp.active_pool = None;
        new_status.phases.karpenter_node_pools = Some(kp);
        let next = transition::after_karpenter(&new_status, &spec.upgrade_mode);
        transition::transition_to(&mut new_status, next);
        info!("Karpenter NodePool replacement complete");
        return Ok((new_status, Some(Duration::from_secs(0))));
    };

    // Build a Kubernetes client for the target cluster.
    let eks_client = EksClient::new(aws.eks.clone(), aws.region.clone());
    let cluster = eks_client
        .describe_cluster(&spec.cluster_name)
        .await?
        .ok_or_else(|| crate::error::KuoError::ClusterNotFound(spec.cluster_name.clone()))?;
    let client = crate::k8s::client::build_kube_client(
        &cluster,
        eks_client.region(),
        spec.assume_role_arn.as_deref(),
    )
    .await?;

    let Some(target_minor) = node::parse_minor(&spec.target_version) else {
        status::set_failed(
            &mut new_status,
            format!("Invalid target version: {}", spec.target_version),
        );
        return Ok((new_status, None));
    };

    let drain_to =
        i64::try_from(config.node_drain_timeout_minutes.saturating_mul(60)).unwrap_or(i64::MAX);
    let stable_to = i64::try_from(config.controller_stable_timeout_minutes.saturating_mul(60))
        .unwrap_or(i64::MAX);
    let now = Utc::now();

    let pool = &mut kp.pools[idx];
    pool.status = ComponentStatus::InProgress;
    let pool_name = pool.name.clone();

    let requeue = if pool.current_batch.is_empty() {
        start_next_batch(&client, pool, config, target_minor, now).await?
    } else {
        advance_batch(&client, pool, drain_to, stable_to, now).await?
    };

    // Roll up aggregate counters and active pool.
    if let Some(reason) = requeue.failure.clone() {
        pool.status = ComponentStatus::Failed;
        recompute_totals(&mut kp);
        new_status.phases.karpenter_node_pools = Some(kp);
        status::set_failed(
            &mut new_status,
            format!("Karpenter NodePool {pool_name} failed: {reason}"),
        );
        return Ok((new_status, None));
    }

    kp.active_pool = Some(pool_name);
    recompute_totals(&mut kp);
    new_status.phases.karpenter_node_pools = Some(kp);
    Ok((new_status, Some(requeue.after)))
}

/// Outcome of a batch step: how long to requeue, or a failure reason.
struct StepResult {
    after: Duration,
    failure: Option<String>,
}

impl StepResult {
    const fn requeue(after: Duration) -> Self {
        Self {
            after,
            failure: None,
        }
    }
    const fn failed(reason: String) -> Self {
        Self {
            after: Duration::from_secs(0),
            failure: Some(reason),
        }
    }
}

/// Compute stale `NodeClaims` and start the next replacement batch.
async fn start_next_batch(
    client: &kube::Client,
    pool: &mut KarpenterPoolStatus,
    config: &crate::crd::KarpenterNodePoolsConfig,
    target_minor: u32,
    now: DateTime<Utc>,
) -> Result<StepResult> {
    let claims = karpenter::list_nodeclaims(client, &pool.name).await?;

    // Resolve each claim's backing-node kubelet version, then decide staleness
    // with the pure `stale_targets` helper.
    let mut candidates = Vec::with_capacity(claims.len());
    for claim in &claims {
        let kubelet = if let Some(node_name) = &claim.node_name {
            node::get(client, node_name)
                .await?
                .as_ref()
                .and_then(|n| node::kubelet_version(n).map(String::from))
        } else {
            None
        };
        candidates.push((claim.name.clone(), kubelet));
    }
    let stale = stale_targets(&candidates, &pool.completed_node_claims, target_minor);

    // Fix the pool total on first observation (replaced + remaining stale).
    if pool.total_nodes == 0 {
        pool.total_nodes = u32::try_from(stale.len()).unwrap_or(u32::MAX);
    }

    if stale.is_empty() {
        pool.status = ComponentStatus::Completed;
        info!("NodePool {} fully replaced", pool.name);
        return Ok(StepResult::requeue(Duration::from_secs(0)));
    }

    let max = config.resolve_max_unavailable(pool.total_nodes as usize);
    let batch = select_batch(&stale, &pool.completed_node_claims, max);
    info!(
        "NodePool {} is replacing {} of {} stale nodes in this batch",
        pool.name,
        batch.len(),
        stale.len()
    );

    for name in batch {
        let claim = claims.iter().find(|c| c.name == name);
        let node_name = claim.and_then(|c| c.node_name.clone());
        let provider_id = claim.and_then(|c| c.provider_id.clone());

        // Snapshot owning controllers BEFORE deletion.
        let controllers = if let Some(nn) = &node_name {
            let pods = node::pods_on_node(client, nn).await?;
            workload::resolve_controllers(client, &pods)
                .await?
                .iter()
                .map(encode_controller)
                .collect()
        } else {
            Vec::new()
        };

        karpenter::delete_nodeclaim(client, &name).await?;
        info!(
            "NodePool {} deleted NodeClaim {} on node {}, waiting for Karpenter to drain and reprovision",
            pool.name,
            name,
            node_name.as_deref().unwrap_or("unknown")
        );
        pool.current_batch.push(CurrentBatchEntry {
            node_claim: name,
            node_name,
            provider_id,
            state: STATE_DRAINING.to_string(),
            started_at: Some(now),
            controllers,
        });
    }

    Ok(StepResult::requeue(POLL_INTERVAL))
}

/// Result of advancing a batch: which entries remain in flight, which `NodeClaims`
/// completed this step, and an optional failure reason.
#[derive(Debug, Default)]
struct BatchProgress {
    remaining: Vec<CurrentBatchEntry>,
    completed: Vec<CurrentBatchEntry>,
    failure: Option<String>,
}

/// Advance batch entries from their observations. Pure and unit-tested.
///
/// Each observation is `(entry, node_exists, controllers_stable)`. On the first
/// timeout the remaining processed entries plus the failed one are kept and
/// processing stops.
fn advance_entries(
    observed: Vec<(CurrentBatchEntry, bool, bool)>,
    drain_to: i64,
    stable_to: i64,
    now: DateTime<Utc>,
) -> BatchProgress {
    let mut progress = BatchProgress::default();
    for (mut entry, node_exists, controllers_stable) in observed {
        let elapsed = elapsed_secs(entry.started_at, now);
        match decide_entry(
            &entry.state,
            node_exists,
            controllers_stable,
            elapsed,
            drain_to,
            stable_to,
        ) {
            EntryOutcome::Draining => {
                entry.state = STATE_DRAINING.to_string();
                progress.remaining.push(entry);
            }
            EntryOutcome::WaitStable => {
                entry.state = STATE_WAIT_STABLE.to_string();
                progress.remaining.push(entry);
            }
            EntryOutcome::Done => {
                progress.completed.push(entry);
            }
            EntryOutcome::Failed(reason) => {
                progress.remaining.push(entry);
                progress.failure = Some(reason);
                break;
            }
        }
    }
    progress
}

/// Advance the in-flight batch, completing or failing entries.
async fn advance_batch(
    client: &kube::Client,
    pool: &mut KarpenterPoolStatus,
    drain_to: i64,
    stable_to: i64,
    now: DateTime<Utc>,
) -> Result<StepResult> {
    // Observe each entry against the live cluster, then decide purely.
    let mut observed = Vec::with_capacity(pool.current_batch.len());
    for entry in std::mem::take(&mut pool.current_batch) {
        let node_exists = karpenter::nodeclaim_exists(client, &entry.node_claim).await?;
        let controllers_stable = if node_exists {
            false
        } else {
            let refs: Vec<ControllerRef> = entry
                .controllers
                .iter()
                .filter_map(|s| decode_controller(s))
                .collect();
            workload::unstable_controllers(client, &refs)
                .await?
                .is_empty()
        };
        observed.push((entry, node_exists, controllers_stable));
    }

    let progress = advance_entries(observed, drain_to, stable_to, now);
    pool.current_batch = progress.remaining;

    for entry in &pool.current_batch {
        if entry.state == STATE_DRAINING {
            debug!(
                "NodePool {} is waiting for node {} to finish draining before the NodeClaim is removed",
                pool.name,
                entry.node_name.as_deref().unwrap_or("unknown")
            );
        } else {
            debug!(
                "NodePool {} removed old NodeClaim {} and is waiting for its workloads to become Ready again",
                pool.name, entry.node_claim
            );
        }
    }

    // For each completed replacement, identify the NodeClaim Karpenter created in
    // its place so the event can name it. The new claim is one that did not exist
    // before (not a known old name) and was created after we deleted the old one.
    if !progress.completed.is_empty() {
        let claims = karpenter::list_nodeclaims(client, &pool.name).await?;
        let mut known: Vec<String> = pool.completed_node_claims.clone();
        known.extend(pool.current_batch.iter().map(|e| e.node_claim.clone()));
        for e in &progress.completed {
            known.push(e.node_claim.clone());
        }
        for entry in progress.completed {
            let new_claim = pick_new_nodeclaim(&claims, &known, entry.started_at);
            if let Some(n) = &new_claim {
                known.push(n.clone());
            }
            info!(
                "NodePool {} finished replacing old NodeClaim {}, new NodeClaim is {} and its workloads recovered",
                pool.name,
                entry.node_claim,
                new_claim.as_deref().unwrap_or("unknown")
            );
            pool.replaced_nodes = pool.replaced_nodes.saturating_add(1);
            pool.completed_node_claims.push(entry.node_claim.clone());
            pool.replacements.push(crate::crd::NodeClaimReplacement {
                old_node_claim: entry.node_claim,
                new_node_claim: new_claim,
                node_name: entry.node_name,
            });
        }
    }

    if let Some(reason) = progress.failure {
        warn!("NodePool {} replacement failed because {reason}", pool.name);
        return Ok(StepResult::failed(reason));
    }

    // Empty batch -> start the next one promptly; otherwise keep polling.
    let after = if pool.current_batch.is_empty() {
        Duration::from_secs(0)
    } else {
        POLL_INTERVAL
    };
    Ok(StepResult::requeue(after))
}

/// A Kubernetes Event to emit for a `NodeClaim` replacement transition.
#[derive(Debug, PartialEq, Eq)]
pub struct ReplacementEvent {
    pub reason: &'static str,
    pub message: String,
}

/// Diff two Karpenter statuses and produce Events for replacement transitions.
///
/// Emits `NodeClaimReplacing` when a `NodeClaim` newly enters a batch (kuo just
/// deleted it and Karpenter is provisioning its replacement), and
/// `NodeClaimReplaced`, naming the new `NodeClaim`, when a replacement completes.
/// Each message states the `NodePool` and the node's position (`N/total`) so
/// operators can identify each replaced node and the overall progress in the
/// `EKSUpgrade` event stream. Pure and unit-tested.
#[must_use]
pub fn replacement_events(
    old: Option<&KarpenterNodePoolsStatus>,
    new: Option<&KarpenterNodePoolsStatus>,
) -> Vec<ReplacementEvent> {
    let Some(new) = new else {
        return vec![];
    };
    let mut events = Vec::new();

    for pool in &new.pools {
        let old_pool = old.and_then(|o| o.pools.iter().find(|p| p.name == pool.name));
        let old_batch: Vec<&str> = old_pool.map_or_else(Vec::new, |p| {
            p.current_batch
                .iter()
                .map(|e| e.node_claim.as_str())
                .collect()
        });
        let old_replaced_count = old_pool.map_or(0, |p| p.replacements.len());
        let total = pool.total_nodes;

        // Newly started replacements. Their ordinal continues after the ones
        // already completed plus any earlier new starts in this same batch.
        let mut starting = 0u32;
        for entry in &pool.current_batch {
            if !old_batch.contains(&entry.node_claim.as_str()) {
                let ordinal = pool.replaced_nodes + starting + 1;
                starting += 1;
                let node = entry
                    .node_name
                    .as_deref()
                    .map_or_else(String::new, |n| format!(" on node {n}"));
                events.push(ReplacementEvent {
                    reason: "NodeClaimReplacing",
                    message: format!(
                        "NodePool {} is replacing node {ordinal} of {total}, NodeClaim {}{node}",
                        pool.name, entry.node_claim
                    ),
                });
            }
        }

        // Newly completed replacements, naming the new NodeClaim. The ordinal is
        // the replacement's 1-based position in the accumulated list.
        for (idx, rep) in pool.replacements.iter().enumerate() {
            if idx >= old_replaced_count {
                let ordinal = idx + 1;
                let new_claim = rep.new_node_claim.as_deref().unwrap_or("unknown");
                let node = rep
                    .node_name
                    .as_deref()
                    .map_or_else(String::new, |n| format!(" on former node {n}"));
                events.push(ReplacementEvent {
                    reason: "NodeClaimReplaced",
                    message: format!(
                        "NodePool {} replaced node {ordinal} of {total}, old NodeClaim {} is now {new_claim}{node}",
                        pool.name, rep.old_node_claim
                    ),
                });
            }
        }
    }

    events
}

/// Recompute the top-level totals from per-pool counters.
fn recompute_totals(kp: &mut KarpenterNodePoolsStatus) {
    kp.total_nodes = kp.pools.iter().map(|p| p.total_nodes).sum();
    kp.replaced_nodes = kp.pools.iter().map(|p| p.replaced_nodes).sum();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stale_targets_filters_by_version_and_completed() {
        let candidates = vec![
            ("a".to_string(), Some("v1.33.0-eks-x".to_string())), // stale
            ("b".to_string(), Some("v1.34.0-eks-x".to_string())), // current
            ("c".to_string(), Some("v1.33.5-eks-x".to_string())), // stale but completed
            ("d".to_string(), None),                              // still provisioning
            ("e".to_string(), Some("garbage".to_string())),       // unparseable
        ];
        let completed = vec!["c".to_string()];
        assert_eq!(stale_targets(&candidates, &completed, 34), vec!["a"]);
    }

    #[test]
    fn test_stale_targets_empty() {
        assert_eq!(stale_targets(&[], &[], 34), Vec::<String>::new());
    }

    #[test]
    fn test_select_batch_respects_max_and_completed() {
        let stale = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let completed = vec!["a".to_string()];
        assert_eq!(select_batch(&stale, &completed, 2), vec!["b", "c"]);
        assert_eq!(select_batch(&stale, &completed, 1), vec!["b"]);
    }

    #[test]
    fn test_select_batch_floor_one() {
        let stale = vec!["a".to_string(), "b".to_string()];
        assert_eq!(select_batch(&stale, &[], 0), vec!["a"]);
    }

    #[test]
    fn test_decide_entry_draining_within_timeout() {
        assert_eq!(
            decide_entry(STATE_DRAINING, true, false, 60, 900, 600),
            EntryOutcome::Draining
        );
    }

    #[test]
    fn test_decide_entry_drain_timeout() {
        match decide_entry(STATE_DRAINING, true, false, 901, 900, 600) {
            EntryOutcome::Failed(r) => assert!(r.contains("NodeDrainTimeout")),
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn test_decide_entry_drained_and_stable_is_done() {
        assert_eq!(
            decide_entry(STATE_DRAINING, false, true, 100, 900, 600),
            EntryOutcome::Done
        );
    }

    #[test]
    fn test_decide_entry_drained_not_stable_waits() {
        assert_eq!(
            decide_entry(STATE_WAIT_STABLE, false, false, 100, 900, 600),
            EntryOutcome::WaitStable
        );
    }

    #[test]
    fn test_decide_entry_stable_timeout() {
        match decide_entry(STATE_WAIT_STABLE, false, false, 1501, 900, 600) {
            EntryOutcome::Failed(r) => assert!(r.contains("ControllerStableTimeout")),
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn test_elapsed_secs() {
        assert_eq!(elapsed_secs(None, now_at(100)), 0);
        assert_eq!(elapsed_secs(Some(now_at(40)), now_at(100)), 60);
    }

    #[test]
    fn test_step_result_constructors() {
        let r = StepResult::requeue(Duration::from_secs(30));
        assert_eq!(r.after, Duration::from_secs(30));
        assert!(r.failure.is_none());

        let f = StepResult::failed("boom".to_string());
        assert_eq!(f.after, Duration::from_secs(0));
        assert_eq!(f.failure.as_deref(), Some("boom"));
    }

    #[test]
    fn test_encode_decode_controller_roundtrip() {
        let c = ControllerRef {
            kind: "Deployment".to_string(),
            namespace: "default".to_string(),
            name: "web".to_string(),
        };
        let encoded = encode_controller(&c);
        assert_eq!(encoded, "Deployment|default|web");
        assert_eq!(decode_controller(&encoded), Some(c));
    }

    #[test]
    fn test_decode_controller_invalid() {
        assert_eq!(decode_controller("bad"), None);
        // Two segments only (missing name) is also invalid.
        assert_eq!(decode_controller("Deployment|default"), None);
    }

    #[test]
    fn test_stale_targets_all_completed_is_empty() {
        let candidates = vec![("a".to_string(), Some("v1.33.0".to_string()))];
        assert!(stale_targets(&candidates, &["a".to_string()], 34).is_empty());
    }

    #[test]
    fn test_select_batch_empty_stale() {
        assert!(select_batch(&[], &[], 3).is_empty());
    }

    #[test]
    fn test_decide_entry_wait_stable_timeout_from_wait_state() {
        // Already in WaitStable, node gone, past drain+stable budget -> Failed.
        match decide_entry(STATE_WAIT_STABLE, false, false, 2000, 900, 600) {
            EntryOutcome::Failed(r) => assert!(r.contains("ControllerStableTimeout")),
            other => panic!("expected failure, got {other:?}"),
        }
    }

    #[test]
    fn test_phase_start_line() {
        let pool = |name: &str, status| KarpenterPoolStatus {
            name: name.to_string(),
            status,
            total_nodes: 0,
            replaced_nodes: 0,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![],
        };
        // All pending -> logs cluster + ordered names.
        let pools = vec![
            pool("critical", ComponentStatus::Pending),
            pool("spot", ComponentStatus::Pending),
        ];
        let line = phase_start_line("sb-cluster", &pools).unwrap();
        assert!(line.contains("sb-cluster"));
        assert!(line.contains("2 NodePools"));
        assert!(line.contains("critical, spot"));

        // Something already started -> None (not the first reconcile).
        let started = vec![
            pool("critical", ComponentStatus::InProgress),
            pool("spot", ComponentStatus::Pending),
        ];
        assert!(phase_start_line("sb-cluster", &started).is_none());

        // Empty -> None.
        assert!(phase_start_line("sb-cluster", &[]).is_none());
    }

    #[test]
    fn test_active_pool_index() {
        let pools = vec![
            KarpenterPoolStatus {
                name: "a".to_string(),
                status: ComponentStatus::Completed,
                total_nodes: 1,
                replaced_nodes: 1,
                completed_node_claims: vec![],
                replacements: vec![],
                current_batch: vec![],
            },
            KarpenterPoolStatus {
                name: "b".to_string(),
                status: ComponentStatus::Pending,
                total_nodes: 2,
                replaced_nodes: 0,
                completed_node_claims: vec![],
                replacements: vec![],
                current_batch: vec![],
            },
        ];
        assert_eq!(active_pool_index(&pools), Some(1));
    }

    #[test]
    fn test_decide_entry_wait_stable_with_node_present_still_waits() {
        // Unusual: state already WaitStable but node reappeared as existing.
        // Treated via recovery branch (not draining), so keeps waiting.
        assert_eq!(
            decide_entry(STATE_WAIT_STABLE, true, false, 50, 900, 600),
            EntryOutcome::WaitStable
        );
    }

    #[test]
    fn test_select_batch_max_exceeds_available() {
        let stale = vec!["a".to_string(), "b".to_string()];
        assert_eq!(select_batch(&stale, &[], 10), vec!["a", "b"]);
    }

    #[test]
    fn test_replacement_events_multiple_new_batch_ordinals() {
        let old = kp_status(KarpenterPoolStatus {
            name: "spot".to_string(),
            status: ComponentStatus::InProgress,
            total_nodes: 5,
            replaced_nodes: 2,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![],
        });
        let new = kp_status(KarpenterPoolStatus {
            name: "spot".to_string(),
            status: ComponentStatus::InProgress,
            total_nodes: 5,
            replaced_nodes: 2,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![
                entry("spot-a", STATE_DRAINING),
                entry("spot-b", STATE_DRAINING),
            ],
        });
        let events = replacement_events(Some(&old), Some(&new));
        let replacing: Vec<&str> = events
            .iter()
            .filter(|e| e.reason == "NodeClaimReplacing")
            .map(|e| e.message.as_str())
            .collect();
        assert_eq!(replacing.len(), 2);
        // replaced_nodes 2 -> ordinals 3 and 4 of 5.
        assert!(replacing[0].contains("node 3 of 5"));
        assert!(replacing[1].contains("node 4 of 5"));
    }

    #[test]
    fn test_replacement_events_skips_already_seen_replacements() {
        let rep = |old: &str| crate::crd::NodeClaimReplacement {
            old_node_claim: old.to_string(),
            new_node_claim: Some(format!("{old}-new")),
            node_name: None,
        };
        let pool = |reps: Vec<crate::crd::NodeClaimReplacement>| KarpenterPoolStatus {
            name: "spot".to_string(),
            status: ComponentStatus::InProgress,
            total_nodes: 3,
            replaced_nodes: u32::try_from(reps.len()).unwrap(),
            completed_node_claims: vec![],
            replacements: reps,
            current_batch: vec![],
        };
        let old = kp_status(pool(vec![rep("n1")]));
        let new = kp_status(pool(vec![rep("n1"), rep("n2")]));
        let events = replacement_events(Some(&old), Some(&new));
        let replaced: Vec<&str> = events
            .iter()
            .filter(|e| e.reason == "NodeClaimReplaced")
            .map(|e| e.message.as_str())
            .collect();
        // Only the newly added replacement (n2) fires, not the already-seen n1.
        assert_eq!(replaced.len(), 1);
        assert!(replaced[0].contains("n2"));
        assert!(replaced[0].contains("node 2 of 3"));
    }

    #[test]
    fn test_active_pool_index_all_done() {
        let pools = vec![KarpenterPoolStatus {
            name: "a".to_string(),
            status: ComponentStatus::Completed,
            total_nodes: 1,
            replaced_nodes: 1,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![],
        }];
        assert_eq!(active_pool_index(&pools), None);
    }

    fn entry(name: &str, state: &str) -> CurrentBatchEntry {
        CurrentBatchEntry {
            node_claim: name.to_string(),
            node_name: None,
            provider_id: None,
            state: state.to_string(),
            started_at: chrono::DateTime::from_timestamp(0, 0),
            controllers: vec![],
        }
    }

    fn now_at(secs: i64) -> DateTime<Utc> {
        chrono::DateTime::from_timestamp(secs, 0).unwrap()
    }

    #[test]
    fn test_advance_entries_completes_and_keeps() {
        let observed = vec![
            (entry("a", STATE_DRAINING), false, true), // drained + stable -> Done
            (entry("b", STATE_DRAINING), true, false), // still draining -> keep
            (entry("c", STATE_WAIT_STABLE), false, false), // waiting -> keep
        ];
        let p = advance_entries(observed, 900, 600, now_at(60));
        assert_eq!(
            p.completed
                .iter()
                .map(|e| e.node_claim.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
        assert_eq!(p.remaining.len(), 2);
        assert!(p.failure.is_none());
        // b stays draining, c stays waiting.
        assert_eq!(p.remaining[0].node_claim, "b");
        assert_eq!(p.remaining[0].state, STATE_DRAINING);
        assert_eq!(p.remaining[1].state, STATE_WAIT_STABLE);
    }

    #[test]
    fn test_advance_entries_drained_transitions_to_wait_stable() {
        let observed = vec![(entry("a", STATE_DRAINING), false, false)];
        let p = advance_entries(observed, 900, 600, now_at(60));
        assert_eq!(p.remaining[0].state, STATE_WAIT_STABLE);
        assert!(p.completed.is_empty());
    }

    #[test]
    fn test_advance_entries_failure_stops() {
        let observed = vec![
            (entry("a", STATE_DRAINING), false, true), // Done
            (entry("b", STATE_DRAINING), true, false), // elapsed > drain -> Failed
            (entry("c", STATE_DRAINING), true, false), // not processed
        ];
        // now = 1000s, drain_to = 900 -> b times out.
        let p = advance_entries(observed, 900, 600, now_at(1000));
        assert_eq!(
            p.completed
                .iter()
                .map(|e| e.node_claim.as_str())
                .collect::<Vec<_>>(),
            vec!["a"]
        );
        assert!(p.failure.as_deref().unwrap().contains("NodeDrainTimeout"));
        // Failed entry retained; c beyond the break is dropped.
        assert!(p.remaining.iter().any(|e| e.node_claim == "b"));
        assert!(!p.remaining.iter().any(|e| e.node_claim == "c"));
    }

    fn kp_status(pool: KarpenterPoolStatus) -> KarpenterNodePoolsStatus {
        KarpenterNodePoolsStatus {
            strategy: "Replace".to_string(),
            active_pool: Some(pool.name.clone()),
            total_nodes: pool.total_nodes,
            replaced_nodes: pool.replaced_nodes,
            pools: vec![pool],
        }
    }

    #[test]
    fn test_replacement_events_new_batch_and_completed() {
        let old = kp_status(KarpenterPoolStatus {
            name: "spot".to_string(),
            status: ComponentStatus::InProgress,
            total_nodes: 2,
            replaced_nodes: 0,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![],
        });
        let mut e = entry("spot-abc", STATE_DRAINING);
        e.node_name = Some("ip-10-0-1-9".to_string());
        let new = kp_status(KarpenterPoolStatus {
            name: "spot".to_string(),
            status: ComponentStatus::InProgress,
            total_nodes: 2,
            replaced_nodes: 1,
            completed_node_claims: vec!["spot-old".to_string()],
            replacements: vec![crate::crd::NodeClaimReplacement {
                old_node_claim: "spot-old".to_string(),
                new_node_claim: Some("spot-new".to_string()),
                node_name: Some("ip-10-0-1-5".to_string()),
            }],
            current_batch: vec![e],
        });
        let events = replacement_events(Some(&old), Some(&new));

        // Replacing event: names pool, ordinal, NodeClaim, node. No () or -> symbols.
        let replacing = events
            .iter()
            .find(|ev| ev.reason == "NodeClaimReplacing")
            .unwrap();
        assert!(replacing.message.contains("NodePool spot"));
        assert!(replacing.message.contains("spot-abc"));
        assert!(replacing.message.contains("ip-10-0-1-9"));
        assert!(replacing.message.contains("node 2 of 2"));
        assert!(!replacing.message.contains("->"));
        assert!(!replacing.message.contains('('));

        // Replaced event: names old and new NodeClaim, ordinal, pool.
        let replaced = events
            .iter()
            .find(|ev| ev.reason == "NodeClaimReplaced")
            .unwrap();
        assert!(replaced.message.contains("NodePool spot"));
        assert!(replaced.message.contains("spot-old"));
        assert!(replaced.message.contains("spot-new"));
        assert!(replaced.message.contains("node 1 of 2"));
        assert!(!replaced.message.contains("->"));
        assert!(!replaced.message.contains('('));
    }

    #[test]
    fn test_replacement_events_no_duplicates_when_unchanged() {
        let pool = KarpenterPoolStatus {
            name: "spot".to_string(),
            status: ComponentStatus::InProgress,
            total_nodes: 1,
            replaced_nodes: 0,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![entry("spot-abc", STATE_DRAINING)],
        };
        let s = kp_status(pool);
        // Same old and new: no new transitions, no events.
        assert!(replacement_events(Some(&s), Some(&s)).is_empty());
    }

    #[test]
    fn test_replacement_events_none_new_status() {
        assert!(replacement_events(None, None).is_empty());
    }

    #[test]
    fn test_replacement_events_brand_new_pool() {
        // old tracks pool "a"; new introduces pool "b" with a starting node.
        let old = kp_status(KarpenterPoolStatus {
            name: "a".to_string(),
            status: ComponentStatus::Completed,
            total_nodes: 1,
            replaced_nodes: 1,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![],
        });
        let new = kp_status(KarpenterPoolStatus {
            name: "b".to_string(),
            status: ComponentStatus::InProgress,
            total_nodes: 2,
            replaced_nodes: 0,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![entry("b-1", STATE_DRAINING)],
        });
        let events = replacement_events(Some(&old), Some(&new));
        assert_eq!(events.len(), 1);
        assert!(events[0].message.contains("NodePool b"));
        assert!(events[0].message.contains("node 1 of 2"));
    }

    #[test]
    fn test_pick_new_nodeclaim_missing_timestamps_falls_back_to_novelty() {
        use crate::k8s::karpenter::NodeClaimInfo;
        let claims = vec![NodeClaimInfo {
            name: "fresh".to_string(),
            node_name: None,
            provider_id: None,
            created_at: None,
        }];
        // No `after` and no created_at: novelty alone selects it.
        assert_eq!(
            pick_new_nodeclaim(&claims, &[], None),
            Some("fresh".to_string())
        );
    }

    #[test]
    fn test_pick_new_nodeclaim() {
        use crate::k8s::karpenter::NodeClaimInfo;
        let claims = vec![
            NodeClaimInfo {
                name: "old-1".to_string(),
                node_name: None,
                provider_id: None,
                created_at: chrono::DateTime::from_timestamp(10, 0),
            },
            NodeClaimInfo {
                name: "new-1".to_string(),
                node_name: None,
                provider_id: None,
                created_at: chrono::DateTime::from_timestamp(100, 0),
            },
        ];
        let known = vec!["old-1".to_string()];
        // Deleted old at t=50; the claim created after (new-1) is the replacement.
        let after = chrono::DateTime::from_timestamp(50, 0);
        assert_eq!(
            pick_new_nodeclaim(&claims, &known, after),
            Some("new-1".to_string())
        );
        // If everything is known, nothing to pick.
        let all_known = vec!["old-1".to_string(), "new-1".to_string()];
        assert_eq!(pick_new_nodeclaim(&claims, &all_known, after), None);
    }

    #[test]
    fn test_recompute_totals() {
        let mut kp = KarpenterNodePoolsStatus {
            strategy: "Replace".to_string(),
            active_pool: None,
            total_nodes: 0,
            replaced_nodes: 0,
            pools: vec![
                KarpenterPoolStatus {
                    name: "a".to_string(),
                    status: ComponentStatus::Completed,
                    total_nodes: 3,
                    replaced_nodes: 3,
                    completed_node_claims: vec![],
                    replacements: vec![],
                    current_batch: vec![],
                },
                KarpenterPoolStatus {
                    name: "b".to_string(),
                    status: ComponentStatus::InProgress,
                    total_nodes: 5,
                    replaced_nodes: 2,
                    completed_node_claims: vec![],
                    replacements: vec![],
                    current_batch: vec![],
                },
            ],
        };
        recompute_totals(&mut kp);
        assert_eq!(kp.total_nodes, 8);
        assert_eq!(kp.replaced_nodes, 5);
    }
}
