//! Add-on upgrade phase.
//!
//! Upgrades add-ons one at a time, polling status between reconciles.

use anyhow::Result;
use chrono::Utc;
use std::time::Duration;
use tracing::{info, warn};

use crate::aws::AwsClients;
use crate::crd::{ComponentStatus, EKSUpgradeSpec, EKSUpgradeStatus, UpgradePhase};
use crate::eks::addon;
use crate::status;

/// Requeue interval for polling in-progress addon upgrades.
pub const POLL_INTERVAL: Duration = Duration::from_secs(15);

/// Apply the result of polling an addon update to the status.
fn apply_addon_poll_result(
    new_status: &mut EKSUpgradeStatus,
    idx: usize,
    addon_name: &str,
    poll_result: &str,
) -> Option<Duration> {
    match poll_result {
        "ACTIVE" => {
            info!("Addon {} upgrade completed", addon_name);
            new_status.phases.addons[idx].status = ComponentStatus::Completed;
            new_status.phases.addons[idx].completed_at = Some(Utc::now());
            Some(Duration::from_secs(0))
        }
        "CREATE_FAILED" | "UPDATE_FAILED" | "DELETE_FAILED" | "DEGRADED" => {
            warn!("Addon {} upgrade failed: {}", addon_name, poll_result);
            new_status.phases.addons[idx].status = ComponentStatus::Failed;
            new_status.phases.addons[idx].completed_at = Some(Utc::now());
            status::set_failed(
                new_status,
                format!("Addon {addon_name} upgrade failed: {poll_result}"),
            );
            None
        }
        _ => Some(POLL_INTERVAL),
    }
}

/// Execute one step of addon upgrades.
///
/// Finds the first pending/in-progress addon and either initiates or polls it.
pub async fn execute(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
    aws: &AwsClients,
) -> Result<(EKSUpgradeStatus, Option<Duration>)> {
    let mut new_status = current_status.clone();

    // Find first non-completed addon
    let active_idx = new_status.phases.addons.iter().position(|a| {
        a.status != ComponentStatus::Completed && a.status != ComponentStatus::Skipped
    });

    let Some(idx) = active_idx else {
        // All addons done → advance to next phase
        info!("All addon upgrades completed for {}", spec.cluster_name);
        advance_to_next_phase(&mut new_status);
        return Ok((new_status, None));
    };

    let addon_status = &new_status.phases.addons[idx];
    let addon_name = addon_status.name.clone();
    let current_version = addon_status.current_version.clone();
    let target_version = addon_status.target_version.clone();

    match addon_status.status {
        ComponentStatus::Pending => {
            // Initiate upgrade
            info!(
                "Initiating addon upgrade: {} {} to {}",
                addon_name, current_version, target_version
            );
            addon::update_addon(&aws.eks, &spec.cluster_name, &addon_name, &target_version).await?;
            new_status.phases.addons[idx].status = ComponentStatus::InProgress;
            new_status.phases.addons[idx].started_at = Some(Utc::now());
            Ok((new_status, Some(POLL_INTERVAL)))
        }
        ComponentStatus::InProgress => {
            // Poll status
            let status_str =
                addon::poll_addon_status(&aws.eks, &spec.cluster_name, &addon_name).await?;

            let requeue = apply_addon_poll_result(&mut new_status, idx, &addon_name, &status_str);

            if requeue.is_some_and(|d| d == POLL_INTERVAL) {
                info!(
                    "Polling addon {} upgrade: {} to {} (status: {})",
                    addon_name, current_version, target_version, status_str
                );
            }

            Ok((new_status, requeue))
        }
        ComponentStatus::Failed => {
            // Already failed → mark overall as failed
            status::set_failed(
                &mut new_status,
                format!("Addon {addon_name} is in failed state"),
            );
            Ok((new_status, None))
        }
        _ => {
            // Completed/Skipped should not reach here due to position() filter
            Ok((new_status, Some(Duration::from_secs(0))))
        }
    }
}

/// Advance from addons phase to the next applicable phase.
fn advance_to_next_phase(new_status: &mut EKSUpgradeStatus) {
    if new_status.phases.nodegroups.is_empty() {
        status::set_phase(new_status, UpgradePhase::Completed);
        status::set_condition(new_status, "Ready", "True", "UpgradeCompleted", None);
    } else {
        status::set_phase(new_status, UpgradePhase::UpgradingNodeGroups);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{EKSUpgradeStatus, NodegroupStatus};

    #[test]
    fn test_advance_with_nodegroups() {
        let mut s = EKSUpgradeStatus::default();
        s.phases.nodegroups.push(NodegroupStatus {
            name: "ng-system".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.33".to_string(),
            status: ComponentStatus::Pending,
            update_id: None,
            started_at: None,
            completed_at: None,
        });
        advance_to_next_phase(&mut s);
        assert_eq!(s.phase, Some(UpgradePhase::UpgradingNodeGroups));
    }

    #[test]
    fn test_advance_no_nodegroups() {
        let mut s = EKSUpgradeStatus::default();
        advance_to_next_phase(&mut s);
        assert_eq!(s.phase, Some(UpgradePhase::Completed));
        let ready = s.conditions.iter().find(|c| c.r#type == "Ready").unwrap();
        assert_eq!(ready.status, "True");
        assert_eq!(ready.reason, "UpgradeCompleted");
    }

    #[test]
    fn test_poll_interval_constant() {
        assert_eq!(POLL_INTERVAL, Duration::from_secs(15));
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
    async fn test_execute_all_addons_completed() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let mut status = EKSUpgradeStatus::default();
        status.phases.addons = vec![
            make_addon("coredns", ComponentStatus::Completed),
            make_addon("vpc-cni", ComponentStatus::Completed),
        ];
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Completed));
    }

    #[tokio::test]
    async fn test_execute_all_addons_completed_with_nodegroups() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let mut status = EKSUpgradeStatus::default();
        status.phases.addons = vec![make_addon("coredns", ComponentStatus::Completed)];
        status.phases.nodegroups.push(NodegroupStatus {
            name: "ng-system".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.33".to_string(),
            status: ComponentStatus::Pending,
            update_id: None,
            started_at: None,
            completed_at: None,
        });
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::UpgradingNodeGroups));
    }

    #[tokio::test]
    async fn test_execute_failed_addon() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let mut status = EKSUpgradeStatus::default();
        status.phases.addons = vec![make_addon("coredns", ComponentStatus::Failed)];
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Failed));
    }

    #[tokio::test]
    async fn test_execute_empty_addons() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let status = EKSUpgradeStatus::default();
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Completed));
    }

    // --- apply_addon_poll_result tests ---

    fn make_addon(name: &str, status: ComponentStatus) -> crate::crd::AddonStatus {
        crate::crd::AddonStatus {
            name: name.to_string(),
            current_version: "v1.11.1-eksbuild.1".to_string(),
            target_version: "v1.11.3-eksbuild.2".to_string(),
            status,
            started_at: None,
            completed_at: None,
        }
    }

    fn make_status_with_addons(addons: Vec<crate::crd::AddonStatus>) -> EKSUpgradeStatus {
        let mut s = EKSUpgradeStatus::default();
        s.phases.addons = addons;
        s
    }

    #[test]
    fn test_addon_poll_result_active() {
        let mut s =
            make_status_with_addons(vec![make_addon("coredns", ComponentStatus::InProgress)]);
        let requeue = apply_addon_poll_result(&mut s, 0, "coredns", "ACTIVE");
        assert_eq!(requeue, Some(Duration::from_secs(0)));
        assert_eq!(s.phases.addons[0].status, ComponentStatus::Completed);
        assert!(s.phases.addons[0].completed_at.is_some());
    }

    #[test]
    fn test_addon_poll_result_create_failed() {
        let mut s =
            make_status_with_addons(vec![make_addon("coredns", ComponentStatus::InProgress)]);
        let requeue = apply_addon_poll_result(&mut s, 0, "coredns", "CREATE_FAILED");
        assert!(requeue.is_none());
        assert_eq!(s.phases.addons[0].status, ComponentStatus::Failed);
        assert_eq!(s.phase, Some(UpgradePhase::Failed));
    }

    #[test]
    fn test_addon_poll_result_update_failed() {
        let mut s =
            make_status_with_addons(vec![make_addon("vpc-cni", ComponentStatus::InProgress)]);
        let requeue = apply_addon_poll_result(&mut s, 0, "vpc-cni", "UPDATE_FAILED");
        assert!(requeue.is_none());
        assert_eq!(s.phases.addons[0].status, ComponentStatus::Failed);
    }

    #[test]
    fn test_addon_poll_result_degraded() {
        let mut s =
            make_status_with_addons(vec![make_addon("coredns", ComponentStatus::InProgress)]);
        let requeue = apply_addon_poll_result(&mut s, 0, "coredns", "DEGRADED");
        assert!(requeue.is_none());
        assert_eq!(s.phases.addons[0].status, ComponentStatus::Failed);
    }

    #[test]
    fn test_addon_poll_result_delete_failed() {
        let mut s =
            make_status_with_addons(vec![make_addon("coredns", ComponentStatus::InProgress)]);
        let requeue = apply_addon_poll_result(&mut s, 0, "coredns", "DELETE_FAILED");
        assert!(requeue.is_none());
        assert_eq!(s.phases.addons[0].status, ComponentStatus::Failed);
    }

    #[test]
    fn test_addon_poll_result_updating() {
        let mut s =
            make_status_with_addons(vec![make_addon("coredns", ComponentStatus::InProgress)]);
        let requeue = apply_addon_poll_result(&mut s, 0, "coredns", "UPDATING");
        assert_eq!(requeue, Some(POLL_INTERVAL));
        assert_eq!(s.phases.addons[0].status, ComponentStatus::InProgress);
    }

    #[test]
    fn test_addon_poll_result_creating() {
        let mut s =
            make_status_with_addons(vec![make_addon("coredns", ComponentStatus::InProgress)]);
        let requeue = apply_addon_poll_result(&mut s, 0, "coredns", "CREATING");
        assert_eq!(requeue, Some(POLL_INTERVAL));
    }
}
