//! The shared result shape every MCP tool returns.
//!
//! One JSON object per call: a one-line `summary` the agent can quote into
//! Slack, a `verdict` it can branch on without parsing prose, and the
//! structured evidence in `details`. Lists inside `details` are capped by the
//! producing tool, which sets `truncated` when the cap bites.

use rmcp::model::{CallToolResult, ContentBlock};
use serde::{Deserialize, Serialize};

/// Entries kept in any list inside `details`. An agent that pulls hundreds of
/// rows into its context wastes the budget it needs for the answer.
pub const LIST_CAP: usize = 50;

/// The decision field of a tool result.
// Warn, Blocked, and Failed are constructed by the read tools that land in
// the next implementation steps; the enum is the wire contract and ships
// whole so kagent-side prompts can rely on it from the first release.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    /// Nothing needs attention.
    Ok,
    /// Worth flagging, does not block.
    Warn,
    /// A gate is closed: the upgrade cannot proceed until this is resolved.
    Blocked,
    /// Something already went wrong.
    Failed,
    /// The read itself did not happen (throttling, missing data); never treat
    /// as healthy.
    Unknown,
}

/// The JSON payload of every tool response.
#[derive(Debug, Serialize, Deserialize)]
pub struct ToolResult {
    /// One line the model can quote verbatim.
    pub summary: String,
    /// The branchable decision.
    pub verdict: Verdict,
    /// Cluster the answer is about, absent for cluster-agnostic tools.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cluster: Option<String>,
    /// Tool-specific evidence.
    pub details: serde_json::Value,
    /// True when a list inside `details` was cut at [`LIST_CAP`].
    pub truncated: bool,
}

impl ToolResult {
    /// A result about no cluster in particular.
    pub fn new(summary: impl Into<String>, verdict: Verdict, details: serde_json::Value) -> Self {
        Self {
            summary: summary.into(),
            verdict,
            cluster: None,
            details,
            truncated: false,
        }
    }

    /// Render into the single text content block MCP expects.
    pub fn into_call_tool_result(self) -> CallToolResult {
        let json = serde_json::to_string(&self).unwrap_or_else(|e| {
            // Serialization of these plain structs cannot realistically fail;
            // if it somehow does, hand the agent the reason instead of nothing.
            format!("{{\"summary\":\"result serialization failed: {e}\",\"verdict\":\"unknown\",\"details\":{{}},\"truncated\":false}}")
        });
        CallToolResult::success(vec![ContentBlock::text(json)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_verdict_serializes_lowercase() {
        assert_eq!(serde_json::to_string(&Verdict::Ok).unwrap(), "\"ok\"");
        assert_eq!(
            serde_json::to_string(&Verdict::Blocked).unwrap(),
            "\"blocked\""
        );
        assert_eq!(
            serde_json::to_string(&Verdict::Unknown).unwrap(),
            "\"unknown\""
        );
    }

    #[test]
    fn test_tool_result_shape() {
        let result = ToolResult::new("all good", Verdict::Ok, serde_json::json!({"checks": []}));
        let value = serde_json::to_value(&result).unwrap();
        assert_eq!(value["summary"], "all good");
        assert_eq!(value["verdict"], "ok");
        assert_eq!(value["truncated"], false);
        assert!(value.get("cluster").is_none(), "absent cluster is omitted");
    }

    #[test]
    fn test_into_call_tool_result_is_single_text_block() {
        let result = ToolResult::new("s", Verdict::Warn, serde_json::json!({}));
        let call = result.into_call_tool_result();
        assert_ne!(call.is_error, Some(true));
        assert_eq!(call.content.len(), 1);
        let text = call.content[0].as_text().expect("text block").text.clone();
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["verdict"], "warn");
    }
}
