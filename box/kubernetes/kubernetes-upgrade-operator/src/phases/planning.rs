//! Planning phase: creates the upgrade plan and populates status.

use anyhow::Result;
use tracing::{info, warn};

use crate::aws::AwsClients;
use crate::crd::{
    AddonStatus, ComponentStatus, ControlPlaneStatus, EKSUpgradeSpec, EKSUpgradeStatus,
    LifecycleStatus, NodegroupStatus, PlanningStatus, UpgradePhase, VersionLifecycleInfo,
};
use crate::eks::client::EksClient;
use crate::eks::upgrade;
use crate::phases::transition;
use crate::status;

/// Execute the planning phase.
///
/// Fetches cluster info, calculates upgrade path, plans addon and nodegroup upgrades.
/// Populates the status with `upgrade_path`, `addon_statuses`, and `nodegroup_statuses`.
pub async fn execute(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
    aws: &AwsClients,
) -> Result<EKSUpgradeStatus> {
    info!(
        "Planning upgrade for {} to {}",
        spec.cluster_name, spec.target_version
    );

    // Guardrail: reject a rollback that immediately follows a completed
    // rollback. Fail fast before any AWS calls.
    if let Some(rejected) = reject_consecutive_rollback(spec, current_status) {
        return Ok(rejected);
    }

    let eks_client = EksClient::new(aws.eks.clone(), aws.region.clone());

    let addon_versions = spec.addon_versions.clone().unwrap_or_default();

    let plan = upgrade::create_upgrade_plan(
        &eks_client,
        &spec.cluster_name,
        &spec.target_version,
        &addon_versions,
        spec.upgrade_mode.clone(),
    )
    .await?;

    let mut new_status = current_status.clone();
    new_status.current_version = Some(plan.current_version.clone());

    // Planning phase details
    new_status.phases.planning = Some(PlanningStatus {
        upgrade_path: plan.upgrade_path.clone(),
    });

    // Control plane phase details
    #[allow(clippy::cast_possible_truncation)]
    let total_steps = plan.upgrade_path.len() as u32;
    new_status.phases.control_plane = Some(ControlPlaneStatus {
        current_step: u32::from(total_steps > 0),
        total_steps,
        target: None,
        update_id: None,
        started_at: None,
        completed_at: None,
    });

    // Build addon statuses
    new_status.phases.addons = plan
        .addon_upgrades
        .iter()
        .map(|(addon, target_version)| AddonStatus {
            name: addon.name.clone(),
            current_version: addon.current_version.clone(),
            target_version: target_version.clone(),
            status: ComponentStatus::Pending,
            started_at: None,
            completed_at: None,
        })
        .collect();

    // Build nodegroup statuses
    new_status.phases.nodegroups = plan
        .nodegroup_upgrades
        .iter()
        .map(|ng| NodegroupStatus {
            name: ng.name.clone(),
            current_version: ng.current_version().to_string(),
            target_version: spec.target_version.clone(),
            status: ComponentStatus::Pending,
            update_id: None,
            started_at: None,
            completed_at: None,
        })
        .collect();

    // Fetch EKS version lifecycle info (non-blocking)
    new_status.lifecycle = Some(
        fetch_version_lifecycle(&eks_client, &plan.current_version, &spec.target_version).await,
    );

    // Check if nothing to do
    if plan.is_empty() {
        status::set_phase(&mut new_status, UpgradePhase::Completed);
        let msg = "All components already at target version".to_string();
        new_status.message = Some(msg.clone());
        status::set_condition(
            &mut new_status,
            "Ready",
            "True",
            "AlreadyUpToDate",
            Some(msg),
        );
        return Ok(new_status);
    }

    // Transition to preflight checking phase
    status::set_phase(&mut new_status, UpgradePhase::PreflightChecking);

    status::set_condition(&mut new_status, "Ready", "False", "UpgradeInProgress", None);

    info!(
        "Plan created: {} CP steps, {} addons, {} nodegroups",
        plan.upgrade_path.len(),
        plan.addon_upgrades.len(),
        plan.nodegroup_upgrades.len()
    );

    Ok(new_status)
}

/// If starting this upgrade would be a rollback immediately following a
/// completed rollback, return a `Failed` status explaining why; otherwise
/// `None`.
///
/// The live cluster version cannot reveal how the cluster reached its current
/// minor, so a second rollback in a row (e.g. 1.36 -> 1.35 then 1.35 -> 1.34)
/// would pass the single-minor path check yet has no version EKS considers a
/// valid rollback target.
fn reject_consecutive_rollback(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
) -> Option<EKSUpgradeStatus> {
    if !transition::is_consecutive_rollback(
        &spec.upgrade_mode,
        current_status.last_transition.as_ref(),
    ) {
        return None;
    }

    let mut new_status = current_status.clone();
    let last_to = current_status
        .last_transition
        .as_ref()
        .map_or("unknown", |t| t.to_version.as_str());
    let msg = format!(
        "Consecutive rollback rejected: the previous transition already rolled back to {last_to}. \
         EKS only permits rolling back to a version the cluster was recently upgraded from, so \
         rolling back further to {} is not possible. Roll forward before rolling back again.",
        spec.target_version
    );
    warn!("{msg}");
    status::set_failed(&mut new_status, msg.clone());
    status::set_condition(
        &mut new_status,
        "Ready",
        "False",
        "ConsecutiveRollbackRejected",
        Some(msg),
    );
    Some(new_status)
}

/// Fetch EKS version lifecycle information for current and target versions.
///
/// Non-blocking: if the API call fails, returns a `LifecycleStatus` with an
/// error message instead of propagating the error.
async fn fetch_version_lifecycle(
    eks_client: &EksClient,
    current_version: &str,
    target_version: &str,
) -> LifecycleStatus {
    let versions: Vec<&str> = if current_version == target_version {
        vec![current_version]
    } else {
        vec![current_version, target_version]
    };

    let last_checked_time = chrono::Utc::now();

    let lifecycles = match eks_client.describe_cluster_versions(&versions).await {
        Ok(v) => v,
        Err(e) => {
            warn!("Failed to fetch EKS version lifecycle info: {e}");
            return LifecycleStatus {
                last_checked_time,
                current_version: None,
                target_version: None,
                error: Some(format!("Failed to describe cluster versions: {e}")),
            };
        }
    };

    let to_info = |ver: &str| -> Option<VersionLifecycleInfo> {
        lifecycles
            .iter()
            .find(|l| l.version == ver)
            .map(|l| VersionLifecycleInfo {
                version: l.version.clone(),
                version_status: l.status.clone(),
                end_of_standard_support_date: l.end_of_standard_support,
                end_of_extended_support_date: l.end_of_extended_support,
            })
    };

    LifecycleStatus {
        last_checked_time,
        current_version: to_info(current_version),
        target_version: to_info(target_version),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{TransitionRecord, UpgradeMode, UpgradePhase};

    fn spec(mode: UpgradeMode, target: &str) -> EKSUpgradeSpec {
        EKSUpgradeSpec {
            cluster_name: "c".to_string(),
            target_version: target.to_string(),
            region: "ap-northeast-2".to_string(),
            upgrade_mode: mode,
            assume_role_arn: None,
            addon_versions: None,
            skip_pdb_check: false,
            dry_run: false,
            timeouts: None,
            notification: None,
        }
    }

    fn status_after(mode: UpgradeMode, to: &str) -> EKSUpgradeStatus {
        EKSUpgradeStatus {
            last_transition: Some(TransitionRecord {
                mode,
                to_version: to.to_string(),
                completed_at: chrono::DateTime::from_timestamp(0, 0).unwrap(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn test_reject_second_rollback_in_a_row() {
        let s = reject_consecutive_rollback(
            &spec(UpgradeMode::Rollback, "1.34"),
            &status_after(UpgradeMode::Rollback, "1.35"),
        )
        .expect("should reject");
        assert_eq!(s.phase, Some(UpgradePhase::Failed));
        assert!(s.message.unwrap().contains("1.35"));
    }

    #[test]
    fn test_allow_rollback_after_forward() {
        assert!(
            reject_consecutive_rollback(
                &spec(UpgradeMode::Rollback, "1.35"),
                &status_after(UpgradeMode::Forward, "1.36"),
            )
            .is_none()
        );
    }

    #[test]
    fn test_allow_first_rollback_no_history() {
        assert!(
            reject_consecutive_rollback(
                &spec(UpgradeMode::Rollback, "1.35"),
                &EKSUpgradeStatus::default(),
            )
            .is_none()
        );
    }

    #[test]
    fn test_allow_forward_after_rollback() {
        assert!(
            reject_consecutive_rollback(
                &spec(UpgradeMode::Forward, "1.36"),
                &status_after(UpgradeMode::Rollback, "1.35"),
            )
            .is_none()
        );
    }
}
