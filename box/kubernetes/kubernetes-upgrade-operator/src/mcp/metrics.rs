//! Prometheus metrics for the MCP endpoint.
//!
//! Registered on the operator's existing 8081 registry. Logs carry the
//! per-call audit detail, these carry the aggregates: a rising `denied` rate
//! flags a misconfigured agent or a caller without the token, a flat `hit`
//! rate says the TTL cache is not absorbing the agent's retry pattern, and
//! the duration histogram catches an AWS-backed tool degrading before
//! kagent's own request timeout fires.

use prometheus_client::encoding::EncodeLabelSet;
use prometheus_client::metrics::counter::Counter;
use prometheus_client::metrics::family::Family;
use prometheus_client::metrics::histogram::Histogram;
use prometheus_client::registry::Registry;

/// Buckets sized for tool calls: sub-millisecond static answers up to
/// AWS-backed reads approaching kagent's 30s timeout.
const TOOL_BUCKETS: &[f64] = &[0.001, 0.01, 0.05, 0.1, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0];

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct CallLabels {
    pub tool: String,
    pub result: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct ToolLabels {
    pub tool: String,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
pub struct CacheLabels {
    pub tool: String,
    pub outcome: String,
}

/// MCP metric families.
pub struct McpMetrics {
    pub tool_calls_total: Family<CallLabels, Counter>,
    pub tool_duration_seconds: Family<ToolLabels, Histogram>,
    pub cache_lookups_total: Family<CacheLabels, Counter>,
}

impl McpMetrics {
    /// Create and register the families with the shared registry.
    pub fn new(registry: &mut Registry) -> Self {
        let tool_calls_total = Family::<CallLabels, Counter>::default();
        registry.register(
            "kuo_mcp_tool_calls",
            "MCP tool calls by tool and result",
            tool_calls_total.clone(),
        );

        let tool_duration_seconds = Family::<ToolLabels, Histogram>::new_with_constructor(|| {
            Histogram::new(TOOL_BUCKETS.iter().copied())
        });
        registry.register(
            "kuo_mcp_tool_duration_seconds",
            "MCP tool call duration in seconds",
            tool_duration_seconds.clone(),
        );

        let cache_lookups_total = Family::<CacheLabels, Counter>::default();
        registry.register(
            "kuo_mcp_cache_lookups",
            "MCP cache lookups by tool and outcome",
            cache_lookups_total.clone(),
        );

        Self {
            tool_calls_total,
            tool_duration_seconds,
            cache_lookups_total,
        }
    }

    /// Record one finished call.
    pub fn observe_call(&self, tool: &str, result: &str, seconds: f64) {
        self.tool_calls_total
            .get_or_create(&CallLabels {
                tool: tool.to_string(),
                result: result.to_string(),
            })
            .inc();
        self.tool_duration_seconds
            .get_or_create(&ToolLabels {
                tool: tool.to_string(),
            })
            .observe(seconds);
    }

    /// Record one cache lookup.
    pub fn observe_cache(&self, tool: &str, outcome: super::cache::Outcome) {
        let outcome = match outcome {
            super::cache::Outcome::Hit => "hit",
            super::cache::Outcome::Miss => "miss",
        };
        self.cache_lookups_total
            .get_or_create(&CacheLabels {
                tool: tool.to_string(),
                outcome: outcome.to_string(),
            })
            .inc();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(registry: &Registry) -> String {
        let mut buf = String::new();
        prometheus_client::encoding::text::encode(&mut buf, registry).unwrap();
        buf
    }

    #[test]
    fn test_metrics_register_and_record() {
        let mut registry = Registry::default();
        let metrics = McpMetrics::new(&mut registry);

        metrics.observe_call("explain_phase", "ok", 0.002);
        metrics.observe_call("promote_dry_run", "denied", 0.001);
        metrics.observe_cache("get_cluster_insights", crate::mcp::cache::Outcome::Hit);
        metrics.observe_cache("get_cluster_insights", crate::mcp::cache::Outcome::Miss);

        let buf = encoded(&registry);
        assert!(
            buf.contains(r#"kuo_mcp_tool_calls_total{tool="explain_phase",result="ok"} 1"#)
                || buf.contains(r#"kuo_mcp_tool_calls_total{result="ok",tool="explain_phase"} 1"#),
            "missing call counter: {buf}"
        );
        assert!(buf.contains("kuo_mcp_tool_duration_seconds_bucket"));
        assert!(buf.contains("kuo_mcp_cache_lookups_total"));
        assert!(buf.contains(r#"outcome="hit""#));
    }
}
