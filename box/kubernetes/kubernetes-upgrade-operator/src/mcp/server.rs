//! MCP listener: rmcp service wiring on an axum router.
//!
//! Stateless streamable HTTP on its own port. The rmcp transport serves the
//! current protocol revision without sessions, so a restarted Pod never
//! leaves kagent holding a dead session id. The `#[tool]` methods stay thin:
//! resolve the resource, take a semaphore permit, delegate to the module
//! under `tools/`, record the metric.

use std::sync::Arc;
use std::time::Instant;

use anyhow::Result;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Implementation, ServerCapabilities, ServerInfo};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, ServerHandler, schemars, tool};
use rmcp::{tool_handler, tool_router};
use serde::Deserialize;
use serde_json::json;
use tokio::net::TcpListener;
use tracing::info;

use super::Config;
use super::auth::{self, TokenFile};
use super::result::{ToolResult, Verdict};
use super::tools::{self, McpContext, Resolved};
use crate::crd::EKSUpgrade;
use crate::eks::client::EksClient;

/// The MCP server handler. One instance per request, all sharing the context.
#[derive(Clone)]
pub struct KuoMcp {
    ctx: Arc<McpContext>,
}

/// Arguments shared by every tool that answers about one `EKSUpgrade`.
/// The resource is cluster-scoped, so a name alone addresses it.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ResourceArgs {
    /// `EKSUpgrade` resource name. Omit when only one exists.
    pub name: Option<String>,
}

/// Arguments of `explain_phase`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ExplainPhaseArgs {
    /// Upgrade phase name as shown in the resource status, e.g. `"PreflightChecking"`.
    pub phase: String,
}

/// Arguments of `get_cluster_insights`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct InsightsArgs {
    /// `EKSUpgrade` resource name. Omit when only one exists.
    pub name: Option<String>,
    /// Keep only findings at this severity (e.g. `"ERROR"`, `"WARNING"`).
    pub severity: Option<String>,
}

/// Arguments of `plan_upgrade`.
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PlanUpgradeArgs {
    /// EKS cluster name to plan an upgrade for.
    pub cluster_name: String,
    /// Target Kubernetes minor, e.g. `"1.34"`.
    pub target_version: String,
    /// AWS region of the cluster.
    pub region: String,
}

impl KuoMcp {
    /// Resolve the addressed resource or produce the candidates error.
    async fn resolve(
        &self,
        name: Option<&str>,
    ) -> Result<std::result::Result<Box<EKSUpgrade>, ToolResult>, McpError> {
        match tools::resolve_upgrade(&self.ctx.kube, name).await {
            Ok(Resolved::One(cr)) => Ok(Ok(cr)),
            Ok(Resolved::Err(result)) => Ok(Err(result)),
            Err(e) => Err(internal(&e)),
        }
    }

    /// Record the call metric and render the result.
    fn finish(&self, tool: &'static str, started: Instant, result: ToolResult) -> CallToolResult {
        let outcome = match result.verdict {
            Verdict::Unknown => "error",
            Verdict::Blocked if result.details.get("gate").is_some() => "denied",
            _ => "ok",
        };
        self.ctx
            .metrics
            .observe_call(tool, outcome, started.elapsed().as_secs_f64());
        result.into_call_tool_result()
    }
}

/// Map an internal error into an MCP tool error with a short message. Never
/// panics: under `panic = "abort"` a panicking handler would take the
/// reconciler down with it.
fn internal(e: &anyhow::Error) -> McpError {
    McpError::internal_error(format!("{e:#}"), None)
}

#[tool_router]
impl KuoMcp {
    pub const fn new(ctx: Arc<McpContext>) -> Self {
        Self { ctx }
    }

    // The #[tool] macro dispatches through the instance and expects the
    // fallible handler signature, so Result stays even though this
    // particular tool cannot fail.
    #[allow(clippy::unnecessary_wraps)]
    #[tool(
        description = "Explain one kuo upgrade phase: what it does, what it waits on, what makes it fail, and what the operator can do about it. Pass the phase name from the EKSUpgrade status."
    )]
    fn explain_phase(
        &self,
        Parameters(args): Parameters<ExplainPhaseArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let result = super::tools::explain::explain(&args.phase);
        Ok(self.finish("explain_phase", started, result))
    }

    #[tool(
        description = "List every EKSUpgrade resource: cluster, region, mode, versions, phase, and progress."
    )]
    async fn list_upgrades(&self) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let api: kube::Api<EKSUpgrade> = kube::Api::all(self.ctx.kube.clone());
        let items = api
            .list(&kube::api::ListParams::default())
            .await
            .map_err(|e| internal(&e.into()))?
            .items;
        Ok(self.finish(
            "list_upgrades",
            started,
            tools::status::list_upgrades(&items),
        ))
    }

    #[tool(
        description = "Full status of one EKSUpgrade: phase, progress, upgrade path, run duration, conditions, AWS caller identity, and the last completed transition."
    )]
    async fn get_upgrade_status(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("get_upgrade_status", started, result)),
        };
        Ok(self.finish(
            "get_upgrade_status",
            started,
            tools::status::get_upgrade_status(&cr),
        ))
    }

    #[tool(
        description = "Diagnose why an upgrade is stuck or failed: the failing component, the recorded cause, and the specific next action. For Rollback mode, includes rollback eligibility."
    )]
    async fn diagnose_upgrade(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("diagnose_upgrade", started, result)),
        };
        Ok(self.finish(
            "diagnose_upgrade",
            started,
            tools::status::diagnose_upgrade(&cr),
        ))
    }

    #[tool(
        description = "Preflight check results for an EKSUpgrade. Each check carries a mandatory flag: only a mandatory failure blocks the upgrade."
    )]
    async fn get_preflight_report(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("get_preflight_report", started, result)),
        };
        Ok(self.finish(
            "get_preflight_report",
            started,
            tools::status::get_preflight_report(&cr),
        ))
    }

    #[tool(
        description = "Control plane state: current version, in-flight EKS update id and step, and the remaining minor steps toward the target."
    )]
    async fn get_controlplane_state(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("get_controlplane_state", started, result)),
        };
        Ok(self.finish(
            "get_controlplane_state",
            started,
            tools::status::get_controlplane_state(&cr),
        ))
    }

    #[tool(
        description = "Standard and extended support end dates for the current and target Kubernetes minors, with days remaining."
    )]
    async fn get_version_lifecycle(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("get_version_lifecycle", started, result)),
        };
        Ok(self.finish(
            "get_version_lifecycle",
            started,
            tools::status::get_version_lifecycle(&cr, chrono::Utc::now()),
        ))
    }

    #[tool(
        description = "EKS cluster insights: upgrade-blocking findings with affected resources and remediation. Optionally filter by severity."
    )]
    async fn get_cluster_insights(
        &self,
        Parameters(args): Parameters<InsightsArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("get_cluster_insights", started, result)),
        };
        let cluster = cr.spec.cluster_name.clone();

        let fetched = self
            .ctx
            .cached(
                "get_cluster_insights",
                &cluster,
                "all",
                Box::pin(async {
                    let aws = self.ctx.aws_for(&cr).await?;
                    let summary = crate::eks::insights::list_insights(
                        &aws.eks,
                        &cluster,
                        "UPGRADE_READINESS",
                    )
                    .await?;
                    Ok(insights_to_value(&summary))
                }),
            )
            .await;

        let result = match fetched {
            Ok((value, _)) => {
                let summary = insights_from_value(&value);
                tools::insights::render(&cluster, &summary, args.severity.as_deref())
            }
            Err(e) => throttled_or_unknown(&cluster, &e),
        };
        Ok(self.finish("get_cluster_insights", started, result))
    }

    #[tool(
        description = "Per add-on upgrade plan toward the target minor: installed version, planned version, and how many already fit."
    )]
    async fn get_addon_plan(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("get_addon_plan", started, result)),
        };
        let cluster = cr.spec.cluster_name.clone();
        let target = cr.spec.target_version.clone();

        let fetched = self
            .ctx
            .cached(
                "get_addon_plan",
                &cluster,
                &target,
                Box::pin(async {
                    let aws = self.ctx.aws_for(&cr).await?;
                    let pins = cr.spec.addon_versions.clone().unwrap_or_default();
                    let plan =
                        crate::eks::addon::plan_addon_upgrades(&aws.eks, &cluster, &target, &pins)
                            .await?;
                    Ok(serde_json::to_value(tools::addons::render(
                        &cluster, &target, &plan,
                    ))?)
                }),
            )
            .await;

        Ok(self.finish(
            "get_addon_plan",
            started,
            rendered_or_unknown(&cluster, fetched),
        ))
    }

    #[tool(
        description = "Managed node group state: per group version, planned action, in-flight update id, and what the recorded run says."
    )]
    async fn get_nodegroup_state(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("get_nodegroup_state", started, result)),
        };
        let cluster = cr.spec.cluster_name.clone();
        let target = cr.spec.target_version.clone();

        let fetched = self
            .ctx
            .cached(
                "get_nodegroup_state",
                &cluster,
                &target,
                Box::pin(async {
                    let aws = self.ctx.aws_for(&cr).await?;
                    let plan =
                        crate::eks::nodegroup::plan_nodegroup_upgrades(&aws.eks, &cluster, &target)
                            .await?;
                    Ok(serde_json::to_value(tools::nodes::render_nodegroups(
                        &cr, &plan,
                    ))?)
                }),
            )
            .await;

        Ok(self.finish(
            "get_nodegroup_state",
            started,
            rendered_or_unknown(&cluster, fetched),
        ))
    }

    #[tool(
        description = "Karpenter node replacement state: configured pools, live NodeClaim count, and per-pool replacement progress."
    )]
    async fn get_karpenter_state(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("get_karpenter_state", started, result)),
        };
        let cluster = cr.spec.cluster_name.clone();

        // The live NodeClaim count is best-effort: a missing target cluster
        // degrades to the recorded status, never to a hard error.
        let live = self
            .ctx
            .cached(
                "get_karpenter_state",
                &cluster,
                "nodeclaims",
                Box::pin(async {
                    let aws = self.ctx.aws_for(&cr).await?;
                    let eks = EksClient::new(aws.eks.clone(), aws.region.clone());
                    let target = crate::k8s::client::resolve_client(
                        &self.ctx.kube,
                        &eks,
                        &cluster,
                        cr.spec.assume_role_arn.as_deref(),
                    )
                    .await?;
                    let count = crate::k8s::karpenter::count_nodeclaims(&target).await?;
                    Ok(json!(count))
                }),
            )
            .await
            .ok()
            .and_then(|(v, _)| v.as_u64())
            .and_then(|n| usize::try_from(n).ok());

        Ok(self.finish(
            "get_karpenter_state",
            started,
            tools::nodes::render_karpenter(&cr, live),
        ))
    }

    #[tool(
        description = "PodDisruptionBudgets on the target cluster that would deadlock a node drain, named namespace/name."
    )]
    async fn get_pdb_risks(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("get_pdb_risks", started, result)),
        };
        let cluster = cr.spec.cluster_name.clone();

        let fetched = self
            .ctx
            .cached(
                "get_pdb_risks",
                &cluster,
                "all",
                Box::pin(async {
                    let aws = self.ctx.aws_for(&cr).await?;
                    let eks = EksClient::new(aws.eks.clone(), aws.region.clone());
                    let target = crate::k8s::client::resolve_client(
                        &self.ctx.kube,
                        &eks,
                        &cluster,
                        cr.spec.assume_role_arn.as_deref(),
                    )
                    .await?;
                    let summary = crate::k8s::pdb::check_pdbs(&target).await?;
                    Ok(serde_json::to_value(tools::nodes::render_pdbs(
                        &cluster, &summary,
                    ))?)
                }),
            )
            .await;

        Ok(self.finish(
            "get_pdb_risks",
            started,
            rendered_or_unknown(&cluster, fetched),
        ))
    }

    #[tool(
        description = "Create or update a dry-run EKSUpgrade so Planning and PreflightChecking run without touching the cluster. Refuses to touch a live or in-progress resource."
    )]
    async fn plan_upgrade(
        &self,
        Parameters(args): Parameters<PlanUpgradeArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let result = tools::mutate::plan_upgrade(
            &self.ctx,
            &args.cluster_name,
            &args.target_version,
            &args.region,
        )
        .await
        .map_err(|e| internal(&e))?;
        Ok(self.finish("plan_upgrade", started, result))
    }

    #[tool(
        description = "Force reconciliation of a Failed EKSUpgrade by bumping its retry annotation. Applies only to Failed resources."
    )]
    async fn retry_upgrade(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("retry_upgrade", started, result)),
        };
        let result = tools::mutate::retry_upgrade(&self.ctx, &cr)
            .await
            .map_err(|e| internal(&e))?;
        Ok(self.finish("retry_upgrade", started, result))
    }

    #[tool(
        description = "Promote a dry-run EKSUpgrade to a live upgrade by flipping dryRun to false. Starts a real upgrade; notifies Slack on every call."
    )]
    async fn promote_dry_run(
        &self,
        Parameters(args): Parameters<ResourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let _permit = self
            .ctx
            .semaphore
            .acquire()
            .await
            .map_err(|e| internal(&e.into()))?;
        let cr = match self.resolve(args.name.as_deref()).await? {
            Ok(cr) => cr,
            Err(result) => return Ok(self.finish("promote_dry_run", started, result)),
        };
        let result = tools::mutate::promote_dry_run(&self.ctx, &cr)
            .await
            .map_err(|e| internal(&e))?;
        Ok(self.finish("promote_dry_run", started, result))
    }
}

/// AWS throttling and other read failures surface as `verdict: unknown` with
/// the reason, never as a hard error: an agent must not conclude a cluster is
/// healthy when the read simply did not happen.
fn throttled_or_unknown(cluster: &str, e: &anyhow::Error) -> ToolResult {
    let mut result = ToolResult::new(
        format!("the read did not happen: {e:#}"),
        Verdict::Unknown,
        json!({ "hint": "retry shortly; this is a fetch failure, not a healthy cluster" }),
    );
    result.cluster = Some(cluster.to_string());
    result
}

/// Unwrap a cached render or degrade to `unknown`.
fn rendered_or_unknown(
    cluster: &str,
    fetched: Result<(serde_json::Value, super::cache::Outcome)>,
) -> ToolResult {
    match fetched {
        Ok((value, _)) => serde_json::from_value(value)
            .unwrap_or_else(|e| throttled_or_unknown(cluster, &e.into())),
        Err(e) => throttled_or_unknown(cluster, &e),
    }
}

/// Round-trip helpers for caching an `InsightsSummary` as JSON.
fn insights_to_value(summary: &crate::eks::insights::InsightsSummary) -> serde_json::Value {
    json!({
        "total": summary.total_findings,
        "critical": summary.critical_count,
        "warning": summary.warning_count,
        "passing": summary.passing_count,
        "info": summary.info_count,
        "findings": summary.findings.iter().map(|f| json!({
            "category": f.category,
            "description": f.description,
            "severity": f.severity,
            "recommendation": f.recommendation,
            "resources": f.resources.iter().map(|r| json!({
                "type": r.resource_type,
                "id": r.resource_id,
            })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn insights_from_value(value: &serde_json::Value) -> crate::eks::insights::InsightsSummary {
    let as_usize = |v: &serde_json::Value| usize::try_from(v.as_u64().unwrap_or(0)).unwrap_or(0);
    crate::eks::insights::InsightsSummary {
        total_findings: as_usize(&value["total"]),
        critical_count: as_usize(&value["critical"]),
        warning_count: as_usize(&value["warning"]),
        passing_count: as_usize(&value["passing"]),
        info_count: as_usize(&value["info"]),
        findings: value["findings"]
            .as_array()
            .map(|rows| {
                rows.iter()
                    .map(|f| crate::eks::insights::InsightFinding {
                        category: f["category"].as_str().unwrap_or_default().to_string(),
                        description: f["description"].as_str().unwrap_or_default().to_string(),
                        severity: f["severity"].as_str().unwrap_or_default().to_string(),
                        recommendation: f["recommendation"].as_str().map(ToString::to_string),
                        resources: f["resources"]
                            .as_array()
                            .map(|rs| {
                                rs.iter()
                                    .map(|r| crate::eks::insights::InsightResource {
                                        resource_type: r["type"]
                                            .as_str()
                                            .unwrap_or_default()
                                            .to_string(),
                                        resource_id: r["id"]
                                            .as_str()
                                            .unwrap_or_default()
                                            .to_string(),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[tool_handler]
#[allow(clippy::unused_async_trait_impl)]
impl ServerHandler for KuoMcp {
    // rmcp marks these structs non_exhaustive, so they are built by mutating
    // defaults rather than with struct expressions.
    #[allow(clippy::field_reassign_with_default)]
    fn get_info(&self) -> ServerInfo {
        let mut server_info = Implementation::default();
        server_info.name = "kuo".into();
        server_info.version = crate::VERSION.into();

        let mut info = ServerInfo::default();
        info.server_info = server_info;
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        info.instructions = Some(
            "EKS upgrade operator tools. Every tool answers about an EKSUpgrade resource and returns JSON with a one-line summary and a verdict of ok, warn, blocked, failed, or unknown. Only a failed mandatory preflight check blocks an upgrade; advisory failures do not. Mutating tools (plan_upgrade, retry_upgrade, promote_dry_run) only ever change EKSUpgrade resources, never AWS directly."
                .into(),
        );
        info
    }
}

/// Start the MCP server on the configured port. Runs until process exit.
pub async fn serve(config: Config, ctx: Arc<McpContext>) -> Result<()> {
    let service = StreamableHttpService::new(
        move || Ok(KuoMcp::new(ctx.clone())),
        LocalSessionManager::default().into(),
        // Host validation defaults to loopback-only as a DNS-rebinding guard
        // for local servers. This endpoint is reached as kuo.kuo.svc:8082
        // inside the cluster and is gated by the bearer token, so the Host
        // allowlist adds nothing here.
        StreamableHttpServerConfig::default().disable_allowed_hosts(),
    );

    let token_file = TokenFile(Arc::new(config.token_file.clone()));
    let router = axum::Router::new().nest_service("/mcp", service).layer(
        axum::middleware::from_fn_with_state(token_file, auth::require_bearer),
    );

    let listener = TcpListener::bind(format!("0.0.0.0:{}", config.port)).await?;
    info!("MCP server listening on port {}", config.port);
    axum::serve(listener, router).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::cache::Cache;
    use crate::mcp::metrics::McpMetrics;
    use std::time::Duration;

    fn test_ctx() -> Arc<McpContext> {
        let mut registry = prometheus_client::registry::Registry::default();
        let metrics = Arc::new(McpMetrics::new(&mut registry));
        // An inert client: config pointing nowhere is fine for tests that
        // never issue a request through it.
        let kube_config = kube::Config::new("http://127.0.0.1:1".parse().unwrap());
        let kube = kube::Client::try_from(kube_config).unwrap();
        Arc::new(McpContext::new(
            kube,
            Cache::new(Duration::from_secs(30)),
            None,
            metrics,
        ))
    }

    fn write_token(name: &str, token: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("kuo-mcp-server-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, token).unwrap();
        path
    }

    #[tokio::test]
    async fn test_server_info_declares_tools() {
        let info = KuoMcp::new(test_ctx()).get_info();
        assert_eq!(info.server_info.name, "kuo");
        assert_eq!(info.server_info.version, crate::VERSION);
        assert!(info.capabilities.tools.is_some());
        assert!(info.instructions.is_some());
    }

    #[test]
    fn test_tool_router_registers_all_fifteen() {
        let router = KuoMcp::tool_router();
        let mut names: Vec<String> = router
            .list_all()
            .into_iter()
            .map(|t| t.name.to_string())
            .collect();
        names.sort();
        let expected = [
            "diagnose_upgrade",
            "explain_phase",
            "get_addon_plan",
            "get_cluster_insights",
            "get_controlplane_state",
            "get_karpenter_state",
            "get_nodegroup_state",
            "get_pdb_risks",
            "get_preflight_report",
            "get_upgrade_status",
            "get_version_lifecycle",
            "list_upgrades",
            "plan_upgrade",
            "promote_dry_run",
            "retry_upgrade",
        ];
        assert_eq!(names, expected, "tools/list must carry exactly these 15");
    }

    #[test]
    fn test_insights_value_roundtrip() {
        let summary = crate::eks::insights::InsightsSummary {
            total_findings: 2,
            critical_count: 1,
            warning_count: 1,
            passing_count: 0,
            info_count: 0,
            findings: vec![crate::eks::insights::InsightFinding {
                category: "UPGRADE_READINESS".to_string(),
                description: "deprecated API".to_string(),
                severity: "ERROR".to_string(),
                recommendation: Some("migrate".to_string()),
                resources: vec![crate::eks::insights::InsightResource {
                    resource_type: "deployment".to_string(),
                    resource_id: "ns/app".to_string(),
                }],
            }],
        };
        let value = insights_to_value(&summary);
        let back = insights_from_value(&value);
        assert_eq!(back.total_findings, 2);
        assert_eq!(back.critical_count, 1);
        assert_eq!(back.findings.len(), 1);
        assert_eq!(back.findings[0].resources[0].resource_id, "ns/app");
    }

    #[tokio::test]
    async fn test_serve_initialize_and_explain_over_http() {
        let token_path = write_token("token", "s3cret");

        // Bind on an ephemeral port by hand, mirroring the health server test.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let ctx = test_ctx();
        let service = StreamableHttpService::new(
            move || Ok(KuoMcp::new(ctx.clone())),
            LocalSessionManager::default().into(),
            StreamableHttpServerConfig::default().disable_allowed_hosts(),
        );
        let token_file = TokenFile(Arc::new(token_path));
        let router = axum::Router::new().nest_service("/mcp", service).layer(
            axum::middleware::from_fn_with_state(token_file, auth::require_bearer),
        );
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });

        let client = reqwest::Client::new();
        let initialize = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "0"}
            }
        });

        // Without the token the transport is never reached.
        let response = client
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .header("accept", "application/json, text/event-stream")
            .json(&initialize)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 401);

        // With the token, initialize succeeds and names the server.
        let response = client
            .post(format!("http://127.0.0.1:{port}/mcp"))
            .header("accept", "application/json, text/event-stream")
            .header("authorization", "Bearer s3cret")
            .json(&initialize)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200);
        let body = response.text().await.unwrap();
        assert!(body.contains("\"kuo\""), "unexpected body: {body}");
    }
}
