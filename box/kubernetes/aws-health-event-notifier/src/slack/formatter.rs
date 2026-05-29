use std::fmt::Write as _;

use serde_json::{Value, json};

use crate::health::HealthEvent;

const MAX_ENTITIES_RENDERED: usize = 20;
const DESCRIPTION_TRUNCATE: usize = 2500;

pub struct SlackMessageOpts<'a> {
    pub channel: Option<&'a str>,
    pub username: &'a str,
    pub icon_emoji: &'a str,
    /// Pre-rendered account label ("alias (id)" / "id" / "alias"). Falls back
    /// to `event.account` when None.
    pub account_label: Option<&'a str>,
    /// When set, render the message as a "T-X hours until start" reminder.
    pub reminder_offset_hours: Option<u32>,
}

/// Build a Slack Incoming Webhook JSON payload from a Health event.
pub fn build(event: &HealthEvent, opts: &SlackMessageOpts<'_>) -> Value {
    let detail = &event.detail;
    let base_title = title_line(event);
    let title = opts.reminder_offset_hours.map_or_else(
        || base_title.clone(),
        |h| format!("⏰ Reminder (T-{h}h) — {base_title}"),
    );
    let color = if opts.reminder_offset_hours.is_some() {
        "#7d3cba"
    } else {
        severity_color(detail.event_type_category.as_deref())
    };

    let mut fields = Vec::new();
    push_field(&mut fields, "Service", detail.service.as_deref());
    push_field(
        &mut fields,
        "Category",
        detail.event_type_category.as_deref(),
    );
    push_field(
        &mut fields,
        "Account",
        opts.account_label.or(event.account.as_deref()),
    );
    push_field(&mut fields, "Region", event.region.as_deref());
    push_field(&mut fields, "Status", detail.status_code.as_deref());
    push_field(&mut fields, "Start", detail.start_time.as_deref());
    push_field(&mut fields, "End", detail.end_time.as_deref());
    push_field(&mut fields, "Updated", detail.last_updated_time.as_deref());
    if let Some(arn) = detail.event_arn.as_deref().filter(|a| !a.is_empty()) {
        let id = arn.rsplit('/').next().unwrap_or(arn);
        let value = aws_health_dashboard_url(arn, detail.event_type_category.as_deref())
            .map_or_else(|| format!("`{id}`"), |url| format!("<{url}|{id}>"));
        fields.push(json!({
            "type": "mrkdwn",
            "text": format!("*Event ID*\n{value}")
        }));
    }

    let intro = intro_line(
        detail.event_type_category.as_deref(),
        opts.reminder_offset_hours,
    );
    // No header block: the root-level `text` field already renders the title
    // above the attachment. A header block would duplicate it in the channel.
    let mut blocks = vec![json!({
        "type": "section",
        "text": {"type": "mrkdwn", "text": intro}
    })];
    if !fields.is_empty() {
        blocks.push(json!({"type": "section", "fields": fields}));
    }

    if let Some(desc) = detail.description() {
        blocks.push(json!({
            "type": "section",
            "text": {"type": "mrkdwn", "text": truncate(desc, DESCRIPTION_TRUNCATE)}
        }));
    }

    if !detail.affected_entities.is_empty() {
        blocks.push(entities_block(detail));
    }

    let mut attachment = json!({ "color": color, "blocks": blocks });
    let mut payload = json!({
        "username": opts.username,
        "icon_emoji": opts.icon_emoji,
        // Wrap in Slack mrkdwn bold so the title renders strong above the
        // attachment. Markdown is enabled by default for Incoming Webhooks.
        "text": format!("*{title}*"),
        "attachments": [attachment.take()],
    });
    if let Some(ch) = opts.channel {
        payload["channel"] = Value::String(ch.to_string());
    }
    payload
}

/// Build a deep link to the AWS Health Dashboard for a given event ARN.
/// Routes to the dashboard sub-tab that matches the event category so the
/// console lands on the right list.
fn aws_health_dashboard_url(arn: &str, category: Option<&str>) -> Option<String> {
    if arn.is_empty() {
        return None;
    }
    let tab = match category {
        Some("issue" | "investigation") => "open-issues",
        Some("scheduledChange") => "scheduled-changes",
        Some("accountNotification" | "securityNotification") => "other-notifications",
        _ => "event-log",
    };
    Some(format!(
        "https://health.aws.amazon.com/health/home#/account/dashboard/{tab}?eventID={}",
        url_encode(arn)
    ))
}

/// RFC 3986 percent-encoding for the unreserved set. Enough for ARN segments.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(*b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(*b));
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

fn intro_line(category: Option<&str>, reminder_offset_hours: Option<u32>) -> String {
    if let Some(h) = reminder_offset_hours {
        return format!("_Reminder: a scheduled AWS Health event starts in about {h} hour(s)._");
    }
    let s = match category {
        Some("scheduledChange") => {
            "A scheduled AWS Health event has been published for your account."
        }
        Some("issue") => "An AWS Health service issue is active for your account.",
        Some("investigation") => {
            "AWS is investigating a potential service issue affecting your account."
        }
        Some("accountNotification") => "An AWS Health account notification has been published.",
        Some("securityNotification") => "An AWS Health security notification has been published.",
        _ => "An AWS Health event has been published for your account.",
    };
    s.to_string()
}

fn title_line(event: &HealthEvent) -> String {
    let code = event
        .detail
        .event_type_code
        .as_deref()
        .unwrap_or("UNKNOWN_EVENT");
    let svc = event.detail.service.as_deref().unwrap_or("AWS");
    format!("[{svc}] {code}")
}

fn severity_color(category: Option<&str>) -> &'static str {
    match category {
        Some("issue") => "#d72c2c",
        Some("accountNotification") => "#3aa3e3",
        Some("scheduledChange") => "#f2c744",
        Some("investigation") => "#cf6d00",
        _ => "#808080",
    }
}

fn push_field(fields: &mut Vec<Value>, label: &str, value: Option<&str>) {
    let Some(v) = value else { return };
    if v.is_empty() {
        return;
    }
    fields.push(json!({
        "type": "mrkdwn",
        "text": format!("*{label}*\n{v}")
    }));
}

fn entities_block(detail: &crate::health::HealthDetail) -> Value {
    let total = detail.affected_entities.len();
    let shown: Vec<String> = detail
        .affected_entities
        .iter()
        .take(MAX_ENTITIES_RENDERED)
        .filter_map(|e| {
            let value = e.entity_value.as_deref()?;
            Some(match e.status.as_deref() {
                Some(s) if !s.is_empty() => format!("• `{value}` ({s})"),
                _ => format!("• `{value}`"),
            })
        })
        .collect();
    let mut text = format!("*Affected resources ({total})*\n{}", shown.join("\n"));
    if total > MAX_ENTITIES_RENDERED {
        let _ = write!(text, "\n_(+{} more)_", total - MAX_ENTITIES_RENDERED);
    }
    json!({"type": "section", "text": {"type": "mrkdwn", "text": text}})
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{truncated}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::{AffectedEntity, EventDescription, HealthDetail, HealthEvent};

    fn opts<'a>() -> SlackMessageOpts<'a> {
        SlackMessageOpts {
            channel: None,
            username: "bot",
            icon_emoji: ":cloud:",
            account_label: None,
            reminder_offset_hours: None,
        }
    }

    fn event(category: Option<&str>) -> HealthEvent {
        HealthEvent {
            account: Some("123456789012".into()),
            region: Some("us-east-1".into()),
            detail: HealthDetail {
                event_arn: Some(
                    "arn:aws:health:us-east-1::event/EC2/AWS_EC2_OPS/AWS_EC2_OPS_abc123".into(),
                ),
                service: Some("EC2".into()),
                event_type_code: Some("AWS_EC2_INSTANCE_RETIREMENT".into()),
                event_type_category: category.map(str::to_string),
                start_time: Some("2026-01-01T00:00:00Z".into()),
                end_time: Some("2026-01-02T00:00:00Z".into()),
                last_updated_time: Some("2026-01-01T01:00:00Z".into()),
                status_code: Some("open".into()),
                event_description: vec![EventDescription {
                    language: Some("en".into()),
                    latest_description: Some("Something happened.".into()),
                }],
                affected_entities: vec![AffectedEntity {
                    entity_value: Some("i-0abc".into()),
                    status: Some("IMPAIRED".into()),
                }],
            },
        }
    }

    #[test]
    fn build_full_payload_has_username_text_and_attachment() {
        let p = build(&event(Some("issue")), &opts());
        assert_eq!(p["username"], "bot");
        assert_eq!(p["icon_emoji"], ":cloud:");
        assert_eq!(p["text"], "*[EC2] AWS_EC2_INSTANCE_RETIREMENT*");
        assert!(p["channel"].is_null());
        let att = &p["attachments"][0];
        assert_eq!(att["color"], "#d72c2c"); // issue color
        assert!(att["blocks"].as_array().unwrap().len() >= 3);
    }

    #[test]
    fn build_sets_channel_when_present() {
        let mut o = opts();
        o.channel = Some("#alerts");
        let p = build(&event(Some("issue")), &o);
        assert_eq!(p["channel"], "#alerts");
    }

    #[test]
    fn build_reminder_overrides_color_and_title() {
        let mut o = opts();
        o.reminder_offset_hours = Some(24);
        let p = build(&event(Some("scheduledChange")), &o);
        assert_eq!(p["attachments"][0]["color"], "#7d3cba");
        assert_eq!(
            p["text"],
            "*⏰ Reminder (T-24h) — [EC2] AWS_EC2_INSTANCE_RETIREMENT*"
        );
    }

    #[test]
    fn build_uses_account_label_over_event_account() {
        let mut o = opts();
        o.account_label = Some("prod (123456789012)");
        let p = build(&event(Some("issue")), &o);
        let text = serde_json::to_string(&p).unwrap();
        assert!(text.contains("prod (123456789012)"));
    }

    #[test]
    fn build_truncates_long_description() {
        let mut e = event(Some("issue"));
        e.detail.event_description = vec![EventDescription {
            language: Some("en".into()),
            latest_description: Some("x".repeat(DESCRIPTION_TRUNCATE + 50)),
        }];
        let p = build(&e, &opts());
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains('…'));
    }

    #[test]
    fn build_handles_missing_optional_fields() {
        let mut e = event(None);
        e.region = None;
        e.detail.service = None;
        e.detail.event_type_code = None;
        e.detail.status_code = None;
        e.detail.start_time = None;
        e.detail.end_time = None;
        e.detail.last_updated_time = None;
        e.detail.event_arn = Some(String::new());
        e.detail.affected_entities.clear();
        e.detail.event_description.clear();
        let p = build(&e, &opts());
        assert_eq!(p["text"], "*[AWS] UNKNOWN_EVENT*");
        assert_eq!(p["attachments"][0]["color"], "#808080");
    }

    #[test]
    fn dashboard_url_routes_by_category() {
        let arn = "arn:aws:health:::event/x";
        assert!(
            aws_health_dashboard_url(arn, Some("issue"))
                .unwrap()
                .contains("open-issues")
        );
        assert!(
            aws_health_dashboard_url(arn, Some("scheduledChange"))
                .unwrap()
                .contains("scheduled-changes")
        );
        assert!(
            aws_health_dashboard_url(arn, Some("accountNotification"))
                .unwrap()
                .contains("other-notifications")
        );
        assert!(
            aws_health_dashboard_url(arn, Some("securityNotification"))
                .unwrap()
                .contains("other-notifications")
        );
        assert!(
            aws_health_dashboard_url(arn, None)
                .unwrap()
                .contains("event-log")
        );
        assert!(aws_health_dashboard_url("", Some("issue")).is_none());
    }

    #[test]
    fn url_encode_preserves_unreserved_and_escapes_rest() {
        assert_eq!(url_encode("aZ09-_.~"), "aZ09-_.~");
        assert_eq!(url_encode("a/b c"), "a%2Fb%20c");
    }

    #[test]
    fn intro_line_variants() {
        assert!(intro_line(Some("issue"), None).contains("service issue"));
        assert!(intro_line(Some("investigation"), None).contains("investigating"));
        assert!(intro_line(Some("scheduledChange"), None).contains("scheduled"));
        assert!(intro_line(Some("accountNotification"), None).contains("account notification"));
        assert!(intro_line(Some("securityNotification"), None).contains("security"));
        assert!(intro_line(None, None).contains("AWS Health event"));
        assert!(intro_line(None, Some(6)).contains("6 hour"));
    }

    #[test]
    fn severity_color_variants() {
        assert_eq!(severity_color(Some("issue")), "#d72c2c");
        assert_eq!(severity_color(Some("accountNotification")), "#3aa3e3");
        assert_eq!(severity_color(Some("scheduledChange")), "#f2c744");
        assert_eq!(severity_color(Some("investigation")), "#cf6d00");
        assert_eq!(severity_color(Some("other")), "#808080");
        assert_eq!(severity_color(None), "#808080");
    }

    #[test]
    fn push_field_skips_empty_and_none() {
        let mut f = Vec::new();
        push_field(&mut f, "A", None);
        push_field(&mut f, "B", Some(""));
        push_field(&mut f, "C", Some("v"));
        assert_eq!(f.len(), 1);
        assert_eq!(f[0]["text"], "*C*\nv");
    }

    #[test]
    fn entities_block_caps_and_shows_overflow() {
        let mut detail = event(Some("issue")).detail;
        detail.affected_entities = (0..MAX_ENTITIES_RENDERED + 5)
            .map(|i| AffectedEntity {
                entity_value: Some(format!("i-{i}")),
                status: if i % 2 == 0 { Some("OK".into()) } else { None },
            })
            .collect();
        let block = entities_block(&detail);
        let text = block["text"]["text"].as_str().unwrap();
        assert!(text.contains(&format!(
            "Affected resources ({})",
            MAX_ENTITIES_RENDERED + 5
        )));
        assert!(text.contains("(+5 more)"));
        assert!(text.contains("(OK)"));
    }

    #[test]
    fn truncate_keeps_short_and_cuts_long() {
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }
}
