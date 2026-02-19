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
        .expect("control_plane status must be set before this phase");
    let upgrade_path = current_status
        .phases
        .planning
        .as_ref()
        .map(|p| &p.upgrade_path[..])
        .unwrap_or(&[]);

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

    let timeout_minutes = spec
        .timeouts
        .as_ref()
        .map(|t| t.control_plane_minutes)
        .unwrap_or(30);

    // Check if we have an in-progress update (crash recovery)
    if let Some(ref update_id) = cp.update_id {
        // Check timeout
        if let Some(ref step_started) = cp.started_at {
            let elapsed = Utc::now().signed_duration_since(step_started);
            if elapsed.num_minutes() >= timeout_minutes as i64 {
                warn!(
                    "CP step {}/{} timed out after {} minutes (limit: {}) for {}",
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
            "Checking existing CP update {} for {}",
            update_id, spec.cluster_name
        );

        let status_str = eks_client
            .check_update_status(&spec.cluster_name, update_id)
            .await?;

        match status_str.as_str() {
            "Successful" => {
                info!(
                    "CP step {}/{} completed: -> {}",
                    step, total, target_version
                );
                let next_step = step + 1;
                {
                    let cp = new_status.phases.control_plane.as_mut().unwrap();
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
                    "CP update {} for {} failed: {}",
                    update_id, spec.cluster_name, status_str
                );
                if let Some(cp) = new_status.phases.control_plane.as_mut() {
                    cp.update_id = None;
                }
                status::set_failed(
                    &mut new_status,
                    format!(
                        "Control plane upgrade to {} failed (update: {})",
                        target_version, update_id
                    ),
                );
                return Ok((new_status, None));
            }
            _ => {
                // Still in progress → requeue
                return Ok((new_status, Some(POLL_INTERVAL)));
            }
        }
    }

    // No active update → initiate next step
    info!(
        "Initiating CP step {}/{}: -> {} for {}",
        step, total, target_version, spec.cluster_name
    );

    let update_id = eks_client
        .update_cluster_version(&spec.cluster_name, target_version)
        .await?;

    let cp_mut = new_status.phases.control_plane.as_mut().unwrap();
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
