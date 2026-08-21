//! Tool implementations behind the MCP handler.
//!
//! The `#[tool]` methods on [`crate::mcp::server::KuoMcp`] stay thin and
//! delegate here, so each tool's logic is testable without the rmcp plumbing.

pub mod addons;
pub mod explain;
pub mod insights;
pub mod mutate;
pub mod nodes;
pub mod status;

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use kube::Api;
use kube::api::ListParams;
use serde_json::json;
use tokio::sync::{Mutex, Semaphore};

use crate::aws::client::AwsClients;
use crate::crd::EKSUpgrade;
use crate::mcp::cache::{Cache, Outcome};
use crate::mcp::metrics::McpMetrics;
use crate::mcp::result::{ToolResult, Verdict};
use crate::notify::SlackNotifier;

/// Concurrent tool calls allowed across the endpoint. Hardcoded until reality
/// demands configuration; excess calls queue and kagent's own request timeout
/// provides the backpressure.
const MAX_CONCURRENT_CALLS: usize = 8;

/// Shared state every tool call runs against.
pub struct McpContext {
    /// Hub-cluster client, the same one the controller uses.
    pub kube: kube::Client,
    /// TTL cache in front of AWS and target-cluster reads.
    pub cache: Cache,
    /// Per-cluster AWS clients, so the STS `AssumeRole` round trip happens
    /// once per cluster rather than once per tool call.
    aws_pool: Mutex<HashMap<String, Arc<AwsClients>>>,
    /// Global concurrency cap.
    pub semaphore: Semaphore,
    /// Slack notifier, best-effort, for `promote_dry_run`.
    pub slack: Option<Arc<SlackNotifier>>,
    /// MCP metric families on the shared registry.
    pub metrics: Arc<McpMetrics>,
}

impl McpContext {
    pub fn new(
        kube: kube::Client,
        cache: Cache,
        slack: Option<Arc<SlackNotifier>>,
        metrics: Arc<McpMetrics>,
    ) -> Self {
        Self {
            kube,
            cache,
            aws_pool: Mutex::new(HashMap::new()),
            semaphore: Semaphore::new(MAX_CONCURRENT_CALLS),
            slack,
            metrics,
        }
    }

    /// AWS clients for one cluster spec, pooled by cluster name.
    ///
    /// The pool lock is held across the client construction deliberately:
    /// two concurrent calls for the same new cluster would otherwise both
    /// run the STS `AssumeRole` round trip the pool exists to avoid.
    pub async fn aws_for(&self, upgrade: &EKSUpgrade) -> Result<Arc<AwsClients>> {
        let spec = &upgrade.spec;
        let mut pool = self.aws_pool.lock().await;
        if let Some(clients) = pool.get(&spec.cluster_name) {
            return Ok(clients.clone());
        }
        let clients =
            Arc::new(AwsClients::new(&spec.region, spec.assume_role_arn.as_deref()).await?);
        pool.insert(spec.cluster_name.clone(), clients.clone());
        drop(pool);
        Ok(clients)
    }

    /// Cached read: return the fresh entry or compute, store, and return it.
    /// Records the hit or miss on the cache metric.
    pub async fn cached(
        &self,
        tool: &str,
        cluster: &str,
        args: &str,
        compute: impl Future<Output = Result<serde_json::Value>>,
    ) -> Result<(serde_json::Value, Outcome)> {
        if let Some(value) = self.cache.get(tool, cluster, args).await {
            self.metrics.observe_cache(tool, Outcome::Hit);
            return Ok((value, Outcome::Hit));
        }
        self.metrics.observe_cache(tool, Outcome::Miss);
        let value = compute.await?;
        self.cache.put(tool, cluster, args, value.clone()).await;
        Ok((value, Outcome::Miss))
    }
}

/// How a tool identified its `EKSUpgrade`, or why it could not.
pub enum Resolved {
    One(Box<EKSUpgrade>),
    /// The error result to return as-is: none exist, or several do and the
    /// caller did not name one. Auto-picking the first match is forbidden;
    /// the worst case is a mutation aimed at the wrong cluster.
    Err(ToolResult),
}

/// Find the `EKSUpgrade` a tool call is about.
///
/// `EKSUpgrade` is cluster-scoped, so `name` alone addresses one. With it
/// omitted, exactly one resource in the cluster resolves. Several return an
/// error listing the candidates so the agent re-calls with a name on its
/// next turn.
pub async fn resolve_upgrade(kube: &kube::Client, name: Option<&str>) -> Result<Resolved> {
    let api: Api<EKSUpgrade> = Api::all(kube.clone());
    let mut items = api.list(&ListParams::default()).await?.items;

    if let Some(wanted) = name {
        items.retain(|cr| cr.metadata.name.as_deref() == Some(wanted));
    }

    match items.len() {
        0 => Ok(Resolved::Err(ToolResult::new(
            "no EKSUpgrade resource matches",
            Verdict::Unknown,
            json!({ "name": name, "hint": "list_upgrades shows what exists" }),
        ))),
        1 => Ok(Resolved::One(Box::new(items.remove(0)))),
        n => {
            let candidates: Vec<String> = items
                .iter()
                .filter_map(|cr| cr.metadata.name.clone())
                .collect();
            Ok(Resolved::Err(ToolResult::new(
                format!("{n} EKSUpgrades exist, specify name"),
                Verdict::Unknown,
                json!({ "candidates": candidates }),
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::metrics::McpMetrics;
    use std::time::Duration;

    fn ctx() -> McpContext {
        let mut registry = prometheus_client::registry::Registry::default();
        let metrics = Arc::new(McpMetrics::new(&mut registry));
        let kube_config = kube::Config::new("http://127.0.0.1:1".parse().unwrap());
        let kube = kube::Client::try_from(kube_config).unwrap();
        McpContext::new(kube, Cache::new(Duration::from_secs(30)), None, metrics)
    }

    #[tokio::test]
    async fn test_cached_returns_hit_on_second_call() {
        let ctx = ctx();
        let (v1, o1) = ctx
            .cached("t", "c", "a", Box::pin(async { Ok(serde_json::json!(1)) }))
            .await
            .unwrap();
        let (v2, o2) = ctx
            .cached(
                "t",
                "c",
                "a",
                Box::pin(async { unreachable!("must be served from cache") }),
            )
            .await
            .unwrap();
        assert_eq!(v1, v2);
        assert_eq!(o1, crate::mcp::cache::Outcome::Miss);
        assert_eq!(o2, crate::mcp::cache::Outcome::Hit);
    }
}
