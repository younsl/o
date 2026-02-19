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
    let target_version = addon_status.target_version.clone();

    match addon_status.status {
        ComponentStatus::Pending => {
            // Initiate upgrade
            info!(
                "Initiating addon upgrade: {} -> {}",
                addon_name, target_version
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

            match status_str.as_str() {
                "ACTIVE" => {
                    info!("Addon {} upgrade completed", addon_name);
                    new_status.phases.addons[idx].status = ComponentStatus::Completed;
                    new_status.phases.addons[idx].completed_at = Some(Utc::now());
                    // Requeue immediately to process next addon
                    Ok((new_status, Some(Duration::from_secs(0))))
                }
                "CREATE_FAILED" | "UPDATE_FAILED" | "DELETE_FAILED" | "DEGRADED" => {
                    warn!("Addon {} upgrade failed: {}", addon_name, status_str);
                    new_status.phases.addons[idx].status = ComponentStatus::Failed;
                    new_status.phases.addons[idx].completed_at = Some(Utc::now());
                    status::set_failed(
                        &mut new_status,
                        format!("Addon {} upgrade failed: {}", addon_name, status_str),
                    );
                    Ok((new_status, None))
                }
                _ => {
                    // Still updating
                    Ok((new_status, Some(POLL_INTERVAL)))
                }
            }
        }
        ComponentStatus::Failed => {
            // Already failed → mark overall as failed
            status::set_failed(
                &mut new_status,
                format!("Addon {} is in failed state", addon_name),
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
    if !new_status.phases.nodegroups.is_empty() {
        status::set_phase(new_status, UpgradePhase::UpgradingNodeGroups);
    } else {
        status::set_phase(new_status, UpgradePhase::Completed);
        status::set_condition(new_status, "Ready", "True", "UpgradeCompleted", None);
    }
}
