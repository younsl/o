//! Slack notification support via Incoming Webhooks.

use serde::Serialize;
use tracing::warn;

/// Slack webhook client.
pub struct SlackNotifier {
    webhook_url: String,
    client: reqwest::Client,
}

/// Slack webhook payload.
#[derive(Serialize)]
struct SlackPayload {
    text: String,
}

impl SlackNotifier {
    /// Create a new Slack notifier with the given webhook URL.
    pub fn new(webhook_url: String) -> Self {
        Self {
            webhook_url,
            client: reqwest::Client::new(),
        }
    }

    /// Send a text message to Slack. Errors are logged but not propagated.
    pub async fn send(&self, text: &str) {
        let payload = SlackPayload {
            text: text.to_string(),
        };
        match self
            .client
            .post(&self.webhook_url)
            .json(&payload)
            .send()
            .await
        {
            Ok(resp) if !resp.status().is_success() => {
                warn!("Slack webhook returned status {}", resp.status());
            }
            Err(e) => {
                warn!("Failed to send Slack notification: {}", e);
            }
            _ => {}
        }
    }
}
