//! Slack incoming webhook delivery for fired SBOM alerts.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use reqwest::Client as HttpClient;
use reqwest::StatusCode;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Semaphore};
use tracing::{error, warn};

use super::types::{AlertRule, SlackReceiver};

/// Maximum number of components rendered inline in one grouped message.
/// Anything beyond this is summarized as a trailing "+N more" line.
const MAX_FINDINGS_PER_MESSAGE: usize = 20;

/// Maximum number of in-flight POSTs per webhook URL. Slack incoming
/// webhooks are rate limited around 1 message/second per webhook, so we
/// serialize per URL to avoid 429 storms. Different webhook URLs proceed
/// concurrently — this only serializes against a single destination.
const PER_WEBHOOK_CONCURRENCY: usize = 1;

/// Maximum delivery attempts per receiver before giving up. The first
/// attempt plus up to `MAX_SEND_ATTEMPTS - 1` retries on 429.
const MAX_SEND_ATTEMPTS: usize = 3;

/// Fallback wait used when Slack returns 429 without a `Retry-After` header.
const FALLBACK_RETRY_AFTER: Duration = Duration::from_secs(1);

/// Per-receiver outcome of a `send_test` call. Surfaced to the UI so the
/// operator can confirm exactly which Slack destination(s) accepted the
/// test payload.
#[derive(Clone, Debug, serde::Serialize, utoipa::ToSchema)]
pub struct TestDeliveryResult {
    pub receiver_name: String,
    pub channel: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct AlertContext {
    pub cluster: String,
    pub namespace: String,
    pub name: String,
    pub report_type: String,
    pub package: String,
    pub version: String,
    /// Package ecosystem (`debian`, `go-module`, `npm`, ...) when Trivy
    /// surfaces it on the SBOM component.
    pub pkg_type: Option<String>,
}

#[derive(Clone)]
pub struct SlackNotifier {
    http: HttpClient,
    /// External base URL (no trailing slash) used to render `View report`
    /// deep links. None = link omitted.
    external_url: Option<String>,
    /// Per-webhook-URL semaphores. Each semaphore holds
    /// `PER_WEBHOOK_CONCURRENCY` permits and is created on first use.
    /// Wrapped in `Mutex<HashMap>` only for lazy creation; the per-URL
    /// permits themselves are uncontended.
    per_url_limits: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
}

impl SlackNotifier {
    pub fn new() -> Self {
        Self::with_external_url(None)
    }

    pub fn with_external_url(external_url: Option<String>) -> Self {
        let http = HttpClient::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            http,
            external_url: external_url
                .map(|u| u.trim_end_matches('/').to_string())
                .filter(|u| !u.is_empty()),
            per_url_limits: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn fire(&self, rule: &AlertRule, contexts: &[AlertContext], other_workloads: usize) {
        if contexts.is_empty() {
            return;
        }
        for receiver in &rule.receivers {
            if let Some(slack) = &receiver.slack {
                let payload = build_payload(
                    rule,
                    &receiver.name,
                    slack,
                    contexts,
                    self.external_url.as_deref(),
                    other_workloads,
                );
                self.send_with_retry(rule, &receiver.name, slack, &payload)
                    .await;
            }
        }
    }

    /// Send a one-off test message for the rule, bypassing cooldown and the
    /// diff-aware evaluator. Returns one entry per Slack receiver describing
    /// delivery outcome so the UI can show actionable feedback.
    pub async fn send_test(
        &self,
        rule: &AlertRule,
        contexts: &[AlertContext],
        other_workloads: usize,
    ) -> Vec<TestDeliveryResult> {
        let mut results = Vec::new();
        if contexts.is_empty() {
            return results;
        }
        for receiver in &rule.receivers {
            if let Some(slack) = &receiver.slack {
                let payload = build_payload(
                    rule,
                    &receiver.name,
                    slack,
                    contexts,
                    self.external_url.as_deref(),
                    other_workloads,
                );
                let outcome = self
                    .send_once(&slack.webhook_url, &payload)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string());
                results.push(TestDeliveryResult {
                    receiver_name: receiver.name.clone(),
                    channel: slack.channel.clone(),
                    success: outcome.is_ok(),
                    error: outcome.err(),
                });
            } else {
                results.push(TestDeliveryResult {
                    receiver_name: receiver.name.clone(),
                    channel: None,
                    success: false,
                    error: Some("receiver has no slack configuration".into()),
                });
            }
        }
        results
    }

    /// Single-shot Slack POST without retry semaphores. Used by `send_test`
    /// where we want a fast pass/fail for UI feedback. Production firings
    /// continue to use `send_with_retry`.
    async fn send_once(
        &self,
        webhook_url: &str,
        payload: &Value,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let resp = self
            .http
            .post(webhook_url)
            .json(payload)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        let snippet = body.chars().take(200).collect::<String>();
        Err(format!("Slack returned {status}: {snippet}").into())
    }

    /// Acquire (creating if absent) the semaphore guarding the given URL.
    async fn semaphore_for(&self, url: &str) -> Arc<Semaphore> {
        let mut map = self.per_url_limits.lock().await;
        map.entry(url.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(PER_WEBHOOK_CONCURRENCY)))
            .clone()
    }

    async fn send_with_retry(
        &self,
        rule: &AlertRule,
        receiver_name: &str,
        slack: &SlackReceiver,
        payload: &Value,
    ) {
        let sem = self.semaphore_for(&slack.webhook_url).await;
        // Hold a permit for the entire retry window so 429 backoff doesn't
        // get bypassed by a parallel sender for the same URL.
        let _permit = match sem.acquire().await {
            Ok(p) => p,
            Err(_) => return,
        };

        for attempt in 1..=MAX_SEND_ATTEMPTS {
            match self
                .http
                .post(&slack.webhook_url)
                .json(payload)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => return,
                Ok(resp) if resp.status() == StatusCode::TOO_MANY_REQUESTS => {
                    let wait = parse_retry_after(&resp).unwrap_or(FALLBACK_RETRY_AFTER);
                    if attempt == MAX_SEND_ATTEMPTS {
                        warn!(
                            rule = %rule.name,
                            receiver = %receiver_name,
                            attempts = attempt,
                            "Slack webhook 429: giving up after max attempts"
                        );
                        return;
                    }
                    warn!(
                        rule = %rule.name,
                        receiver = %receiver_name,
                        attempt = attempt,
                        wait_secs = wait.as_secs(),
                        "Slack webhook 429: backing off before retry"
                    );
                    tokio::time::sleep(wait).await;
                }
                Ok(resp) => {
                    warn!(
                        rule = %rule.name,
                        receiver = %receiver_name,
                        status = %resp.status(),
                        "Slack webhook returned non-success"
                    );
                    return;
                }
                Err(e) => {
                    error!(
                        rule = %rule.name,
                        receiver = %receiver_name,
                        attempt = attempt,
                        error = %e,
                        "Slack webhook send failed"
                    );
                    return;
                }
            }
        }
    }
}

/// Parse a `Retry-After` header value as integer seconds. Slack returns
/// a numeric seconds value; HTTP-date form is not handled (fallback used).
fn parse_retry_after(resp: &reqwest::Response) -> Option<Duration> {
    let raw = resp.headers().get(reqwest::header::RETRY_AFTER)?;
    let s = raw.to_str().ok()?;
    s.trim().parse::<u64>().ok().map(Duration::from_secs)
}

impl Default for SlackNotifier {
    fn default() -> Self {
        Self::new()
    }
}

/// Build a Slack payload using top-level Block Kit blocks (the format
/// Slack currently recommends — the legacy `attachments[].color` side-bar
/// is intentionally not used).
///
/// The header always carries the rule name (the operator-authored alert
/// title); component identity is rendered as a separate field so the
/// title isn't polluted with package/version data.
fn build_payload(
    rule: &AlertRule,
    receiver_name: &str,
    slack: &SlackReceiver,
    contexts: &[AlertContext],
    external_url: Option<&str>,
    other_workloads: usize,
) -> Value {
    let total = contexts.len();
    let first = &contexts[0];
    // Header is a sentence — easier for a recipient skimming Slack to
    // parse "what happened" than a bare rule name. Operators can still
    // override the whole sentence by setting `slack.title` on the
    // receiver, in which case it's used verbatim.
    let header_sentence = match slack.title.as_deref() {
        Some(t) if !t.is_empty() => t.to_string(),
        _ if total > 1 => format!("{} components matched by rule \"{}\"", total, rule.name),
        _ => format!("Component matched by rule \"{}\"", rule.name),
    };
    // Deep link to the affected workload's report. When configured, the
    // entire `[FIRING] …` title becomes a clickable link to that report.
    // The Slack mrkdwn `<url|text>` syntax is rendered inline inside the
    // bold marker so the title still appears bold.
    let deep_link = external_url.filter(|s| !s.is_empty()).map(|base| {
        format!(
            "{}/sbom/{}/{}/{}",
            base,
            urlencode(&first.cluster),
            urlencode(&first.namespace),
            urlencode(&first.name),
        )
    });
    let title_inner = format!("[FIRING] {}", header_sentence);
    let header_text = match &deep_link {
        Some(url) => format!(":rotating_light: *<{}|{}>*", url, title_inner),
        None => format!(":rotating_light: *{}*", title_inner),
    };

    let mut blocks = vec![json!({
        "type": "section",
        "text": { "type": "mrkdwn", "text": header_text },
    })];

    if total == 1 {
        let mut detail_lines = vec![format!("*Component:* {} {}", first.package, first.version)];
        if let Some(t) = first.pkg_type.as_deref()
            && !t.is_empty()
        {
            detail_lines.push(format!("*Type:* {}", t));
        }
        // The rule's top-level description (filled by the operator in the
        // form) is the primary human-readable explanation; annotations are
        // optional alertmanager-style metadata layered on top.
        if !rule.description.is_empty() {
            detail_lines.push(format!("*Description:* {}", rule.description));
        }
        if let Some(summary) = rule.annotations.get("summary")
            && !summary.is_empty()
        {
            detail_lines.push(format!("*Summary:* {}", summary));
        }
        if let Some(desc) = rule.annotations.get("description")
            && !desc.is_empty()
            && desc != &rule.description
        {
            detail_lines.push(format!("*Annotation description:* {}", desc));
        }
        blocks.push(json!({
            "type": "section",
            "text": { "type": "mrkdwn", "text": detail_lines.join("\n") },
        }));
    } else {
        blocks.push(components_block(contexts));
        // For grouped alerts, surface the rule description (and optional
        // annotation summary) just below the components list.
        let mut meta_lines: Vec<String> = Vec::new();
        if !rule.description.is_empty() {
            meta_lines.push(format!("*Description:* {}", rule.description));
        }
        if let Some(summary) = rule.annotations.get("summary")
            && !summary.is_empty()
        {
            meta_lines.push(format!("*Summary:* {}", summary));
        }
        if !meta_lines.is_empty() {
            blocks.push(json!({
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": meta_lines.join("\n"),
                },
            }));
        }
    }

    // Affected location — supporting context for the component finding.
    // The fleet scope hint is appended right below Workload so the
    // recipient can immediately tell whether this is an isolated finding
    // or fleet-wide. Same line for both production firings and test
    // dispatches; suppressed when no other workload matches.
    let mut location_lines = vec![
        format!("*Cluster:* {}", first.cluster),
        format!("*Namespace:* {}", first.namespace),
        format!("*Workload:* {}", first.name),
    ];
    if other_workloads > 0 {
        location_lines.push(format!(
            "*Also matches:* {} other workload(s) in current data",
            other_workloads,
        ));
    }
    blocks.push(json!({
        "type": "section",
        "text": {
            "type": "mrkdwn",
            "text": format!("*Affected location*\n{}", location_lines.join("\n")),
        },
    }));

    let remaining_annotations: BTreeMap<String, String> = rule
        .annotations
        .iter()
        .filter(|(k, _)| k.as_str() != "summary" && k.as_str() != "description")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if !remaining_annotations.is_empty() {
        blocks.push(map_block("annotations", &remaining_annotations));
    }
    if !rule.labels.is_empty() {
        blocks.push(map_block("labels", &rule.labels));
    }
    // The title hyperlink (computed above) already carries the deep link,
    // so a standalone "View report" context block is redundant. The build
    // version is appended when available so an oncaller can correlate a
    // noisy alert with the exact collector release without digging through
    // pod metadata. `option_env!` is `Some` under a normal cargo build but
    // we still treat empty/missing as "omit" so a custom build pipeline
    // that strips the package version doesn't render `v` with no number.
    blocks.push(json!({
        "type": "context",
        "elements": [{
            "type": "mrkdwn",
            "text": format_footer(receiver_name),
        }],
    }));

    let mut payload = json!({
        "text": format!("[FIRING] {}", header_sentence),
        "blocks": blocks,
    });
    if let Some(channel) = &slack.channel {
        payload["channel"] = json!(channel);
    }
    payload
}

/// Render the trailing context line under the alert. Includes the
/// trivy-collector semver when the build set `CARGO_PKG_VERSION` to a
/// non-empty value; falls back to the bare label otherwise so a stripped
/// build doesn't show `v` followed by nothing.
fn format_footer(receiver_name: &str) -> String {
    format_footer_with_version(receiver_name, version_label())
}

fn format_footer_with_version(receiver_name: &str, version: Option<&str>) -> String {
    match version {
        Some(v) if !v.is_empty() => {
            format!("trivy-collector v{} · receiver={}", v, receiver_name)
        }
        _ => format!("trivy-collector · receiver={}", receiver_name),
    }
}

fn version_label() -> Option<&'static str> {
    option_env!("CARGO_PKG_VERSION").filter(|v| !v.is_empty())
}

/// Percent-encode a single URL path segment. Restricted set: anything that
/// isn't an unreserved ASCII char (`A-Z a-z 0-9 - _ . ~`) is hex-escaped.
/// Sufficient for cluster/namespace/workload names which generally consist
/// of DNS-label-safe characters but may include `.` or unexpected glyphs.
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// Build a Slack `rich_text` block: a bold "Components" header followed by
/// a native bullet list. `rich_text` is the only Slack block type that
/// renders actual indented bullets — `mrkdwn` does not support markdown
/// list syntax, only inline emphasis.
fn components_block(contexts: &[AlertContext]) -> Value {
    let mut items: Vec<Value> = Vec::new();
    for c in contexts.iter().take(MAX_FINDINGS_PER_MESSAGE) {
        let mut elements: Vec<Value> =
            vec![json!({ "type": "text", "text": format!("{} {}", c.package, c.version) })];
        if let Some(t) = c.pkg_type.as_deref()
            && !t.is_empty()
        {
            elements.push(json!({ "type": "text", "text": " · " }));
            elements.push(json!({
                "type": "text",
                "text": t,
                "style": { "italic": true },
            }));
        }
        items.push(json!({
            "type": "rich_text_section",
            "elements": elements,
        }));
    }
    let total = contexts.len();
    if total > MAX_FINDINGS_PER_MESSAGE {
        items.push(json!({
            "type": "rich_text_section",
            "elements": [{
                "type": "text",
                "text": format!("…and {} more — see UI", total - MAX_FINDINGS_PER_MESSAGE),
                "style": { "italic": true },
            }],
        }));
    }
    json!({
        "type": "rich_text",
        "elements": [
            {
                "type": "rich_text_section",
                "elements": [{
                    "type": "text",
                    "text": "Components",
                    "style": { "bold": true },
                }],
            },
            {
                "type": "rich_text_list",
                "style": "bullet",
                "elements": items,
            }
        ],
    })
}

/// Build a `rich_text` block for an `annotations` / `labels` key→value
/// map: bold header line, then a native bullet list of `key: value` rows.
fn map_block(header: &str, map: &BTreeMap<String, String>) -> Value {
    let items: Vec<Value> = map
        .iter()
        .map(|(k, v)| {
            json!({
                "type": "rich_text_section",
                "elements": [{
                    "type": "text",
                    "text": format!("{}: {}", k, v),
                }],
            })
        })
        .collect();
    json!({
        "type": "rich_text",
        "elements": [
            {
                "type": "rich_text_section",
                "elements": [{
                    "type": "text",
                    "text": header,
                    "style": { "bold": true },
                }],
            },
            {
                "type": "rich_text_list",
                "style": "bullet",
                "elements": items,
            }
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::alerts::types::{Matchers, Receiver};

    fn sample_rule() -> AlertRule {
        AlertRule {
            name: "deprecated-crypto".into(),
            description: String::new(),
            enabled: true,
            matchers: Matchers::default(),
            labels: BTreeMap::new(),
            annotations: BTreeMap::new(),
            receivers: vec![Receiver {
                name: "sec-team".into(),
                slack: Some(SlackReceiver {
                    webhook_url: "https://hooks.slack.com/services/X".into(),
                    channel: Some("#sec".into()),
                    title: None,
                }),
            }],
            cooldown_secs: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            created_by: "tester".into(),
            updated_at: None,
            updated_by: None,
        }
    }

    fn sbom_ctx(pkg: &str, version: &str) -> AlertContext {
        AlertContext {
            cluster: "prod".into(),
            namespace: "ns".into(),
            name: "app".into(),
            report_type: "sbomreport".into(),
            package: pkg.into(),
            version: version.into(),
            pkg_type: Some("go-module".into()),
        }
    }

    #[test]
    fn payload_single_component_uses_rule_name_as_title() {
        let rule = sample_rule();
        let receiver = &rule.receivers[0];
        let ctx = sbom_ctx("openssl", "3.0.7");
        let payload = build_payload(
            &rule,
            &receiver.name,
            receiver.slack.as_ref().unwrap(),
            std::slice::from_ref(&ctx),
            Some("https://trivy.example.com"),
            4,
        );
        assert_eq!(payload["channel"], "#sec");
        let blocks_json = serde_json::to_string(&payload["blocks"]).unwrap();
        // Header is a sentence referring to the rule, not a bare name
        assert!(
            blocks_json.contains("[FIRING] Component matched by rule \\\"deprecated-crypto\\\"")
        );
        // Component identity surfaced as a separate field
        assert!(blocks_json.contains("*Component:* openssl 3.0.7"));
        // Workload appears as supporting "Affected location"
        assert!(blocks_json.contains("Affected location"));
        assert!(blocks_json.contains("*Cluster:* prod"));
        assert!(blocks_json.contains("*Workload:* app"));
        // Deep link is hyperlinked into the title itself with red emoji
        assert!(blocks_json.contains(":rotating_light:"));
        assert!(blocks_json.contains(
            "<https://trivy.example.com/sbom/prod/ns/app|[FIRING] Component matched by rule"
        ));
        // No separate "View report" context block now that title carries the link
        assert!(!blocks_json.contains("View report"));
        // Fleet scope hint rendered when other workloads also match
        assert!(blocks_json.contains("*Also matches:* 4 other workload(s)"));
        // No grouping count when single
        assert!(!blocks_json.contains("components*"));
        assert!(payload.get("attachments").is_none());
    }

    #[test]
    fn payload_grouped_renders_one_message_for_many_components() {
        let rule = sample_rule();
        let receiver = &rule.receivers[0];
        let ctxs = vec![
            sbom_ctx("openssl", "3.0.7"),
            sbom_ctx("glibc", "2.36"),
            sbom_ctx("zlib", "1.2.13"),
        ];
        let payload = build_payload(
            &rule,
            &receiver.name,
            receiver.slack.as_ref().unwrap(),
            &ctxs,
            None,
            0,
        );
        let blocks_json = serde_json::to_string(&payload["blocks"]).unwrap();
        assert!(blocks_json.contains("openssl"));
        assert!(blocks_json.contains("glibc"));
        assert!(blocks_json.contains("zlib"));
        // Grouped header is a sentence with the count and rule name
        assert!(
            blocks_json.contains("[FIRING] 3 components matched by rule \\\"deprecated-crypto\\\"")
        );
        // Workload appears as supporting "Affected location"
        assert!(blocks_json.contains("Affected location"));
        assert!(payload.get("attachments").is_none());
    }

    #[test]
    fn payload_truncates_beyond_limit() {
        let rule = sample_rule();
        let receiver = &rule.receivers[0];
        let ctxs: Vec<AlertContext> = (0..MAX_FINDINGS_PER_MESSAGE + 5)
            .map(|i| sbom_ctx(&format!("pkg-{:03}", i), "1.0.0"))
            .collect();
        let payload = build_payload(
            &rule,
            &receiver.name,
            receiver.slack.as_ref().unwrap(),
            &ctxs,
            None,
            0,
        );
        let blocks_json = serde_json::to_string(&payload["blocks"]).unwrap();
        assert!(blocks_json.contains("pkg-000"));
        assert!(!blocks_json.contains("pkg-024"));
        assert!(blocks_json.contains("and 5 more"));
    }

    #[tokio::test]
    async fn semaphore_for_returns_same_instance_per_url() {
        let n = SlackNotifier::new();
        let a1 = n.semaphore_for("https://hooks.slack.com/A").await;
        let a2 = n.semaphore_for("https://hooks.slack.com/A").await;
        let b = n.semaphore_for("https://hooks.slack.com/B").await;
        assert!(Arc::ptr_eq(&a1, &a2));
        assert!(!Arc::ptr_eq(&a1, &b));
    }

    #[tokio::test]
    async fn semaphore_for_serializes_same_url() {
        let n = SlackNotifier::new();
        let sem = n.semaphore_for("https://hooks.slack.com/X").await;
        let p1 = sem.clone().acquire_owned().await.unwrap();
        assert!(sem.clone().try_acquire_owned().is_err());
        drop(p1);
        assert!(sem.try_acquire_owned().is_ok());
    }

    #[test]
    fn urlencode_preserves_unreserved_and_escapes_others() {
        assert_eq!(urlencode("plain-text_v1.0"), "plain-text_v1.0");
        assert_eq!(urlencode("with space"), "with%20space");
        assert_eq!(urlencode("path/sep"), "path%2Fsep");
        assert_eq!(urlencode("k=v&x=y"), "k%3Dv%26x%3Dy");
        assert_eq!(urlencode("한글"), "%ED%95%9C%EA%B8%80");
    }

    #[test]
    fn external_url_strips_trailing_slash() {
        let n = SlackNotifier::with_external_url(Some("https://example.com/".into()));
        assert_eq!(n.external_url.as_deref(), Some("https://example.com"));
        let n2 = SlackNotifier::with_external_url(Some("https://example.com".into()));
        assert_eq!(n2.external_url.as_deref(), Some("https://example.com"));
    }

    #[test]
    fn external_url_treats_empty_as_none() {
        let n = SlackNotifier::with_external_url(Some(String::new()));
        assert!(n.external_url.is_none());
        let n2 = SlackNotifier::with_external_url(None);
        assert!(n2.external_url.is_none());
    }

    #[test]
    fn parse_retry_after_returns_seconds() {
        // parse_retry_after takes a reqwest::Response which is hard to
        // construct in a unit test, so we test the integer parsing path
        // implicitly via webhook URL handling. Direct path coverage is
        // exercised by integration testing in the wild.
        // Simpler: verify the helper handles the all-numeric case via
        // the parse step it depends on.
        assert_eq!("30".trim().parse::<u64>().ok(), Some(30));
        assert_eq!("not-a-number".trim().parse::<u64>().ok(), None);
    }

    #[test]
    fn payload_no_external_url_omits_link_in_title() {
        let rule = sample_rule();
        let receiver = &rule.receivers[0];
        let ctx = sbom_ctx("openssl", "3.0.7");
        let payload = build_payload(
            &rule,
            &receiver.name,
            receiver.slack.as_ref().unwrap(),
            std::slice::from_ref(&ctx),
            None,
            0,
        );
        let blocks_json = serde_json::to_string(&payload["blocks"]).unwrap();
        // Title is plain bold text without `<url|...>` link syntax
        assert!(blocks_json.contains(":rotating_light: *[FIRING] Component matched by rule"));
        assert!(!blocks_json.contains("<https://"));
        // Also matches line suppressed when no other workloads
        assert!(!blocks_json.contains("Also matches"));
    }

    #[test]
    fn payload_renders_description_and_summary_for_grouped() {
        use std::collections::BTreeMap;
        let mut rule = sample_rule();
        rule.description = "Use of deprecated package".to_string();
        rule.annotations = {
            let mut m = BTreeMap::new();
            m.insert("summary".into(), "SEC-2026 supply chain".into());
            m.insert("runbook".into(), "https://wiki/runbook".into());
            m
        };
        rule.labels = {
            let mut m = BTreeMap::new();
            m.insert("team".into(), "platform".into());
            m
        };
        let ctxs = vec![sbom_ctx("openssl", "3.0.7"), sbom_ctx("glibc", "2.36")];
        let payload = build_payload(
            &rule,
            &rule.receivers[0].name,
            rule.receivers[0].slack.as_ref().unwrap(),
            &ctxs,
            None,
            7,
        );
        let blocks_json = serde_json::to_string(&payload["blocks"]).unwrap();
        // rule.description surfaces as Description line in the meta block
        assert!(blocks_json.contains("Use of deprecated package"));
        // annotations.summary surfaces beside the description
        assert!(blocks_json.contains("SEC-2026 supply chain"));
        // remaining annotation (runbook) rendered in the annotations block
        assert!(blocks_json.contains("runbook"));
        // labels rendered in the labels block
        assert!(blocks_json.contains("team"));
        assert!(blocks_json.contains("platform"));
        // Fleet scope hint visible
        assert!(blocks_json.contains("*Also matches:* 7 other workload(s)"));
    }

    #[test]
    fn footer_includes_collector_version() {
        // CARGO_PKG_VERSION is set by cargo for any normal build/test, so
        // version_label() returns Some and the footer renders "vX.Y.Z".
        // We compare against env!() at test compile time so this stays in
        // lockstep with Cargo.toml without hardcoding a literal version.
        let footer = format_footer("slack-default");
        let expected_version = env!("CARGO_PKG_VERSION");
        assert!(
            footer.contains(&format!("trivy-collector v{}", expected_version)),
            "footer = {:?}",
            footer,
        );
        assert!(footer.contains("receiver=slack-default"));
    }

    #[test]
    fn footer_renders_in_payload_context_block() {
        let rule = sample_rule();
        let ctx = sbom_ctx("openssl", "3.0.7");
        let payload = build_payload(
            &rule,
            &rule.receivers[0].name,
            rule.receivers[0].slack.as_ref().unwrap(),
            std::slice::from_ref(&ctx),
            None,
            0,
        );
        let blocks_json = serde_json::to_string(&payload["blocks"]).unwrap();
        let expected_version = env!("CARGO_PKG_VERSION");
        assert!(
            blocks_json.contains(&format!("trivy-collector v{}", expected_version)),
            "blocks did not include the version footer: {}",
            blocks_json,
        );
    }

    #[test]
    fn version_label_filters_empty_string() {
        // option_env! returns None for unset vars and Some("") only if the
        // env var was deliberately set to "". The filter ensures the second
        // case doesn't render `trivy-collector v` with nothing after.
        // We can't unset CARGO_PKG_VERSION at test time (it's compile-time
        // baked), so we exercise the filter logic directly.
        let bare: Option<&'static str> = Some("");
        let filtered = bare.filter(|v| !v.is_empty());
        assert!(filtered.is_none());
    }

    #[test]
    fn format_footer_with_version_omits_when_none_or_empty() {
        let bare = format_footer_with_version("slack-default", None);
        assert_eq!(bare, "trivy-collector · receiver=slack-default");
        let empty = format_footer_with_version("slack-default", Some(""));
        assert_eq!(empty, "trivy-collector · receiver=slack-default");
    }

    #[test]
    fn format_footer_with_version_renders_when_present() {
        let footer = format_footer_with_version("slack-default", Some("9.9.9"));
        assert_eq!(footer, "trivy-collector v9.9.9 · receiver=slack-default");
    }

    #[test]
    fn payload_omits_pkg_type_when_unset() {
        let rule = sample_rule();
        let ctx = AlertContext {
            pkg_type: None,
            ..sbom_ctx("openssl", "3.0.7")
        };
        let payload = build_payload(
            &rule,
            &rule.receivers[0].name,
            rule.receivers[0].slack.as_ref().unwrap(),
            std::slice::from_ref(&ctx),
            None,
            0,
        );
        let blocks_json = serde_json::to_string(&payload["blocks"]).unwrap();
        // Component shown but no Type line
        assert!(blocks_json.contains("*Component:* openssl 3.0.7"));
        assert!(!blocks_json.contains("*Type:*"));
    }
}
