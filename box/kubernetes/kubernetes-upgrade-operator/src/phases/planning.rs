//! Planning phase: creates the upgrade plan and populates status.

use anyhow::Result;
use tracing::{info, warn};

use crate::aws::AwsClients;
use crate::crd::{
    AddonStatus, ComponentStatus, ControlPlaneStatus, EKSUpgradeSpec, EKSUpgradeStatus,
    KarpenterNodePoolsStatus, KarpenterPoolStatus, LifecycleStatus, NodegroupStatus,
    PlanningStatus, UpgradePhase, VersionLifecycleInfo,
};
use crate::eks::client::EksClient;
use crate::eks::upgrade;
use crate::phases::transition;
use crate::status;

/// Execute the planning phase.
///
/// Fetches cluster info, calculates upgrade path, plans addon and nodegroup upgrades.
/// Populates the status with `upgrade_path`, `addon_statuses`, and `nodegroup_statuses`.
#[allow(clippy::too_many_lines)]
pub async fn execute(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
    aws: &AwsClients,
    in_cluster: &kube::Client,
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

    // Planning phase details.
    //
    // source_version is sticky: once captured on the first planning pass it is
    // preserved across re-plans. If the pod crashes after the control plane has
    // advanced (cluster version already moved past the original), a re-plan
    // reads the newer cluster version, but the persisted source_version keeps
    // the upgrade path anchored to where the upgrade actually started.
    let source_version = current_status
        .phases
        .planning
        .as_ref()
        .and_then(|p| p.source_version.clone())
        .or_else(|| Some(plan.current_version.clone()));
    new_status.phases.planning = Some(PlanningStatus {
        source_version,
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

    // Plan Karpenter NodePool replacement (populates pool skeletons; stale node
    // counts are computed by the phase itself on first entry).
    let karpenter_pools = plan_karpenter(spec, &eks_client, in_cluster).await?;
    let has_karpenter = !karpenter_pools.is_empty();
    if let Some(cfg) = &spec.karpenter_node_pools
        && has_karpenter
    {
        new_status.phases.karpenter_node_pools = Some(KarpenterNodePoolsStatus {
            strategy: cfg.strategy.to_string(),
            active_pool: None,
            total_nodes: 0,
            replaced_nodes: 0,
            pools: karpenter_pools,
        });
    }

    // Fetch EKS version lifecycle info (non-blocking)
    new_status.lifecycle = Some(
        fetch_version_lifecycle(&eks_client, &plan.current_version, &spec.target_version).await,
    );

    // Check if nothing to do. Karpenter work alone is enough to proceed.
    if plan.is_empty() && !has_karpenter {
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
        "Plan created: {} CP steps, {} addons, {} nodegroups, {} karpenter nodepools",
        plan.upgrade_path.len(),
        plan.addon_upgrades.len(),
        plan.nodegroup_upgrades.len(),
        if has_karpenter {
            new_status
                .phases
                .karpenter_node_pools
                .as_ref()
                .map_or(0, |k| k.pools.len())
        } else {
            0
        }
    );

    Ok(new_status)
}

/// Build the Karpenter `NodePool` skeletons for planning.
///
/// Returns an empty vec when Karpenter replacement is disabled or absent. When
/// enabled, resolves the target `NodePool` names (the configured subset, or all
/// `NodePools` when unset). Errors propagate: if replacement is enabled it must be
/// plannable.
async fn plan_karpenter(
    spec: &EKSUpgradeSpec,
    eks_client: &EksClient,
    in_cluster: &kube::Client,
) -> Result<Vec<KarpenterPoolStatus>> {
    let Some(cfg) = &spec.karpenter_node_pools else {
        return Ok(vec![]);
    };
    if !cfg.enabled {
        return Ok(vec![]);
    }

    let client = crate::k8s::client::resolve_client(
        in_cluster,
        eks_client,
        &spec.cluster_name,
        spec.assume_role_arn.as_deref(),
    )
    .await?;

    let names = if cfg.selects_all() {
        crate::k8s::karpenter::list_nodepool_names(&client).await?
    } else {
        cfg.node_pools.clone()
    };

    // Pre-count stale nodes per NodePool so the plan (and dry-run) shows how many
    // nodes each pool will replace, in processing order. Target minor drives the
    // kubelet-version staleness comparison.
    let target_minor = crate::k8s::node::parse_minor(&spec.target_version);
    let mut pools = Vec::with_capacity(names.len());
    for name in names {
        let total_nodes = match target_minor {
            Some(minor) => {
                let (_, stale) =
                    crate::phases::karpenter::resolve_stale(&client, &name, minor, &[]).await?;
                u32::try_from(stale.len()).unwrap_or(u32::MAX)
            }
            None => 0,
        };
        pools.push(KarpenterPoolStatus {
            name,
            status: ComponentStatus::Pending,
            total_nodes,
            replaced_nodes: 0,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![],
        });
    }
    Ok(pools)
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
            dry_run: false,
            timeouts: None,
            notification: None,
            karpenter_node_pools: None,
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
