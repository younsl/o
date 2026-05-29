//! Alert rule schema. Scope: SBOM component detection only — fires when a
//! matching package/version lands in a workload's SBOM. CVE/severity-based
//! matching is intentionally out of scope (handled by image-registry
//! scanning and runtime detection elsewhere).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Clone, Debug, Default, Deserialize, Serialize, ToSchema)]
pub struct Matchers {
    /// Required for the rule to be useful. Empty value (None) matches every
    /// component, which is rarely intended — the UI should require a value.
    pub package_name: Option<String>,
    /// Optional version constraint (e.g. `<2.17.0`, `>=1.0.0,<2.0.0`).
    pub version_expr: Option<String>,
    /// Empty = match any cluster.
    #[serde(default)]
    pub clusters: Vec<String>,
    pub namespace: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct SlackReceiver {
    pub webhook_url: String,
    pub channel: Option<String>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct Receiver {
    pub name: String,
    pub slack: Option<SlackReceiver>,
}

#[derive(Clone, Debug, Deserialize, Serialize, ToSchema)]
pub struct AlertRule {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub matchers: Matchers,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub annotations: BTreeMap<String, String>,
    pub receivers: Vec<Receiver>,
    #[serde(default)]
    pub cooldown_secs: Option<u64>,
    pub created_at: String,
    pub created_by: String,
    pub updated_at: Option<String>,
    pub updated_by: Option<String>,
}

fn default_true() -> bool {
    true
}

pub fn validate_rule_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() {
        return Err("rule name must not be empty");
    }
    if name.len() > 253 {
        return Err("rule name must be 253 characters or fewer");
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err("rule name may only contain alphanumeric, '-', '_', '.'");
    }
    Ok(())
}

/// Validate a Slack webhook URL. Restricts the destination to Slack's
/// canonical webhook host so an operator can't (accidentally or
/// maliciously) point the alerts subsystem at an arbitrary internal URL,
/// turning the trivy-collector pod into an SSRF probe.
///
/// The trailing slash on the prefix anchors the host boundary, so e.g.
/// `https://hooks.slack.com.attacker.com/...` and
/// `https://hooks.slack.com:8080@evil.com/...` both fail the check.
pub fn validate_webhook_url(url: &str) -> Result<(), &'static str> {
    if url.is_empty() {
        return Err("webhook URL must not be empty");
    }
    if !url.starts_with("https://hooks.slack.com/") {
        return Err("webhook URL must start with https://hooks.slack.com/");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rule_name_ok() {
        assert!(validate_rule_name("log4j-critical").is_ok());
        assert!(validate_rule_name("rule_1.v2").is_ok());
    }

    #[test]
    fn validate_rule_name_rejects_invalid() {
        assert!(validate_rule_name("").is_err());
        assert!(validate_rule_name("has spaces").is_err());
        assert!(validate_rule_name("slash/in/name").is_err());
    }

    #[test]
    fn validate_webhook_url_accepts_canonical() {
        assert!(validate_webhook_url("https://hooks.slack.com/services/T0/B0/secretXXXX").is_ok());
    }

    #[test]
    fn validate_webhook_url_rejects_non_slack_host() {
        // Bare HTTP scheme
        assert!(validate_webhook_url("http://hooks.slack.com/services/foo").is_err());
        // Different host entirely
        assert!(validate_webhook_url("https://evil.com/services/foo").is_err());
        // Subdomain trickery — trailing slash on the prefix prevents
        // `hooks.slack.com.attacker.com` from passing.
        assert!(validate_webhook_url("https://hooks.slack.com.attacker.com/services/foo").is_err());
        // Userinfo trickery — `https://userinfo@host/` style.
        assert!(validate_webhook_url("https://user@hooks.slack.com/services/foo").is_err());
        // Empty / non-URL strings
        assert!(validate_webhook_url("").is_err());
        assert!(validate_webhook_url("not a url").is_err());
    }
}
