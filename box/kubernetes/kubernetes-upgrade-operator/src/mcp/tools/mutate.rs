//! Mutating tools. Every one patches `EKSUpgrade` resources, never AWS, so
//! the controller stays the single actor and every change shows in
//! `kubectl get eksupgrade`.
//!
//! Guard order per call: allowlist, target-state check, patch, audit log,
//! cache invalidation, then any notification. The `WARN` audit log is the
//! primary record; the Slack notification on `promote_dry_run` is
//! best-effort and never blocks the promotion.

use anyhow::Result;
use kube::Api;
use kube::api::{Patch, PatchParams, PostParams};
use serde_json::json;
use tracing::{error, warn};

use crate::crd::{EKSUpgrade, EKSUpgradeSpec, UpgradeMode, UpgradePhase};
use crate::mcp::result::{ToolResult, Verdict};
use crate::mcp::tools::McpContext;
use crate::notify::slack::SlackMessage;

/// Field manager stamped on every MCP-originated patch, so a kubectl
/// inspection can tell an agent's change from the controller's.
const FIELD_MANAGER: &str = "kuo-mcp";

/// Phases during which a resource counts as having a run in progress.
const fn run_in_progress(phase: Option<&UpgradePhase>) -> bool {
    !matches!(
        phase,
        None | Some(UpgradePhase::Completed | UpgradePhase::Failed)
    )
}

/// The denial result every gate returns, naming the gate so the agent tells
/// the human what to change instead of retrying.
fn denied(cluster: &str, gate: &str, reason: &str) -> ToolResult {
    let mut result = ToolResult::new(
        format!("denied by {gate}: {reason}"),
        Verdict::Blocked,
        json!({ "gate": gate, "reason": reason }),
    );
    result.cluster = Some(cluster.to_string());
    result
}

/// `plan_upgrade`: create or update a dry-run `EKSUpgrade`.
///
/// Refuses when the existing resource has `dryRun: false` or a run in
/// progress, since flipping a live upgrade back to dry-run mid-flight is not
/// a plan, it is an interruption.
pub async fn plan_upgrade(
    ctx: &McpContext,
    cluster_name: &str,
    target_version: &str,
    region: &str,
) -> Result<ToolResult> {
    // One EKSUpgrade per cluster: find any existing resource for this cluster.
    let all: Api<EKSUpgrade> = Api::all(ctx.kube.clone());
    let existing = all
        .list(&kube::api::ListParams::default())
        .await?
        .items
        .into_iter()
        .find(|cr| cr.spec.cluster_name == cluster_name);

    if let Some(cr) = existing {
        return update_plan(ctx, &cr, cluster_name, target_version, region).await;
    }

    // Nothing exists: create fresh and dry-run. EKSUpgrade is
    // cluster-scoped, so there is no namespace to choose.
    let spec = EKSUpgradeSpec {
        cluster_name: cluster_name.to_string(),
        target_version: target_version.to_string(),
        region: region.to_string(),
        upgrade_mode: UpgradeMode::Forward,
        assume_role_arn: None,
        addon_versions: None,
        dry_run: true,
        timeouts: None,
        notification: None,
        karpenter_node_pools: None,
    };
    let cr = EKSUpgrade::new(cluster_name, spec);
    let api: Api<EKSUpgrade> = Api::all(ctx.kube.clone());
    api.create(&PostParams::default(), &cr).await?;

    audit(
        "plan_upgrade",
        cluster_name,
        &json!({
            "action": "created",
            "resource": cluster_name,
            "targetVersion": target_version,
        }),
    );
    ctx.cache.invalidate_cluster(cluster_name).await;

    let mut result = ToolResult::new(
        format!("created dry-run plan for {cluster_name} toward {target_version}"),
        Verdict::Ok,
        json!({
            "action": "created",
            "resource": cluster_name,
            "dryRun": true,
            "note": "the controller now runs Planning and PreflightChecking without touching the cluster",
        }),
    );
    result.cluster = Some(cluster_name.to_string());
    Ok(result)
}

/// The update half of `plan_upgrade`: an `EKSUpgrade` for this cluster
/// already exists, so re-aim it while refusing to touch a live or running one.
async fn update_plan(
    ctx: &McpContext,
    cr: &EKSUpgrade,
    cluster_name: &str,
    target_version: &str,
    region: &str,
) -> Result<ToolResult> {
    let status = cr.status.clone().unwrap_or_default();
    if !cr.spec.dry_run {
        return Ok(denied(
            cluster_name,
            "live-resource",
            "the existing EKSUpgrade has dryRun: false; flipping a live upgrade back to dry-run is an interruption, not a plan",
        ));
    }
    if run_in_progress(status.phase.as_ref()) {
        return Ok(denied(
            cluster_name,
            "run-in-progress",
            &format!(
                "the existing EKSUpgrade is in {}",
                status
                    .phase
                    .as_ref()
                    .map_or_else(|| "an active phase".to_string(), ToString::to_string)
            ),
        ));
    }

    let name = cr.metadata.name.as_deref().unwrap_or(cluster_name);
    let api: Api<EKSUpgrade> = Api::all(ctx.kube.clone());
    api.patch(
        name,
        &PatchParams::apply(FIELD_MANAGER).force(),
        &Patch::Merge(json!({
            "spec": {
                "targetVersion": target_version,
                "region": region,
                "dryRun": true,
            }
        })),
    )
    .await?;

    audit(
        "plan_upgrade",
        cluster_name,
        &json!({
            "action": "updated",
            "resource": name,
            "targetVersion": target_version,
        }),
    );
    ctx.cache.invalidate_cluster(cluster_name).await;

    let mut result = ToolResult::new(
        format!("updated dry-run plan for {cluster_name} toward {target_version}"),
        Verdict::Ok,
        json!({ "action": "updated", "resource": name, "dryRun": true }),
    );
    result.cluster = Some(cluster_name.to_string());
    Ok(result)
}

/// `retry_upgrade`: bump a retry annotation on a `Failed` resource so the
/// controller reconciles it again.
pub async fn retry_upgrade(ctx: &McpContext, cr: &EKSUpgrade) -> Result<ToolResult> {
    let cluster = cr.spec.cluster_name.clone();
    let phase = cr.status.as_ref().and_then(|s| s.phase.clone());
    if phase != Some(UpgradePhase::Failed) {
        return Ok(denied(
            &cluster,
            "phase",
            &format!(
                "retry applies only to Failed resources, this one is {}",
                phase.map_or_else(|| "NotStarted".to_string(), |p| p.to_string())
            ),
        ));
    }

    let name = cr.metadata.name.as_deref().unwrap_or(&cluster);
    let stamp = chrono::Utc::now().to_rfc3339();
    let api: Api<EKSUpgrade> = Api::all(ctx.kube.clone());
    api.patch(
        name,
        &PatchParams::default(),
        &Patch::Merge(json!({
            "metadata": { "annotations": { "kuo.io/retry-at": stamp } }
        })),
    )
    .await?;

    audit(
        "retry_upgrade",
        &cluster,
        &json!({ "resource": name, "retryAt": stamp }),
    );
    ctx.cache.invalidate_cluster(&cluster).await;

    let mut result = ToolResult::new(
        format!("retry requested for {cluster}"),
        Verdict::Ok,
        json!({ "resource": name, "retryAt": stamp }),
    );
    result.cluster = Some(cluster);
    Ok(result)
}

/// `promote_dry_run`: flip `dryRun` from true to false. The one tool that
/// starts a real upgrade, so it additionally notifies Slack on every call.
pub async fn promote_dry_run(ctx: &McpContext, cr: &EKSUpgrade) -> Result<ToolResult> {
    let cluster = cr.spec.cluster_name.clone();
    if !cr.spec.dry_run {
        return Ok(denied(
            &cluster,
            "dry-run-state",
            "the resource already has dryRun: false",
        ));
    }

    let name = cr.metadata.name.as_deref().unwrap_or(&cluster);
    let api: Api<EKSUpgrade> = Api::all(ctx.kube.clone());
    api.patch(
        name,
        &PatchParams::default(),
        &Patch::Merge(json!({ "spec": { "dryRun": false } })),
    )
    .await?;

    audit(
        "promote_dry_run",
        &cluster,
        &json!({ "resource": name, "targetVersion": cr.spec.target_version }),
    );
    ctx.cache.invalidate_cluster(&cluster).await;

    // Best-effort human notification: a failed send is logged at ERROR and
    // never blocks the promotion; the WARN audit log above is the record.
    if let Some(slack) = &ctx.slack {
        let message = SlackMessage {
            header: "EKSUpgrade promoted from dry-run via MCP".to_string(),
            fields: vec![
                ("Cluster".to_string(), cluster.clone()),
                ("Target".to_string(), cr.spec.target_version.clone()),
                ("Resource".to_string(), name.to_string()),
            ],
            context: "requested by a kagent agent through the kuo MCP endpoint".to_string(),
        };
        slack.send(name, &message).await;
    } else {
        error!(
            cluster = %cluster,
            "promote_dry_run succeeded but no Slack notifier is configured, the audit log is the only record"
        );
    }

    let mut result = ToolResult::new(
        format!(
            "{cluster} promoted to a live upgrade toward {}",
            cr.spec.target_version
        ),
        Verdict::Ok,
        json!({
            "resource": name,
            "dryRun": false,
            "note": "the controller starts the real run on its next reconcile",
        }),
    );
    result.cluster = Some(cluster);
    Ok(result)
}

/// The audit record every accepted mutating call emits. WARN deliberately:
/// it survives a production filter running above `info`.
fn audit(tool: &str, cluster: &str, details: &serde_json::Value) {
    warn!(
        tool = tool,
        cluster = cluster,
        details = %details,
        "MCP mutating call accepted"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_run_in_progress() {
        assert!(!run_in_progress(None));
        assert!(!run_in_progress(Some(&UpgradePhase::Completed)));
        assert!(!run_in_progress(Some(&UpgradePhase::Failed)));
        assert!(run_in_progress(Some(&UpgradePhase::Planning)));
        assert!(run_in_progress(Some(&UpgradePhase::UpgradingControlPlane)));
        assert!(run_in_progress(Some(&UpgradePhase::PreflightChecking)));
    }

    #[test]
    fn test_denied_shape() {
        let result = denied("prod", "phase", "not Failed");
        assert_eq!(result.verdict, Verdict::Blocked);
        assert_eq!(result.details["gate"], "phase");
        assert!(result.summary.starts_with("denied by"));
    }

    use crate::crd::EKSUpgradeStatus;
    use crate::mcp::cache::Cache;
    use crate::mcp::metrics::McpMetrics;
    use std::sync::Arc;
    use std::time::Duration;

    /// A context whose kube client points nowhere: only paths that deny
    /// before any API call may run against it.
    fn denying_ctx() -> McpContext {
        let mut registry = prometheus_client::registry::Registry::default();
        let metrics = Arc::new(McpMetrics::new(&mut registry));
        let kube_config = kube::Config::new("http://127.0.0.1:1".parse().unwrap());
        let kube = kube::Client::try_from(kube_config).unwrap();
        McpContext::new(kube, Cache::new(Duration::from_secs(30)), None, metrics)
    }

    fn upgrade(dry_run: bool, phase: Option<UpgradePhase>) -> EKSUpgrade {
        let mut cr = EKSUpgrade::new(
            "prod",
            serde_json::from_value(serde_json::json!({
                "clusterName": "prod",
                "targetVersion": "1.34",
                "region": "ap-northeast-2",
                "upgradeMode": "Forward",
                "dryRun": dry_run,
            }))
            .unwrap(),
        );
        cr.status = Some(EKSUpgradeStatus {
            phase,
            ..EKSUpgradeStatus::default()
        });
        cr
    }

    #[tokio::test]
    async fn test_retry_denied_when_not_failed() {
        let ctx = denying_ctx();
        let cr = upgrade(false, Some(UpgradePhase::Completed));
        let result = retry_upgrade(&ctx, &cr).await.unwrap();
        assert_eq!(result.verdict, Verdict::Blocked);
        assert_eq!(result.details["gate"], "phase");
    }

    #[tokio::test]
    async fn test_promote_denied_when_already_live() {
        let ctx = denying_ctx();
        let cr = upgrade(false, Some(UpgradePhase::Completed));
        let result = promote_dry_run(&ctx, &cr).await.unwrap();
        assert_eq!(result.verdict, Verdict::Blocked);
        assert_eq!(result.details["gate"], "dry-run-state");
    }
}
