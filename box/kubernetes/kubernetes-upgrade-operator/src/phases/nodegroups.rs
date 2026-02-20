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

/// Execute one step of nodegroup upgrades.
///
/// Finds the first pending/in-progress nodegroup and either initiates or polls it.
pub async fn execute(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
    aws: &AwsClients,
) -> Result<(EKSUpgradeStatus, Option<Duration>)> {
    let mut new_status = current_status.clone();

    // Find first non-completed nodegroup
    let active_idx = new_status.phases.nodegroups.iter().position(|n| {
        n.status != ComponentStatus::Completed && n.status != ComponentStatus::Skipped
    });

    let Some(idx) = active_idx else {
        // All nodegroups done → complete
        info!("All nodegroup upgrades completed for {}", spec.cluster_name);
        status::set_phase(&mut new_status, UpgradePhase::Completed);
        status::set_condition(&mut new_status, "Ready", "True", "UpgradeCompleted", None);
        return Ok((new_status, None));
    };

    let ng_status = &new_status.phases.nodegroups[idx];
    let ng_name = ng_status.name.clone();
    let target_version = ng_status.target_version.clone();

    let timeout_minutes = spec
        .timeouts
        .as_ref()
        .map(|t| t.nodegroup_minutes)
        .unwrap_or(60);

    match ng_status.status {
        ComponentStatus::Pending => {
            // Initiate upgrade
            info!(
                "Initiating nodegroup upgrade: {} -> {}",
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
                if elapsed.num_minutes() >= timeout_minutes as i64 {
                    warn!(
                        "Nodegroup {} timed out after {} minutes (limit: {}) for {}",
                        ng_name,
                        elapsed.num_minutes(),
                        timeout_minutes,
                        spec.cluster_name
                    );
                    new_status.phases.nodegroups[idx].status = ComponentStatus::Failed;
                    new_status.phases.nodegroups[idx].update_id = None;
                    status::set_failed(
                        &mut new_status,
                        format!(
                            "Nodegroup {} upgrade timed out after {} minutes (limit: {} minutes)",
                            ng_name,
                            elapsed.num_minutes(),
                            timeout_minutes
                        ),
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

            match status_str.as_str() {
                "Successful" => {
                    info!("Nodegroup {} upgrade completed", ng_name);
                    new_status.phases.nodegroups[idx].status = ComponentStatus::Completed;
                    new_status.phases.nodegroups[idx].update_id = None;
                    new_status.phases.nodegroups[idx].started_at = None;
                    new_status.phases.nodegroups[idx].completed_at = Some(Utc::now());
                    // Requeue immediately to process next nodegroup
                    Ok((new_status, Some(Duration::from_secs(0))))
                }
                "Failed" | "Cancelled" => {
                    warn!("Nodegroup {} upgrade failed: {}", ng_name, status_str);
                    new_status.phases.nodegroups[idx].status = ComponentStatus::Failed;
                    new_status.phases.nodegroups[idx].update_id = None;
                    status::set_failed(
                        &mut new_status,
                        format!("Nodegroup {} upgrade failed: {}", ng_name, status_str),
                    );
                    Ok((new_status, None))
                }
                _ => {
                    // Still in progress
                    Ok((new_status, Some(POLL_INTERVAL)))
                }
            }
        }
        ComponentStatus::Failed => {
            status::set_failed(
                &mut new_status,
                format!("Nodegroup {} is in failed state", ng_name),
            );
            Ok((new_status, None))
        }
        _ => Ok((new_status, Some(Duration::from_secs(0)))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_poll_interval_constant() {
        assert_eq!(POLL_INTERVAL, Duration::from_secs(30));
    }
}
