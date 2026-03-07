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
                warn!(
                    "Control plane step {}/{} timed out after {} minutes (limit: {}) for {}",
                    step,
                    total,
                    elapsed.num_minutes(),
                    timeout_minutes,
                    spec.cluster_name
                );
                if let Some(cp) = new_status.phases.control_plane.as_mut() {
                    cp.update_id = None;
                }
                status::set_failed(
                    &mut new_status,
                    format!(
                        "Control plane upgrade to {} timed out after {} minutes (limit: {} minutes, update: {})",
                        target_version,
                        elapsed.num_minutes(),
                        timeout_minutes,
                        update_id
                    ),
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

        match status_str.as_str() {
            "Successful" => {
                info!(
                    "Control plane step {}/{} completed: {} to {}",
                    step, total, from_version, target_version
                );
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
                new_status.current_version = Some(target_version.clone());

                // Check if all steps done
                if next_step > total {
                    advance_to_next_phase(&mut new_status);
                    return Ok((new_status, None));
                }

                // More steps → requeue immediately
                return Ok((new_status, Some(Duration::from_secs(0))));
            }
            "Failed" | "Cancelled" => {
                warn!(
                    "Control plane update {} for {} failed: {}",
                    update_id, spec.cluster_name, status_str
                );
                if let Some(cp) = new_status.phases.control_plane.as_mut() {
                    cp.update_id = None;
                }
                status::set_failed(
                    &mut new_status,
                    format!(
                        "Control plane upgrade to {target_version} failed (update: {update_id})"
                    ),
                );
                return Ok((new_status, None));
            }
            _ => {
                // Still in progress → requeue
                info!(
                    "Polling control plane step {}/{}: {} to {} (status: {})",
                    step, total, from_version, target_version, status_str
                );
                return Ok((new_status, Some(POLL_INTERVAL)));
            }
        }
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
}
