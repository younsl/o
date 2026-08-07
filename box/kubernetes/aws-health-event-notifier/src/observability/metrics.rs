use std::sync::Arc;

use prometheus_client::encoding::EncodeLabelSet;
use prometheus_client::encoding::text::encode;
use prometheus_client::metrics::counter::Counter;
use prometheus_client::metrics::family::Family;
use prometheus_client::registry::Registry;

#[derive(Clone, Hash, PartialEq, Eq, EncodeLabelSet, Debug)]
pub struct EventLabels {
    pub service: String,
    pub category: String,
    pub region: String,
}

#[derive(Clone, Hash, PartialEq, Eq, EncodeLabelSet, Debug)]
pub struct OutcomeLabels {
    pub outcome: String,
}

#[derive(Clone, Hash, PartialEq, Eq, EncodeLabelSet, Debug)]
pub struct FilteredLabels {
    pub reason: String,
}

#[derive(Clone)]
pub struct Metrics {
    inner: Arc<MetricsInner>,
}

#[derive(Clone, Hash, PartialEq, Eq, EncodeLabelSet, Debug)]
pub struct ReminderLabels {
    pub offset_hours: String,
}

struct MetricsInner {
    registry: Registry,
    pub events_received: Family<EventLabels, Counter>,
    pub slack_posts: Family<OutcomeLabels, Counter>,
    pub events_filtered: Family<FilteredLabels, Counter>,
    pub poll_cycles: Family<OutcomeLabels, Counter>,
    pub reminders_sent: Family<ReminderLabels, Counter>,
    pub k8s_events: Family<OutcomeLabels, Counter>,
}

impl Metrics {
    pub fn new() -> Self {
        let mut registry = Registry::default();
        let events_received = Family::<EventLabels, Counter>::default();
        let slack_posts = Family::<OutcomeLabels, Counter>::default();
        let events_filtered = Family::<FilteredLabels, Counter>::default();
        let poll_cycles = Family::<OutcomeLabels, Counter>::default();
        let reminders_sent = Family::<ReminderLabels, Counter>::default();
        let k8s_events = Family::<OutcomeLabels, Counter>::default();

        registry.register(
            "aws_health_event_received_total",
            "AWS Health events received",
            events_received.clone(),
        );
        registry.register(
            "aws_health_event_slack_posts_total",
            "Slack webhook delivery attempts by outcome",
            slack_posts.clone(),
        );
        registry.register(
            "aws_health_event_filtered_total",
            "AWS Health events dropped by the local filter, labeled by reason",
            events_filtered.clone(),
        );
        registry.register(
            "aws_health_event_poll_cycles_total",
            "AWS Health API poll cycles by outcome",
            poll_cycles.clone(),
        );
        registry.register(
            "aws_health_event_reminders_sent_total",
            "Reminder Slack messages sent, labeled by offset_hours",
            reminders_sent.clone(),
        );
        registry.register(
            "aws_health_event_k8s_events_total",
            "Kubernetes Event creation attempts by outcome",
            k8s_events.clone(),
        );

        Self {
            inner: Arc::new(MetricsInner {
                registry,
                events_received,
                slack_posts,
                events_filtered,
                poll_cycles,
                reminders_sent,
                k8s_events,
            }),
        }
    }

    pub fn record_reminder(&self, offset_hours: u32) {
        self.inner
            .reminders_sent
            .get_or_create(&ReminderLabels {
                offset_hours: offset_hours.to_string(),
            })
            .inc();
    }

    pub fn record_poll(&self, outcome: &'static str) {
        self.inner
            .poll_cycles
            .get_or_create(&OutcomeLabels {
                outcome: outcome.to_string(),
            })
            .inc();
    }

    pub fn record_event(&self, service: &str, category: &str, region: &str) {
        self.inner
            .events_received
            .get_or_create(&EventLabels {
                service: service.to_string(),
                category: category.to_string(),
                region: region.to_string(),
            })
            .inc();
    }

    pub fn record_slack(&self, outcome: &'static str) {
        self.inner
            .slack_posts
            .get_or_create(&OutcomeLabels {
                outcome: outcome.to_string(),
            })
            .inc();
    }

    pub fn record_k8s_event(&self, outcome: &'static str) {
        self.inner
            .k8s_events
            .get_or_create(&OutcomeLabels {
                outcome: outcome.to_string(),
            })
            .inc();
    }

    pub fn record_filtered(&self, reason: &'static str) {
        self.inner
            .events_filtered
            .get_or_create(&FilteredLabels {
                reason: reason.to_string(),
            })
            .inc();
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        encode(&mut out, &self.inner.registry).unwrap_or_default();
        out
    }
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_includes_all_metric_names_after_recording() {
        let m = Metrics::default();
        m.record_event("EC2", "issue", "us-east-1");
        m.record_slack("ok");
        m.record_slack("error");
        m.record_filtered("deny_service");
        m.record_poll("ok");
        m.record_reminder(24);
        m.record_k8s_event("ok");

        let out = m.render();
        assert!(out.contains("aws_health_event_received_total"));
        assert!(out.contains("aws_health_event_slack_posts_total"));
        assert!(out.contains("aws_health_event_filtered_total"));
        assert!(out.contains("aws_health_event_poll_cycles_total"));
        assert!(out.contains("aws_health_event_reminders_sent_total"));
        assert!(out.contains("aws_health_event_k8s_events_total"));
        // Label values surfaced.
        assert!(out.contains("service=\"EC2\""));
        assert!(out.contains("offset_hours=\"24\""));
        assert!(out.contains("outcome=\"ok\""));
    }

    #[test]
    fn counters_accumulate() {
        let m = Metrics::new();
        m.record_slack("ok");
        m.record_slack("ok");
        let out = m.render();
        assert!(out.contains("outcome=\"ok\"} 2"));
    }

    #[test]
    fn metrics_clone_shares_state() {
        let m = Metrics::new();
        let c = m.clone();
        c.record_poll("ok");
        assert!(m.render().contains("aws_health_event_poll_cycles_total"));
    }
}
