//! Control plane upgrade phase.
//!
//! Handles sequential minor version upgrades (one step per reconcile).
//! Uses activeUpdateId for crash recovery.

use anyhow::Result;
use chrono::Utc;
use std::time::Duration;
use tracing::{info, warn};

use crate::aws::AwsClients;
use crate::crd::{EKSUpgradeSpec, EKSUpgradeStatus, UpgradePhase};
use crate::eks::client::EksClient;
use crate::status;

/// Requeue interval for polling in-progress control plane upgrades.
pub const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// Process the result of polling a control plane update.
///
/// Returns the requeue duration: `None` for terminal states, `Some(d)` to continue.
fn process_update_result(
    new_status: &mut EKSUpgradeStatus,
    status_str: &str,
    step: u32,
    total: u32,
    target_version: &str,
) -> Result<Option<Duration>> {
    match status_str {
        "Successful" => {
            let next_step = step + 1;
            {
                let cp = new_status.phases.control_plane.as_mut().ok_or_else(|| {
                    anyhow::anyhow!("control_plane status missing during upgrade")
                })?;
                cp.current_step = next_step;
                cp.update_id = None;
                cp.target = None;
                cp.started_at = None;
            }
            new_status.current_version = Some(target_version.to_string());

            if next_step > total {
                advance_to_next_phase(new_status);
                Ok(None)
            } else {
                Ok(Some(Duration::from_secs(0)))
            }
        }
        "Failed" | "Cancelled" => {
            if let Some(cp) = new_status.phases.control_plane.as_mut() {
                cp.update_id = None;
            }
            status::set_failed(
                new_status,
                format!("Control plane upgrade to {target_version} failed"),
            );
            Ok(None)
        }
        _ => Ok(Some(POLL_INTERVAL)),
    }
}

/// Apply a timeout failure to the control plane upgrade.
fn apply_cp_timeout(
    new_status: &mut EKSUpgradeStatus,
    target_version: &str,
    elapsed_minutes: i64,
    timeout_minutes: u64,
    update_id: &str,
) {
    warn!(
        "Control plane upgrade to {} timed out after {} minutes (limit: {}, update: {})",
        target_version, elapsed_minutes, timeout_minutes, update_id
    );
    if let Some(cp) = new_status.phases.control_plane.as_mut() {
        cp.update_id = None;
    }
    status::set_failed(
        new_status,
        format!(
            "Control plane upgrade to {target_version} timed out after {elapsed_minutes} minutes (limit: {timeout_minutes} minutes, update: {update_id})"
        ),
    );
}

/// Execute one step of the control plane upgrade.
///
/// Returns the updated status and an optional requeue duration.
/// - If an upgrade is in progress, returns a requeue to poll later.
/// - If a step completes, advances to the next step or next phase.
#[allow(clippy::too_many_lines)]
pub async fn execute(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
    aws: &AwsClients,
) -> Result<(EKSUpgradeStatus, Option<Duration>)> {
    let eks_client = EksClient::new(aws.eks.clone(), aws.region.clone());

    let mut new_status = current_status.clone();

    let cp = current_status
        .phases
        .control_plane
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("control_plane status must be set before this phase"))?;
    let upgrade_path: &[String] = current_status
        .phases
        .planning
        .as_ref()
        .map_or(&[], |p| &p.upgrade_path);

    let step = cp.current_step; // 1-based
    let total = cp.total_steps;

    // All steps done → advance to next phase
    if step > total {
        info!("Control plane upgrade completed for {}", spec.cluster_name);
        advance_to_next_phase(&mut new_status);
        return Ok((new_status, None));
    }

    let path_index = (step - 1) as usize;
    let target_version = &upgrade_path[path_index];
    if path_index == 0 && current_status.current_version.is_none() {
        warn!("current_version is not set in status, using 'unknown' as from_version");
    }
    let from_version = if path_index == 0 {
        current_status
            .current_version
            .as_deref()
            .unwrap_or("unknown")
    } else {
        &upgrade_path[path_index - 1]
    };

    let timeout_minutes = spec
        .timeouts
        .as_ref()
        .map_or(30, |t| t.control_plane_minutes);

    // Check if we have an in-progress update (crash recovery)
    if let Some(ref update_id) = cp.update_id {
        // Check timeout
        if let Some(ref step_started) = cp.started_at {
            let elapsed = Utc::now().signed_duration_since(step_started);
            #[allow(clippy::cast_possible_wrap)]
            if elapsed.num_minutes() >= timeout_minutes as i64 {
                apply_cp_timeout(
                    &mut new_status,
                    target_version,
                    elapsed.num_minutes(),
                    timeout_minutes,
                    update_id,
                );
                return Ok((new_status, None));
            }
        }

        info!(
            "Checking existing control plane update {} for {}",
            update_id, spec.cluster_name
        );

        let status_str = eks_client
            .check_update_status(&spec.cluster_name, update_id)
            .await?;

        let requeue =
            process_update_result(&mut new_status, &status_str, step, total, target_version)?;
        return Ok((new_status, requeue));
    }

    // No active update → initiate next step
    info!(
        "Initiating control plane step {}/{}: {} to {} for {}",
        step, total, from_version, target_version, spec.cluster_name
    );

    let update_id = eks_client
        .update_cluster_version(&spec.cluster_name, target_version)
        .await?;

    let cp_mut = new_status
        .phases
        .control_plane
        .as_mut()
        .ok_or_else(|| anyhow::anyhow!("control_plane status missing during upgrade"))?;
    cp_mut.target = Some(target_version.clone());
    cp_mut.update_id = Some(update_id);
    cp_mut.started_at = Some(Utc::now());

    // Requeue to poll
    Ok((new_status, Some(POLL_INTERVAL)))
}

/// Advance from control plane phase to the next applicable phase.
fn advance_to_next_phase(new_status: &mut EKSUpgradeStatus) {
    if let Some(cp) = new_status.phases.control_plane.as_mut() {
        cp.update_id = None;
        cp.target = None;
        cp.started_at = None;
        cp.completed_at = Some(Utc::now());
    }
    if !new_status.phases.addons.is_empty() {
        status::set_phase(new_status, UpgradePhase::UpgradingAddons);
    } else if !new_status.phases.nodegroups.is_empty() {
        status::set_phase(new_status, UpgradePhase::UpgradingNodeGroups);
    } else {
        status::set_phase(new_status, UpgradePhase::Completed);
        status::set_condition(new_status, "Ready", "True", "UpgradeCompleted", None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{
        AddonStatus, ComponentStatus, ControlPlaneStatus, EKSUpgradeStatus, NodegroupStatus,
    };

    fn status_with_cp() -> EKSUpgradeStatus {
        let mut s = EKSUpgradeStatus::default();
        s.phases.control_plane = Some(ControlPlaneStatus {
            update_id: Some("upd-123".to_string()),
            target: Some("1.33".to_string()),
            started_at: Some(Utc::now()),
            ..Default::default()
        });
        s
    }

    #[test]
    fn test_advance_with_addons() {
        let mut s = status_with_cp();
        s.phases.addons.push(AddonStatus {
            name: "coredns".to_string(),
            current_version: "v1.11.1".to_string(),
            target_version: "v1.11.3".to_string(),
            status: ComponentStatus::Pending,
            started_at: None,
            completed_at: None,
        });
        advance_to_next_phase(&mut s);
        assert_eq!(s.phase, Some(UpgradePhase::UpgradingAddons));
        assert!(
            s.phases
                .control_plane
                .as_ref()
                .unwrap()
                .completed_at
                .is_some()
        );
    }

    #[test]
    fn test_advance_with_nodegroups_only() {
        let mut s = status_with_cp();
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
    fn test_advance_no_remaining() {
        let mut s = status_with_cp();
        advance_to_next_phase(&mut s);
        assert_eq!(s.phase, Some(UpgradePhase::Completed));
        let ready = s.conditions.iter().find(|c| c.r#type == "Ready").unwrap();
        assert_eq!(ready.status, "True");
        assert_eq!(ready.reason, "UpgradeCompleted");
    }

    #[test]
    fn test_advance_clears_cp_fields() {
        let mut s = status_with_cp();
        assert!(s.phases.control_plane.as_ref().unwrap().update_id.is_some());
        advance_to_next_phase(&mut s);
        let cp = s.phases.control_plane.as_ref().unwrap();
        assert!(cp.update_id.is_none());
        assert!(cp.target.is_none());
        assert!(cp.started_at.is_none());
        assert!(cp.completed_at.is_some());
    }

    #[test]
    fn test_poll_interval_constant() {
        assert_eq!(POLL_INTERVAL, Duration::from_secs(30));
    }

    // --- process_update_result tests ---

    fn status_with_cp_step(step: u32, total: u32) -> EKSUpgradeStatus {
        let mut s = EKSUpgradeStatus::default();
        s.phases.control_plane = Some(ControlPlaneStatus {
            current_step: step,
            total_steps: total,
            update_id: Some("upd-1".to_string()),
            target: Some("1.33".to_string()),
            started_at: Some(Utc::now()),
            completed_at: None,
        });
        s
    }

    #[test]
    fn test_process_update_result_successful_more_steps() {
        let mut s = status_with_cp_step(1, 3);
        let requeue = process_update_result(&mut s, "Successful", 1, 3, "1.32").unwrap();
        assert_eq!(requeue, Some(Duration::from_secs(0)));
        let cp = s.phases.control_plane.as_ref().unwrap();
        assert_eq!(cp.current_step, 2);
        assert!(cp.update_id.is_none());
        assert!(cp.target.is_none());
        assert!(cp.started_at.is_none());
        assert_eq!(s.current_version.as_deref(), Some("1.32"));
    }

    #[test]
    fn test_process_update_result_successful_last_step() {
        let mut s = status_with_cp_step(2, 2);
        let requeue = process_update_result(&mut s, "Successful", 2, 2, "1.33").unwrap();
        assert!(requeue.is_none());
        assert_eq!(s.current_version.as_deref(), Some("1.33"));
        // advance_to_next_phase was called (Completed since no addons/nodegroups)
        assert_eq!(s.phase, Some(UpgradePhase::Completed));
    }

    #[test]
    fn test_process_update_result_failed() {
        let mut s = status_with_cp_step(1, 2);
        let requeue = process_update_result(&mut s, "Failed", 1, 2, "1.33").unwrap();
        assert!(requeue.is_none());
        assert_eq!(s.phase, Some(UpgradePhase::Failed));
        assert!(s.message.as_ref().unwrap().contains("1.33"));
    }

    #[test]
    fn test_process_update_result_cancelled() {
        let mut s = status_with_cp_step(1, 2);
        let requeue = process_update_result(&mut s, "Cancelled", 1, 2, "1.33").unwrap();
        assert!(requeue.is_none());
        assert_eq!(s.phase, Some(UpgradePhase::Failed));
        let cp = s.phases.control_plane.as_ref().unwrap();
        assert!(cp.update_id.is_none());
    }

    #[test]
    fn test_process_update_result_in_progress() {
        let mut s = status_with_cp_step(1, 2);
        let requeue = process_update_result(&mut s, "InProgress", 1, 2, "1.33").unwrap();
        assert_eq!(requeue, Some(POLL_INTERVAL));
        // Status unchanged
        assert!(s.phase.is_none());
    }

    // --- apply_cp_timeout tests ---

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
    async fn test_execute_all_steps_done() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let mut status = EKSUpgradeStatus::default();
        status.phases.planning = Some(crate::crd::PlanningStatus {
            upgrade_path: vec!["1.33".to_string()],
        });
        status.phases.control_plane = Some(ControlPlaneStatus {
            current_step: 2, // > total_steps
            total_steps: 1,
            update_id: None,
            target: None,
            started_at: None,
            completed_at: None,
        });
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Completed));
    }

    #[tokio::test]
    async fn test_execute_missing_cp_status() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let status = EKSUpgradeStatus::default();
        // No control_plane in phases → should error
        let result = execute(&spec, &status, &aws).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_execute_timeout_with_active_update() {
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let mut status = EKSUpgradeStatus::default();
        status.phases.planning = Some(crate::crd::PlanningStatus {
            upgrade_path: vec!["1.33".to_string()],
        });
        // Set started_at to 2 hours ago to trigger timeout
        let two_hours_ago = Utc::now() - chrono::Duration::hours(2);
        status.phases.control_plane = Some(ControlPlaneStatus {
            current_step: 1,
            total_steps: 1,
            update_id: Some("upd-old".to_string()),
            target: Some("1.33".to_string()),
            started_at: Some(two_hours_ago),
            completed_at: None,
        });
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Failed));
        assert!(new_status.message.as_ref().unwrap().contains("timed out"));
    }

    #[tokio::test]
    async fn test_execute_multi_step_timeout() {
        // Tests from_version with path_index > 0 (second step of multi-step upgrade)
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let two_hours_ago = Utc::now() - chrono::Duration::hours(2);
        let mut status = EKSUpgradeStatus::default();
        status.current_version = Some("1.31".to_string());
        status.phases.planning = Some(crate::crd::PlanningStatus {
            upgrade_path: vec!["1.32".to_string(), "1.33".to_string()],
        });
        status.phases.control_plane = Some(ControlPlaneStatus {
            current_step: 2,
            total_steps: 2,
            update_id: Some("upd-2".to_string()),
            target: Some("1.33".to_string()),
            started_at: Some(two_hours_ago),
            completed_at: None,
        });
        let (new_status, requeue) = execute(&spec, &status, &aws).await.unwrap();
        assert!(requeue.is_none());
        assert_eq!(new_status.phase, Some(UpgradePhase::Failed));
    }

    #[tokio::test]
    async fn test_execute_current_version_none_warning() {
        // Tests from_version with path_index == 0 and current_version None
        let aws = crate::aws::AwsClients::test_instance("us-east-1").await;
        let spec = make_spec();
        let two_hours_ago = Utc::now() - chrono::Duration::hours(2);
        let mut status = EKSUpgradeStatus::default();
        // No current_version set
        status.phases.planning = Some(crate::crd::PlanningStatus {
            upgrade_path: vec!["1.33".to_string()],
        });
        status.phases.control_plane = Some(ControlPlaneStatus {
            current_step: 1,
            total_steps: 1,
            update_id: Some("upd-1".to_string()),
            target: Some("1.33".to_string()),
            started_at: Some(two_hours_ago),
            completed_at: None,
        });
        let (new_status, _) = execute(&spec, &status, &aws).await.unwrap();
        assert_eq!(new_status.phase, Some(UpgradePhase::Failed));
    }

    #[test]
    fn test_apply_cp_timeout() {
        let mut s = status_with_cp_step(1, 2);
        apply_cp_timeout(&mut s, "1.33", 35, 30, "upd-1");
        assert_eq!(s.phase, Some(UpgradePhase::Failed));
        let msg = s.message.as_ref().unwrap();
        assert!(msg.contains("timed out"));
        assert!(msg.contains("35 minutes"));
        assert!(msg.contains("limit: 30 minutes"));
        assert!(msg.contains("upd-1"));
        let cp = s.phases.control_plane.as_ref().unwrap();
        assert!(cp.update_id.is_none());
    }
}
