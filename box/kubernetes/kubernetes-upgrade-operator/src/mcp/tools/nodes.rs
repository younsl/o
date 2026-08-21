//! Node-side read tools: managed node groups (EKS API), Karpenter state and
//! PDB risks (target cluster).

use serde_json::json;

use crate::crd::EKSUpgrade;
use crate::eks::nodegroup::NodeGroupPlanResult;
use crate::k8s::pdb::PdbSummary;
use crate::mcp::result::{LIST_CAP, ToolResult, Verdict};

/// Shape `get_nodegroup_state` from the recorded status plus the live plan.
pub fn render_nodegroups(cr: &EKSUpgrade, plan: &NodeGroupPlanResult) -> ToolResult {
    let status = cr.status.clone().unwrap_or_default();
    let cluster = cr.spec.cluster_name.clone();

    let planned: Vec<serde_json::Value> = plan
        .upgrades
        .iter()
        .take(LIST_CAP)
        .map(|ng| {
            json!({
                "name": ng.name,
                "currentVersion": ng.current_version(),
                "plannedAction": format!("upgrade to {}", cr.spec.target_version),
            })
        })
        .collect();

    let recorded: Vec<serde_json::Value> = status
        .phases
        .nodegroups
        .iter()
        .take(LIST_CAP)
        .map(|ng| {
            json!({
                "name": ng.name,
                "currentVersion": ng.current_version,
                "targetVersion": ng.target_version,
                "status": format!("{:?}", ng.status),
                "updateId": ng.update_id,
            })
        })
        .collect();

    let degraded = status
        .phases
        .nodegroups
        .iter()
        .any(|ng| ng.status == crate::crd::ComponentStatus::Failed);

    let mut result = ToolResult::new(
        format!(
            "{cluster}: {} node group(s) need {} ({} already there){}",
            plan.upgrades.len(),
            cr.spec.target_version,
            plan.skipped_count(),
            if degraded {
                ", one or more recorded as Failed"
            } else {
                ""
            }
        ),
        if degraded { Verdict::Warn } else { Verdict::Ok },
        json!({
            "toUpgrade": planned,
            "skippedCount": plan.skipped_count(),
            "recordedRun": recorded,
        }),
    );
    result.cluster = Some(cluster);
    result.truncated = plan.upgrades.len() > LIST_CAP || status.phases.nodegroups.len() > LIST_CAP;
    result
}

/// Shape `get_karpenter_state` from the recorded status plus a live
/// `NodeClaim` count from the target cluster.
pub fn render_karpenter(cr: &EKSUpgrade, live_nodeclaims: Option<usize>) -> ToolResult {
    let status = cr.status.clone().unwrap_or_default();
    let cluster = cr.spec.cluster_name.clone();

    let Some(config) = cr.spec.karpenter_node_pools.as_ref().filter(|k| k.enabled) else {
        let mut result = ToolResult::new(
            format!("{cluster}: Karpenter node replacement is not enabled on this EKSUpgrade"),
            Verdict::Ok,
            json!({ "enabled": false }),
        );
        result.cluster = Some(cluster);
        return result;
    };

    let karpenter = status.phases.karpenter_node_pools;
    let pools: Vec<serde_json::Value> = karpenter
        .as_ref()
        .map(|k| {
            k.pools
                .iter()
                .take(LIST_CAP)
                .map(|pool| {
                    json!({
                        "name": pool.name,
                        "status": format!("{:?}", pool.status),
                        "totalNodes": pool.total_nodes,
                        "replacedNodes": pool.replaced_nodes,
                        "inFlight": pool.current_batch.iter().map(|b| json!({
                            "nodeClaim": b.node_claim,
                            "state": b.state,
                        })).collect::<Vec<_>>(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let (replaced, total) = karpenter
        .as_ref()
        .map_or((0, 0), |k| (k.replaced_nodes, k.total_nodes));

    let mut result = ToolResult::new(
        format!(
            "{cluster}: Karpenter replacement {replaced}/{total} nodes{}",
            live_nodeclaims.map_or_else(String::new, |n| format!(", {n} NodeClaims live"))
        ),
        Verdict::Ok,
        json!({
            "enabled": true,
            "configuredPools": config.node_pools,
            "liveNodeClaims": live_nodeclaims,
            "replacedNodes": replaced,
            "totalNodes": total,
            "activePool": karpenter.as_ref().and_then(|k| k.active_pool.clone()),
            "pools": pools,
        }),
    );
    result.cluster = Some(cluster);
    result
}

/// Shape `get_pdb_risks` from a live target-cluster PDB sweep.
pub fn render_pdbs(cluster: &str, summary: &PdbSummary) -> ToolResult {
    let truncated = summary.blocking.len() > LIST_CAP;
    let blocking: Vec<&String> = summary.blocking.iter().take(LIST_CAP).collect();

    let (line, verdict) = if summary.has_blocking_pdbs() {
        (
            format!(
                "{cluster}: {} of {} PodDisruptionBudget(s) would deadlock a node drain",
                summary.blocking.len(),
                summary.total_pdbs
            ),
            Verdict::Blocked,
        )
    } else {
        (
            format!(
                "{cluster}: none of {} PodDisruptionBudget(s) block a drain",
                summary.total_pdbs
            ),
            Verdict::Ok,
        )
    };

    let mut result = ToolResult::new(
        line,
        verdict,
        json!({
            "totalPdbs": summary.total_pdbs,
            "blocking": blocking,
        }),
    );
    result.cluster = Some(cluster.to_string());
    result.truncated = truncated;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{EKSUpgradeSpec, EKSUpgradeStatus, UpgradeMode};
    use crate::eks::nodegroup::NodeGroupInfo;

    fn upgrade(karpenter: bool) -> EKSUpgrade {
        EKSUpgrade::new(
            "prod",
            EKSUpgradeSpec {
                cluster_name: "prod".to_string(),
                target_version: "1.34".to_string(),
                region: "ap-northeast-2".to_string(),
                upgrade_mode: UpgradeMode::Forward,
                assume_role_arn: None,
                addon_versions: None,
                dry_run: true,
                timeouts: None,
                notification: None,
                karpenter_node_pools: karpenter.then(|| {
                    serde_json::from_value(serde_json::json!({
                        "enabled": true,
                        "nodePools": ["default"],
                    }))
                    .expect("valid KarpenterNodePoolsConfig")
                }),
            },
        )
    }

    #[test]
    fn test_render_nodegroups() {
        let mut cr = upgrade(false);
        cr.status = Some(EKSUpgradeStatus::default());
        let mut plan = NodeGroupPlanResult::new();
        plan.add_upgrade(NodeGroupInfo {
            name: "workers".to_string(),
            version: Some("1.32".to_string()),
        });
        plan.add_skipped();

        let result = render_nodegroups(&cr, &plan);
        assert_eq!(result.verdict, Verdict::Ok);
        assert_eq!(result.details["toUpgrade"][0]["name"], "workers");
        assert_eq!(result.details["skippedCount"], 1);
    }

    #[test]
    fn test_render_karpenter_disabled() {
        let result = render_karpenter(&upgrade(false), None);
        assert_eq!(result.verdict, Verdict::Ok);
        assert_eq!(result.details["enabled"], false);
    }

    #[test]
    fn test_render_karpenter_enabled_with_live_count() {
        let result = render_karpenter(&upgrade(true), Some(7));
        assert_eq!(result.details["enabled"], true);
        assert_eq!(result.details["liveNodeClaims"], 7);
        assert!(result.summary.contains("7 NodeClaims live"));
    }

    #[test]
    fn test_render_pdbs_blocking() {
        let summary = PdbSummary {
            total_pdbs: 4,
            blocking: vec!["payments/worker-pdb".to_string()],
        };
        let result = render_pdbs("prod", &summary);
        assert_eq!(result.verdict, Verdict::Blocked);
        assert_eq!(result.details["blocking"][0], "payments/worker-pdb");
    }

    #[test]
    fn test_render_pdbs_clean() {
        let summary = PdbSummary {
            total_pdbs: 4,
            blocking: vec![],
        };
        let result = render_pdbs("prod", &summary);
        assert_eq!(result.verdict, Verdict::Ok);
    }
}
