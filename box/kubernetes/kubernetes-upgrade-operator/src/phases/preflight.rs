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
    EKSUpgradeSpec, EKSUpgradeStatus, PreflightCheckStatus, PreflightStatus, UpgradeMode,
    UpgradePhase,
};
use crate::eks::client::EksClient;
use crate::phases::transition;
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
    in_cluster: &kube::Client,
) -> Result<EKSUpgradeStatus> {
    info!("Running preflight checks for {}", spec.cluster_name);

    let eks_client = EksClient::new(aws.eks.clone(), aws.region.clone());

    let mut preflight = PreflightResults::default();

    // ---- EKS Cluster Insights check ----
    // Forward upgrades and rollbacks surface findings under different insight
    // categories, matching the AWS EKS console (Upgrade insights tab).
    let insights_category = match spec.upgrade_mode {
        UpgradeMode::Forward => "UPGRADE_READINESS",
        UpgradeMode::Rollback => "ROLLBACK_READINESS",
    };
    match crate::eks::insights::check_insights_readiness(
        eks_client.inner(),
        &spec.cluster_name,
        insights_category,
    )
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
                        "Critical insight in category {} reports {}. {}{}",
                        finding.category,
                        finding.description,
                        if resources_str.is_empty() {
                            "No affected resources were reported.".to_string()
                        } else {
                            format!("Affected resources are {resources_str}.")
                        },
                        finding
                            .recommendation
                            .as_ref()
                            .map_or(String::new(), |r| format!(" Recommendation is {r}.")),
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
    // Always enforced when node groups are being rolled; there is no opt-out,
    // because draining into a zero-disruption PDB deadlocks the rollout.
    let has_nodegroup_upgrades = !current_status.phases.nodegroups.is_empty();

    if has_nodegroup_upgrades {
        match crate::k8s::client::resolve_client(
            in_cluster,
            &eks_client,
            &spec.cluster_name,
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
    } else {
        preflight.skipped.push(SkippedCheck::pdb_drain_deadlock(
            "no managed node group upgrades",
        ));
    }

    // ---- Karpenter NodePool checks (only when enabled) ----
    if let Some(cfg) = &spec.karpenter_node_pools
        && cfg.enabled
    {
        match crate::k8s::client::resolve_client(
            in_cluster,
            &eks_client,
            &spec.cluster_name,
            spec.assume_role_arn.as_deref(),
        )
        .await
        {
            Ok(kc) => run_karpenter_checks(&kc, cfg, &mut preflight).await,
            Err(e) => {
                warn!("Failed to build Kubernetes client for Karpenter checks: {e}");
                preflight
                    .skipped
                    .push(SkippedCheck::karpenter("Kubernetes API unavailable"));
            }
        }
    }

    // ---- Record results into status ----
    let mut new_status = current_status.clone();

    let checks = build_check_statuses(&preflight);

    // Log results, then enumerate each flagged resource on its own line so the
    // offending objects are greppable, not buried in the summary sentence.
    for check in &checks {
        info!(
            "Preflight check {} {}. {}.",
            check.name,
            status_verb(&check.status),
            check.message
        );
        let total = check.resources.len();
        for (i, resource) in check.resources.iter().enumerate() {
            info!(
                "Preflight check {} flagged {} as resource {} of {}.",
                check.name,
                resource,
                i + 1,
                total
            );
        }
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

    // Transition to next phase (mode-aware routing)
    let next = transition::after_preflight(&new_status, &spec.upgrade_mode);
    transition::transition_to(&mut new_status, next);

    Ok(new_status)
}

/// Run Karpenter v1-API and AMI-selector preflight checks.
///
/// Records a mandatory failure if the v1 API is absent or any target `NodePool`
/// pins its AMI. Probe failures are recorded as skips rather than hard errors,
/// mirroring the other non-fatal preflight checks.
async fn run_karpenter_checks(
    kc: &kube::Client,
    cfg: &crate::crd::KarpenterNodePoolsConfig,
    preflight: &mut PreflightResults,
) {
    use crate::k8s::karpenter;

    match karpenter::v1_available(kc).await {
        Ok(true) => {
            preflight
                .checks
                .push(PreflightCheckResult::karpenter_v1_api(true));
        }
        Ok(false) => {
            preflight
                .checks
                .push(PreflightCheckResult::karpenter_v1_api(false));
            return;
        }
        Err(e) => {
            warn!("Karpenter v1 API probe failed (non-fatal): {e}");
            preflight
                .skipped
                .push(SkippedCheck::karpenter("Karpenter API probe failed"));
            return;
        }
    }

    let names = if cfg.selects_all() {
        match karpenter::list_nodepool_names(kc).await {
            Ok(n) => n,
            Err(e) => {
                warn!("Failed to list NodePools for AMI check (non-fatal): {e}");
                preflight
                    .skipped
                    .push(SkippedCheck::karpenter("unable to list NodePools"));
                return;
            }
        }
    } else {
        cfg.node_pools.clone()
    };

    let mut pinned = Vec::new();
    for np in &names {
        match karpenter::nodepool_ami_terms(kc, np).await {
            Ok(terms) => {
                if karpenter::is_pinned_ami(&terms) {
                    pinned.push(np.clone());
                }
            }
            Err(e) => {
                warn!("Failed to read EC2NodeClass for NodePool {np} (non-fatal): {e}");
                preflight
                    .skipped
                    .push(SkippedCheck::karpenter("unable to read EC2NodeClass"));
            }
        }
    }
    preflight
        .checks
        .push(PreflightCheckResult::karpenter_ami_selector(
            names.len(),
            &pinned,
        ));
}

/// Past-tense verb for a check status, so log lines read as sentences.
fn status_verb(status: &str) -> &'static str {
    match status {
        "Pass" => "passed",
        "Fail" => "failed",
        _ => "was skipped",
    }
}

/// Build preflight check status entries from results.
fn build_check_statuses(preflight: &PreflightResults) -> Vec<PreflightCheckStatus> {
    preflight
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
                resources: c.resources.clone(),
            }
        })
        .chain(preflight.skipped.iter().map(|s| PreflightCheckStatus {
            name: s.name.to_string(),
            status: "Skip".to_string(),
            message: s.reason.clone(),
            resources: Vec::new(),
        }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- build_check_statuses tests ---

    #[test]
    fn test_build_check_statuses_empty() {
        let preflight = PreflightResults::default();
        let checks = build_check_statuses(&preflight);
        assert!(checks.is_empty());
    }

    #[test]
    fn test_build_check_statuses_pass() {
        let preflight = PreflightResults {
            checks: vec![PreflightCheckResult::deletion_protection(true)],
            skipped: vec![],
        };
        let checks = build_check_statuses(&preflight);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].status, "Pass");
        assert_eq!(checks[0].name, "EKS Deletion Protection");
    }

    #[test]
    fn test_build_check_statuses_fail() {
        let preflight = PreflightResults {
            checks: vec![PreflightCheckResult::deletion_protection(false)],
            skipped: vec![],
        };
        let checks = build_check_statuses(&preflight);
        assert_eq!(checks[0].status, "Fail");
    }

    #[test]
    fn test_build_check_statuses_skipped() {
        let preflight = PreflightResults {
            checks: vec![],
            skipped: vec![SkippedCheck::pdb_drain_deadlock("skipped by user")],
        };
        let checks = build_check_statuses(&preflight);
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0].status, "Skip");
        assert_eq!(checks[0].message, "skipped by user");
    }

    #[test]
    fn test_status_verb_reads_as_sentence() {
        assert_eq!(status_verb("Pass"), "passed");
        assert_eq!(status_verb("Fail"), "failed");
        assert_eq!(status_verb("Skip"), "was skipped");
        // Unknown statuses fall back to the skipped wording rather than panicking.
        assert_eq!(status_verb("Info"), "was skipped");
    }

    #[test]
    fn test_build_check_statuses_carries_resources() {
        let pdb = crate::k8s::pdb::PdbSummary {
            total_pdbs: 4,
            blocking: vec![
                "payments/worker-pdb".to_string(),
                "kube-system/coredns-pdb".to_string(),
            ],
        };
        let preflight = PreflightResults {
            checks: vec![PreflightCheckResult::pdb_drain_deadlock(&pdb)],
            skipped: vec![SkippedCheck::cluster_insights("API unavailable")],
        };
        let checks = build_check_statuses(&preflight);
        assert_eq!(
            checks[0].resources,
            vec!["payments/worker-pdb", "kube-system/coredns-pdb"]
        );
        // Skipped checks flag nothing.
        assert!(checks[1].resources.is_empty());
    }

    #[test]
    fn test_build_check_statuses_mixed() {
        let preflight = PreflightResults {
            checks: vec![
                PreflightCheckResult::deletion_protection(true),
                PreflightCheckResult::deletion_protection(false),
            ],
            skipped: vec![SkippedCheck::pdb_drain_deadlock("no nodegroups")],
        };
        let checks = build_check_statuses(&preflight);
        assert_eq!(checks.len(), 3);
        assert_eq!(checks[0].status, "Pass");
        assert_eq!(checks[1].status, "Fail");
        assert_eq!(checks[2].status, "Skip");
    }

    // Next-phase routing after preflight is covered by
    // `crate::phases::transition` tests.
}
