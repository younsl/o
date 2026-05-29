//! Node group upgrade phase.
//!
//! Upgrades managed node groups one at a time, polling status between reconciles.

use anyhow::Result;
use chrono::Utc;
use std::time::Duration;
use tracing::{info, warn};

use crate::aws::AwsClients;
use crate::crd::{ComponentStatus, EKSUpgradeSpec, EKSUpgradeStatus, UpgradePhase};
use crate::eks::nodegroup;
use crate::status;

/// Requeue interval for polling in-progress nodegroup upgrades.
pub const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Find the first nodegroup that still needs processing.
fn find_active_nodegroup(status: &EKSUpgradeStatus) -> Option<usize> {
    status.phases.nodegroups.iter().position(|n| {
        n.status != ComponentStatus::Completed && n.status != ComponentStatus::Skipped
    })
}

/// Apply the result of polling a nodegroup update to the status.
fn apply_poll_result(
    new_status: &mut EKSUpgradeStatus,
    idx: usize,
    ng_name: &str,
    poll_result: &str,
) -> Option<Duration> {
    match poll_result {
        "Successful" => {
            info!("Nodegroup {} upgrade completed", ng_name);
            new_status.phases.nodegroups[idx].status = ComponentStatus::Completed;
            new_status.phases.nodegroups[idx].update_id = None;
            new_status.phases.nodegroups[idx].started_at = None;
            new_status.phases.nodegroups[idx].completed_at = Some(Utc::now());
            Some(Duration::from_secs(0))
        }
        "Failed" | "Cancelled" => {
            warn!("Nodegroup {} upgrade failed: {}", ng_name, poll_result);
            new_status.phases.nodegroups[idx].status = ComponentStatus::Failed;
            new_status.phases.nodegroups[idx].update_id = None;
            status::set_failed(
                new_status,
                format!("Nodegroup {ng_name} upgrade failed: {poll_result}"),
            );
            None
        }
        _ => Some(POLL_INTERVAL),
    }
}

/// Apply timeout failure to a nodegroup.
fn apply_timeout(
    new_status: &mut EKSUpgradeStatus,
    idx: usize,
    ng_name: &str,
    elapsed_minutes: i64,
    timeout_minutes: u64,
) {
    warn!(
        "Nodegroup {} timed out after {} minutes (limit: {})",
        ng_name, elapsed_minutes, timeout_minutes
    );
    new_status.phases.nodegroups[idx].status = ComponentStatus::Failed;
    new_status.phases.nodegroups[idx].update_id = None;
    status::set_failed(
        new_status,
        format!(
            "Nodegroup {ng_name} upgrade timed out after {elapsed_minutes} minutes (limit: {timeout_minutes} minutes)"
        ),
    );
}

/// Execute one step of nodegroup upgrades.
///
/// Finds the first pending/in-progress nodegroup and either initiates or polls it.
#[allow(clippy::too_many_lines)]
pub async fn execute(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
    aws: &AwsClients,
) -> Result<(EKSUpgradeStatus, Option<Duration>)> {
    let mut new_status = current_status.clone();

    let Some(idx) = find_active_nodegroup(&new_status) else {
        // All nodegroups done → complete
        info!("All nodegroup upgrades completed for {}", spec.cluster_name);
        status::set_phase(&mut new_status, UpgradePhase::Completed);
        status::set_condition(&mut new_status, "Ready", "True", "UpgradeCompleted", None);
        return Ok((new_status, None));
    };

    let ng_status = &new_status.phases.nodegroups[idx];
    let ng_name = ng_status.name.clone();
    let current_version = ng_status.current_version.clone();
    let target_version = ng_status.target_version.clone();

    let timeout_minutes = spec.timeouts.as_ref().map_or(60, |t| t.nodegroup_minutes);

    match ng_status.status {
        ComponentStatus::Pending => {
            // Initiate upgrade
            info!(
                "Initiating nodegroup upgrade: {} to {}",
                ng_name, target_version
            );
            let update_id = nodegroup::update_nodegroup_version(
                &aws.eks,
                &spec.cluster_name,
                &ng_name,
                &target_version,
            )
            .await?;
            new_status.phases.nodegroups[idx].status = ComponentStatus::InProgress;
            new_status.phases.nodegroups[idx].update_id = Some(update_id);
            new_status.phases.nodegroups[idx].started_at = Some(Utc::now());
            Ok((new_status, Some(POLL_INTERVAL)))
        }
        ComponentStatus::InProgress => {
            // Check timeout
            if let Some(ref ng_started) = current_status.phases.nodegroups[idx].started_at {
                let elapsed = Utc::now().signed_duration_since(ng_started);
                #[allow(clippy::cast_possible_wrap)]
                if elapsed.num_minutes() >= timeout_minutes as i64 {
                    apply_timeout(
                        &mut new_status,
                        idx,
                        &ng_name,
                        elapsed.num_minutes(),
                        timeout_minutes,
                    );
                    return Ok((new_status, None));
                }
            }

            // Poll status using the nodegroup's own update_id
            let update_id = current_status.phases.nodegroups[idx]
                .update_id
                .as_deref()
                .unwrap_or("unknown");

            let status_str =
                nodegroup::poll_nodegroup_update(&aws.eks, &spec.cluster_name, &ng_name, update_id)
                    .await?;

            let requeue = apply_poll_result(&mut new_status, idx, &ng_name, &status_str);

            if requeue.is_some_and(|d| d == POLL_INTERVAL) {
                info!(
                    "Polling nodegroup {} upgrade: {} to {} (status: {})",
                    ng_name, current_version, target_version, status_str
                );
            }

            Ok((new_status, requeue))
        }
        ComponentStatus::Failed => {
            status::set_failed(
                &mut new_status,
                format!("Nodegroup {ng_name} is in failed state"),
            );
            Ok((new_status, None))
        }
        _ => Ok((new_status, Some(Duration::from_secs(0)))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::NodegroupStatus;

    fn make_ng(name: &str, status: ComponentStatus) -> NodegroupStatus {
        NodegroupStatus {
            name: name.to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.33".to_string(),
            status,
            update_id: None,
            started_at: None,
            completed_at: None,
        }
    }

    fn make_status_with_ngs(ngs: Vec<NodegroupStatus>) -> EKSUpgradeStatus {
        let mut s = EKSUpgradeStatus::default();
        s.phases.nodegroups = ngs;
        s
    }

    #[test]
    fn test_poll_interval_constant() {
        assert_eq!(POLL_INTERVAL, Duration::from_secs(30));
    }

    // --- find_active_nodegroup tests ---

    #[test]
    fn test_find_active_none_when_all_completed() {
        let s = make_status_with_ngs(vec![
            make_ng("ng-1", ComponentStatus::Completed),
            make_ng("ng-2", ComponentStatus::Completed),
        ]);
        assert!(find_active_nodegroup(&s).is_none());
    }

    #[test]
    fn test_find_active_none_when_empty() {
        let s = EKSUpgradeStatus::default();
        assert!(find_active_nodegroup(&s).is_none());
    }

    #[test]
    fn test_find_active_returns_first_pending() {
        let s = make_status_with_ngs(vec![
            make_ng("ng-1", ComponentStatus::Completed),
            make_ng("ng-2", ComponentStatus::Pending),
            make_ng("ng-3", ComponentStatus::Pending),
        ]);
        assert_eq!(find_active_nodegroup(&s), Some(1));
    }

    #[test]
    fn test_find_active_returns_in_progress() {
        let s = make_status_with_ngs(vec![
            make_ng("ng-1", ComponentStatus::Completed),
            make_ng("ng-2", ComponentStatus::InProgress),
        ]);
        assert_eq!(find_active_nodegroup(&s), Some(1));
    }

    #[test]
    fn test_find_active_skips_completed_and_skipped() {
        let s = make_status_with_ngs(vec![
            make_ng("ng-1", ComponentStatus::Completed),
            make_ng("ng-2", ComponentStatus::Skipped),
            make_ng("ng-3", ComponentStatus::Failed),
        ]);
        assert_eq!(find_active_nodegroup(&s), Some(2));
    }

    // --- apply_poll_result tests ---

    #[test]
    fn test_apply_poll_result_successful() {
        let mut s = make_status_with_ngs(vec![make_ng("ng-1", ComponentStatus::InProgress)]);
        s.phases.nodegroups[0].update_id = Some("upd-1".to_string());
        let requeue = apply_poll_result(&mut s, 0, "ng-1", "Successful");
        assert_eq!(requeue, Some(Duration::from_secs(0)));
        assert_eq!(s.phases.nodegroups[0].status, ComponentStatus::Completed);
        assert!(s.phases.nodegroups[0].update_id.is_none());
        assert!(s.phases.nodegroups[0].completed_at.is_some());
    }

    #[test]
    fn test_apply_poll_result_failed() {
        let mut s = make_status_with_ngs(vec![make_ng("ng-1", ComponentStatus::InProgress)]);
        let requeue = apply_poll_result(&mut s, 0, "ng-1", "Failed");
        assert!(requeue.is_none());
        assert_eq!(s.phases.nodegroups[0].status, ComponentStatus::Failed);
        assert_eq!(s.phase, Some(UpgradePhase::Failed));
    }

    #[test]
    fn test_apply_poll_result_cancelled() {
        let mut s = make_status_with_ngs(vec![make_ng("ng-1", ComponentStatus::InProgress)]);
        let requeue = apply_poll_result(&mut s, 0, "ng-1", "Cancelled");
        assert!(requeue.is_none());
        assert_eq!(s.phases.nodegroups[0].status, ComponentStatus::Failed);
    }

    #[test]
    fn test_apply_poll_result_in_progress() {
        let mut s = make_status_with_ngs(vec![make_ng("ng-1", ComponentStatus::InProgress)]);
        let requeue = apply_poll_result(&mut s, 0, "ng-1", "InProgress");
        assert_eq!(requeue, Some(POLL_INTERVAL));
        assert_eq!(s.phases.nodegroups[0].status, ComponentStatus::InProgress);
    }

    // --- execute early-return path tests ---

    fn make_spec() -> EKSUpgradeSpec {
        EKSUpgradeSpec {
            cluster_name: "test-cluster".to_string(),
            target_version: "1.33".to_string(),
            region: "us-east-1".to_string(),
            assume_role_arn: None,
            addon_versions: None,
            skip_pdb_check: false,
            dry_run: false,
            timeouts: None,
            notification: None,
        }
    }

    #[tokio::test]
    async fn test_execute_all_nodegroups_completed() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let status = make_status_with_ngs(vec![
            make_ng("ng-1", ComponentStatus::Completed),
            make_ng("ng-2", ComponentStatus::Completed),
        ]);
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Completed));
    }

    #[tokio::test]
    async fn test_execute_empty_nodegroups() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let status = EKSUpgradeStatus::default();
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Completed));
    }

    #[tokio::test]
    async fn test_execute_failed_nodegroup() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let status = make_status_with_ngs(vec![make_ng("ng-1", ComponentStatus::Failed)]);
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Failed));
    }

    #[tokio::test]
    async fn test_execute_skipped_then_pending_skips_correctly() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let status = make_status_with_ngs(vec![
            make_ng("ng-1", ComponentStatus::Skipped),
            make_ng("ng-2", ComponentStatus::Completed),
        ]);
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Completed));
    }

    #[tokio::test]
    async fn test_execute_timeout_triggers_failure() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let two_hours_ago = Utc::now() - chrono::Duration::hours(2);
        let mut ngs = vec![make_ng("ng-1", ComponentStatus::InProgress)];
        ngs[0].update_id = Some("upd-1".to_string());
        ngs[0].started_at = Some(two_hours_ago);
        let status = make_status_with_ngs(ngs);
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Failed));
        assert!(new_status.message.as_ref().unwrap().contains("timed out"));
    }

    // --- apply_timeout tests ---

    #[test]
    fn test_apply_timeout_sets_failed() {
        let mut s = make_status_with_ngs(vec![make_ng("ng-1", ComponentStatus::InProgress)]);
        s.phases.nodegroups[0].update_id = Some("upd-1".to_string());
        apply_timeout(&mut s, 0, "ng-1", 65, 60);
        assert_eq!(s.phases.nodegroups[0].status, ComponentStatus::Failed);
        assert!(s.phases.nodegroups[0].update_id.is_none());
        assert_eq!(s.phase, Some(UpgradePhase::Failed));
        assert!(s.message.as_ref().unwrap().contains("timed out"));
        assert!(s.message.as_ref().unwrap().contains("65 minutes"));
    }
}
