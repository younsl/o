//! Preflight checking phase.
//!
//! Runs mandatory pre-upgrade validations before proceeding:
//! - EKS Cluster Insights: checks for critical upgrade blockers via EKS Insights API.
//! - EKS Deletion Protection: cluster must have deletion protection enabled.
//! - PDB Drain Deadlock: no PDB with `disruptionsAllowed == 0` (unless skipped).

pub mod checks;

use anyhow::Result;
use tracing::{info, warn};

use crate::aws::AwsClients;
use crate::crd::{
    EKSUpgradeSpec, EKSUpgradeStatus, PreflightCheckStatus, PreflightStatus, UpgradePhase,
};
use crate::eks::client::EksClient;
use crate::status;

use self::checks::{CheckStatus, PreflightCheckResult, PreflightResults, SkippedCheck};

/// Execute the preflight checking phase.
///
/// Runs mandatory checks (deletion protection, PDB drain deadlock) and transitions
/// to the next upgrade phase or fails if any mandatory check fails.
#[allow(clippy::too_many_lines)]
pub async fn execute(
    spec: &EKSUpgradeSpec,
    current_status: &EKSUpgradeStatus,
    aws: &AwsClients,
) -> Result<EKSUpgradeStatus> {
    info!("Running preflight checks for {}", spec.cluster_name);

    let eks_client = EksClient::new(aws.eks.clone(), aws.region.clone());

    let mut preflight = PreflightResults::default();

    // ---- EKS Cluster Insights check ----
    match crate::eks::insights::check_upgrade_readiness(eks_client.inner(), &spec.cluster_name)
        .await
    {
        Ok((_is_ready, summary)) => {
            preflight
                .checks
                .push(PreflightCheckResult::cluster_insights(&summary));

            // Log critical findings with affected resources for visibility
            for finding in &summary.findings {
                if finding.severity == "ERROR" || finding.severity == "CRITICAL" {
                    let resources_str: String = finding
                        .resources
                        .iter()
                        .map(|r| format!("{}:{}", r.resource_type, r.resource_id))
                        .collect::<Vec<_>>()
                        .join(", ");
                    warn!(
                        "Critical insight: {} ({}) [resources: {}]{}",
                        finding.description,
                        finding.category,
                        if resources_str.is_empty() {
                            "none"
                        } else {
                            &resources_str
                        },
                        finding
                            .recommendation
                            .as_ref()
                            .map_or(String::new(), |r| format!(" recommendation: {r}")),
                    );
                }
            }
        }
        Err(e) => {
            warn!("EKS Insights check failed (non-fatal): {}", e);
            preflight.skipped.push(SkippedCheck::cluster_insights(
                "EKS Insights API unavailable",
            ));
        }
    }

    // ---- Deletion Protection check ----
    let cluster = eks_client
        .describe_cluster(&spec.cluster_name)
        .await?
        .ok_or_else(|| crate::error::KuoError::ClusterNotFound(spec.cluster_name.clone()))?;

    match cluster.deletion_protection {
        Some(enabled) => {
            preflight
                .checks
                .push(PreflightCheckResult::deletion_protection(enabled));
        }
        None => {
            preflight
                .skipped
                .push(SkippedCheck::deletion_protection("unable to determine"));
        }
    }

    // ---- PDB Drain Deadlock check ----
    let has_nodegroup_upgrades = !current_status.phases.nodegroups.is_empty();

    if has_nodegroup_upgrades && !spec.skip_pdb_check {
        match crate::k8s::client::build_kube_client(
            &cluster,
            eks_client.region(),
            spec.assume_role_arn.as_deref(),
        )
        .await
        {
            Ok(kc) => match crate::k8s::pdb::check_pdbs(&kc).await {
                Ok(summary) => {
                    preflight
                        .checks
                        .push(PreflightCheckResult::pdb_drain_deadlock(&summary));
                }
                Err(e) => {
                    warn!("PDB check failed (non-fatal): {}", e);
                    preflight.skipped.push(SkippedCheck::pdb_drain_deadlock(
                        "Kubernetes API unavailable",
                    ));
                }
            },
            Err(e) => {
                warn!("Failed to build Kubernetes client for PDB check: {}", e);
                preflight.skipped.push(SkippedCheck::pdb_drain_deadlock(
                    "Kubernetes API unavailable",
                ));
            }
        }
    } else if spec.skip_pdb_check {
        preflight
            .skipped
            .push(SkippedCheck::pdb_drain_deadlock("skipped by user"));
    } else {
        preflight.skipped.push(SkippedCheck::pdb_drain_deadlock(
            "no managed node group upgrades",
        ));
    }

    // ---- Record results into status ----
    let mut new_status = current_status.clone();

    let checks: Vec<PreflightCheckStatus> = preflight
        .checks
        .iter()
        .map(|c| {
            let status_str = match c.status {
                CheckStatus::Pass => "Pass",
                CheckStatus::Fail => "Fail",
            };
            PreflightCheckStatus {
                name: c.name.to_string(),
                status: status_str.to_string(),
                message: c.summary.clone(),
            }
        })
        .chain(preflight.skipped.iter().map(|s| PreflightCheckStatus {
            name: s.name.to_string(),
            status: "Skip".to_string(),
            message: s.reason.clone(),
        }))
        .collect();

    // Log results
    for check in &checks {
        info!("[{}] {}: {}", check.status, check.name, check.message);
    }

    new_status.phases.preflight = Some(PreflightStatus { checks });

    if preflight.has_mandatory_failures() {
        let reasons = preflight.mandatory_failure_reasons();
        status::set_failed(
            &mut new_status,
            format!("Preflight check failed: {}", reasons.join("; ")),
        );
        return Ok(new_status);
    }

    // Dry-run: preflight passed, stop without executing upgrades
    if spec.dry_run {
        status::set_phase(&mut new_status, UpgradePhase::Completed);
        let msg = "Dry-run: preflight passed, plan generated but not executed".to_string();
        new_status.message = Some(msg.clone());
        status::set_condition(
            &mut new_status,
            "Ready",
            "True",
            "DryRunCompleted",
            Some(msg),
        );
        return Ok(new_status);
    }

    // Transition to next phase
    let planning = new_status.phases.planning.as_ref();
    let has_cp_steps = planning.is_some_and(|p| !p.upgrade_path.is_empty());

    if has_cp_steps {
        status::set_phase(&mut new_status, UpgradePhase::UpgradingControlPlane);
    } else if !new_status.phases.addons.is_empty() {
        status::set_phase(&mut new_status, UpgradePhase::UpgradingAddons);
    } else if !new_status.phases.nodegroups.is_empty() {
        status::set_phase(&mut new_status, UpgradePhase::UpgradingNodeGroups);
    } else {
        status::set_phase(&mut new_status, UpgradePhase::Completed);
    }

    Ok(new_status)
}
