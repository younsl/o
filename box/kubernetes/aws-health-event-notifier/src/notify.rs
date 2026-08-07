//! Fan-out of a single Health event to every notification sink.
//!
//! Slack is the primary sink: a failed Slack post returns `Err` so the caller
//! leaves the event un-acked and retries next cycle. Every other sink (today
//! just the Kubernetes Event recorder) is best-effort — its failure is logged
//! and counted but never blocks delivery. Adding a sink means adding a field
//! here and one call in [`Notifier::publish`]; callers stay untouched.

use tracing::{info, warn};

use crate::error::AppResult;
use crate::health::HealthEvent;
use crate::k8s::client::K8sEventClient;
use crate::observability::metrics::Metrics;
use crate::slack::client::SlackClient;
use crate::slack::formatter::{self, SlackMessageOpts};

/// Owned presentation options shared by every Slack message.
pub struct SlackOpts {
    pub channel: Option<String>,
    pub username: String,
    pub icon_emoji: String,
    /// Pre-rendered "alias (id)" account label, or `None` if unresolved.
    pub account_label: Option<String>,
}

pub struct Notifier {
    slack: SlackClient,
    slack_opts: SlackOpts,
    /// `None` outside a pod (Downward API identity absent).
    k8s: Option<K8sEventClient>,
    metrics: Metrics,
}

impl Notifier {
    pub const fn new(
        slack: SlackClient,
        slack_opts: SlackOpts,
        k8s: Option<K8sEventClient>,
        metrics: Metrics,
    ) -> Self {
        Self {
            slack,
            slack_opts,
            k8s,
            metrics,
        }
    }

    /// Deliver `event` to every sink. `reminder_offset_hours` is `Some(h)` when
    /// this fires as a "starts in ~h hours" reminder. Returns `Err` only if the
    /// primary (Slack) delivery failed.
    pub async fn publish(
        &self,
        event: &HealthEvent,
        reminder_offset_hours: Option<u32>,
    ) -> AppResult<()> {
        let payload = formatter::build(
            event,
            &SlackMessageOpts {
                channel: self.slack_opts.channel.as_deref(),
                username: &self.slack_opts.username,
                icon_emoji: &self.slack_opts.icon_emoji,
                account_label: self.slack_opts.account_label.as_deref(),
                reminder_offset_hours,
            },
        );

        if let Err(e) = self.slack.post(&payload).await {
            self.metrics.record_slack("error");
            return Err(e);
        }
        self.metrics.record_slack("ok");

        self.emit_k8s(event, reminder_offset_hours).await;
        Ok(())
    }

    /// Best-effort Kubernetes Event emission.
    async fn emit_k8s(&self, event: &HealthEvent, reminder_offset_hours: Option<u32>) {
        let Some(k8s) = &self.k8s else { return };
        let arn = event.detail.event_arn.as_deref().unwrap_or("?");
        match k8s.emit(event, reminder_offset_hours).await {
            Ok(()) => {
                self.metrics.record_k8s_event("ok");
                info!(arn = %arn, "created kubernetes event");
            }
            Err(e) => {
                self.metrics.record_k8s_event("error");
                warn!(arn = %arn, error = %e, "kubernetes event creation failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use secrecy::SecretString;
    use wiremock::matchers::method;
    use wiremock::{Mock, MockServer, ResponseTemplate};

    use super::*;
    use crate::health::{HealthDetail, HealthEvent};

    fn event() -> HealthEvent {
        HealthEvent {
            account: Some("123456789012".into()),
            region: Some("us-east-1".into()),
            detail: HealthDetail {
                event_arn: Some("arn:1".into()),
                service: Some("EC2".into()),
                event_type_code: Some("CODE".into()),
                event_type_category: Some("issue".into()),
                start_time: None,
                end_time: None,
                last_updated_time: None,
                status_code: Some("open".into()),
                event_description: vec![],
                affected_entities: vec![],
            },
        }
    }

    fn notifier(url: &str) -> (Notifier, Metrics) {
        let slack =
            SlackClient::new(SecretString::from(url.to_string()), Duration::from_secs(5)).unwrap();
        let metrics = Metrics::new();
        let n = Notifier::new(
            slack,
            SlackOpts {
                channel: Some("#alerts".into()),
                username: "bot".into(),
                icon_emoji: ":cloud:".into(),
                account_label: Some("prod (123456789012)".into()),
            },
            None,
            metrics.clone(),
        );
        (n, metrics)
    }

    #[tokio::test]
    async fn publish_ok_records_slack_ok() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
        let (n, metrics) = notifier(&server.uri());
        assert!(n.publish(&event(), None).await.is_ok());
        assert!(metrics.render().contains("outcome=\"ok\""));
    }

    #[tokio::test]
    async fn publish_err_records_slack_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let (n, metrics) = notifier(&server.uri());
        assert!(n.publish(&event(), Some(24)).await.is_err());
        assert!(metrics.render().contains("outcome=\"error\""));
    }
}
