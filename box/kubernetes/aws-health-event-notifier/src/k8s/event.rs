//! Maps an AWS Health event onto a Kubernetes Event.
//!
//! The `note` is kept short and human-readable so it reads cleanly in
//! `kubectl get events` / `kubectl describe pod`. The `reason` is a stable
//! `PascalCase` token (K8s convention) derived from the event category.

use std::fmt::Write as _;

use kube::runtime::events::{Event, EventType};

use crate::health::HealthEvent;

/// events.k8s.io caps `note` at 1 KiB. Stay safely under it.
const NOTE_MAX: usize = 1000;

/// Build a Kubernetes Event from a Health event.
///
/// `reminder_offset_hours` is `Some(h)` when this fires as a "starts in ~h
/// hours" reminder rather than the initial notification.
pub fn build(event: &HealthEvent, reminder_offset_hours: Option<u32>) -> Event {
    let detail = &event.detail;
    let category = detail.event_type_category.as_deref();
    Event {
        type_: severity(category),
        reason: reason(category),
        action: if reminder_offset_hours.is_some() {
            "Remind".into()
        } else {
            "Notify".into()
        },
        note: Some(note(event, reminder_offset_hours)),
        secondary: None,
    }
}

/// `Warning` for anything actively impacting or under investigation; `Normal`
/// for purely informational scheduled changes and account notices.
fn severity(category: Option<&str>) -> EventType {
    match category {
        Some("issue" | "investigation" | "securityNotification") => EventType::Warning,
        _ => EventType::Normal,
    }
}

/// Stable `PascalCase` reason token, one per AWS Health category.
fn reason(category: Option<&str>) -> String {
    match category {
        Some("issue") => "ServiceIssue",
        Some("investigation") => "Investigation",
        Some("scheduledChange") => "ScheduledChange",
        Some("accountNotification") => "AccountNotification",
        Some("securityNotification") => "SecurityNotification",
        _ => "HealthEvent",
    }
    .to_string()
}

/// Concise one-liner, e.g.
/// `EC2 event AWS_EC2_PERSISTENT_INSTANCE_RETIREMENT_SCHEDULED in us-east-1. open. 3 resource(s) affected`
fn note(event: &HealthEvent, reminder_offset_hours: Option<u32>) -> String {
    let detail = &event.detail;
    let service = detail.service.as_deref().unwrap_or("AWS");
    let code = detail.event_type_code.as_deref().unwrap_or("UNKNOWN_EVENT");

    let mut s = String::new();
    if let Some(h) = reminder_offset_hours {
        let _ = write!(s, "Reminder (T-{h}h): ");
    }
    let _ = write!(s, "{service} event {code}");
    if let Some(region) = event.region.as_deref().filter(|r| !r.is_empty()) {
        let _ = write!(s, " in {region}");
    }
    if let Some(status) = detail.status_code.as_deref().filter(|v| !v.is_empty()) {
        let _ = write!(s, ". {status}");
    }
    let affected = detail.affected_entities.len();
    if affected > 0 {
        let _ = write!(s, ". {affected} resource(s) affected");
    }
    truncate(&s, NOTE_MAX)
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let kept: String = s.chars().take(max - 1).collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::{AffectedEntity, HealthDetail, HealthEvent};

    fn event(category: Option<&str>, region: Option<&str>, status: Option<&str>) -> HealthEvent {
        HealthEvent {
            account: None,
            region: region.map(str::to_string),
            detail: HealthDetail {
                event_arn: Some("arn:1".into()),
                service: Some("EC2".into()),
                event_type_code: Some("AWS_EC2_RETIREMENT".into()),
                event_type_category: category.map(str::to_string),
                start_time: None,
                end_time: None,
                last_updated_time: None,
                status_code: status.map(str::to_string),
                event_description: vec![],
                affected_entities: vec![AffectedEntity {
                    entity_value: Some("i-1".into()),
                    status: None,
                }],
            },
        }
    }

    #[test]
    fn build_notify_action_and_note() {
        let ev = build(&event(Some("issue"), Some("us-east-1"), Some("open")), None);
        assert_eq!(ev.action, "Notify");
        assert_eq!(ev.reason, "ServiceIssue");
        assert!(matches!(ev.type_, EventType::Warning));
        let note = ev.note.unwrap();
        assert!(note.contains("EC2 event AWS_EC2_RETIREMENT"));
        assert!(note.contains("in us-east-1"));
        assert!(note.contains("open"));
        assert!(note.contains("1 resource(s) affected"));
    }

    #[test]
    fn build_reminder_action() {
        let ev = build(&event(Some("scheduledChange"), None, None), Some(24));
        assert_eq!(ev.action, "Remind");
        assert!(matches!(ev.type_, EventType::Normal));
        assert!(ev.note.unwrap().starts_with("Reminder (T-24h): "));
    }

    #[test]
    fn severity_maps_categories() {
        assert!(matches!(severity(Some("issue")), EventType::Warning));
        assert!(matches!(
            severity(Some("investigation")),
            EventType::Warning
        ));
        assert!(matches!(
            severity(Some("securityNotification")),
            EventType::Warning
        ));
        assert!(matches!(
            severity(Some("scheduledChange")),
            EventType::Normal
        ));
        assert!(matches!(severity(None), EventType::Normal));
    }

    #[test]
    fn reason_maps_categories() {
        assert_eq!(reason(Some("issue")), "ServiceIssue");
        assert_eq!(reason(Some("investigation")), "Investigation");
        assert_eq!(reason(Some("scheduledChange")), "ScheduledChange");
        assert_eq!(reason(Some("accountNotification")), "AccountNotification");
        assert_eq!(reason(Some("securityNotification")), "SecurityNotification");
        assert_eq!(reason(None), "HealthEvent");
    }

    #[test]
    fn note_falls_back_and_skips_empty_fields() {
        let mut e = event(None, Some(""), Some(""));
        e.detail.service = None;
        e.detail.event_type_code = None;
        e.detail.affected_entities.clear();
        let note = note(&e, None);
        assert_eq!(note, "AWS event UNKNOWN_EVENT");
    }

    #[test]
    fn truncate_caps_at_max() {
        assert_eq!(truncate("abc", 10), "abc");
        let long = "x".repeat(NOTE_MAX + 10);
        let out = truncate(&long, NOTE_MAX);
        assert_eq!(out.chars().count(), NOTE_MAX);
        assert!(out.ends_with('…'));
    }
}
