//! Planning phase: creates the upgrade plan and populates status.

use anyhow::Result;
use tracing::info;

use crate::aws::AwsClients;
use crate::crd::{
    AddonStatus, ComponentStatus, ControlPlaneStatus, EKSUpgradeSpec, EKSUpgradeStatus,
    NodegroupStatus, PlanningStatus, UpgradePhase,
};
use crate::eks::client::EksClient;
use crate::eks::upgrade;
use crate::status;

/// Execute the planning phase.
///
/// Fetches cluster info, calculates upgrade path, plans addon and nodegroup upgrades.
/// Populates the status with upgrade_path, addon_statuses, and nodegroup_statuses.
pub async fn execute(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
    aws: &AwsClients,
) -> Result<EKSUpgradeStatus> {
    info!(
        "Planning upgrade for {} to {}",
        spec.cluster_name, spec.target_version
    );

    let eks_client = EksClient::new(aws.eks.clone(), aws.region.clone());

    let addon_versions = spec.addon_versions.clone().unwrap_or_default();

    let plan = upgrade::create_upgrade_plan(
        &eks_client,
        &spec.cluster_name,
        &spec.target_version,
        &addon_versions,
    )
    .await?;

    let mut new_status = current_status.clone();
    new_status.current_version = Some(plan.current_version.clone());

    // Planning phase details
    new_status.phases.planning = Some(PlanningStatus {
        upgrade_path: plan.upgrade_path.clone(),
    });

    // Control plane phase details
    let total_steps = plan.upgrade_path.len() as u32;
    new_status.phases.control_plane = Some(ControlPlaneStatus {
        current_step: if total_steps > 0 { 1 } else { 0 },
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
