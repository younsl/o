//! Slack notification support via Incoming Webhooks.

use serde_json::{Value, json};
use tracing::{info, warn};

/// Structured Slack message for Block Kit rendering.
pub struct SlackMessage {
    pub header: String,
    pub fields: Vec<(String, String)>,
    pub context: String,
}

/// Slack webhook client.
pub struct SlackNotifier {
    webhook_url: String,
    client: reqwest::Client,
}

impl SlackNotifier {
    /// Create a new Slack notifier with the given webhook URL.
    pub fn new(webhook_url: String) -> Self {
        Self {
            webhook_url,
            client: reqwest::Client::new(),
        }
    }

    /// Send a Block Kit message to Slack. Errors are logged but not propagated.
    pub async fn send(&self, resource_name: &str, message: &SlackMessage) {
        let payload = build_blocks_payload(message);
        match self
            .client
            .post(&self.webhook_url)
            .json(&payload)
            .send()
            .await
        {
            Ok(resp) if !resp.status().is_success() => {
                warn!(
                    resource = resource_name,
                    status = %resp.status(),
                    "Slack webhook returned non-success status"
                );
            }
            Err(e) => {
                warn!(
                    resource = resource_name,
                    error = %e,
                    "Failed to send Slack notification"
                );
            }
            Ok(_) => {
                info!(
                    resource = resource_name,
                    header = message.header.as_str(),
                    "Slack notification sent"
                );
            }
        }
    }
}

/// Build a Slack Block Kit payload from a [`SlackMessage`].
fn build_blocks_payload(message: &SlackMessage) -> Value {
    let mut blocks: Vec<Value> = Vec::new();

    // Header block
    blocks.push(json!({
        "type": "header",
        "text": {
            "type": "plain_text",
            "text": message.header,
            "emoji": true
        }
    }));

    // Section with fields (pairs of label/value as mrkdwn)
    if !message.fields.is_empty() {
        let fields: Vec<Value> = message
            .fields
            .iter()
            .map(|(label, value)| {
                json!({
                    "type": "mrkdwn",
                    "text": format!("*{label}*\n{value}")
                })
            })
            .collect();

        // Slack allows max 10 fields per section; split if needed
        for chunk in fields.chunks(10) {
            blocks.push(json!({
                "type": "section",
                "fields": chunk
            }));
        }
    }

    // Divider
    blocks.push(json!({"type": "divider"}));

    // Context block
    blocks.push(json!({
        "type": "context",
        "elements": [{
            "type": "mrkdwn",
            "text": message.context
        }]
    }));

    // Fallback text for clients that don't support blocks
    let fallback = format!("{}\n{}", message.header, message.context);

    json!({
        "text": fallback,
        "blocks": blocks
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_blocks_payload_structure() {
        let msg = SlackMessage {
            header: "Test Header".to_string(),
            fields: vec![
                ("Cluster".to_string(), "my-cluster".to_string()),
                ("Region".to_string(), "us-east-1".to_string()),
            ],
            context: "Sent by kuo".to_string(),
        };

        let payload = build_blocks_payload(&msg);
        let blocks = payload["blocks"].as_array().unwrap();

        // header, section, divider, context = 4 blocks
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[0]["type"], "header");
        assert_eq!(blocks[0]["text"]["text"], "Test Header");
        assert_eq!(blocks[1]["type"], "section");
        assert_eq!(blocks[1]["fields"].as_array().unwrap().len(), 2);
        assert_eq!(blocks[2]["type"], "divider");
        assert_eq!(blocks[3]["type"], "context");

        // Fallback text
        assert!(payload["text"].as_str().unwrap().contains("Test Header"));
    }

    #[test]
    fn test_build_blocks_payload_empty_fields() {
        let msg = SlackMessage {
            header: "No Fields".to_string(),
            fields: vec![],
            context: "ctx".to_string(),
        };

        let payload = build_blocks_payload(&msg);
        let blocks = payload["blocks"].as_array().unwrap();

        // header, divider, context = 3 blocks (no section)
        assert_eq!(blocks.len(), 3);
        assert_eq!(blocks[0]["type"], "header");
        assert_eq!(blocks[1]["type"], "divider");
        assert_eq!(blocks[2]["type"], "context");
    }

    #[test]
    fn test_field_mrkdwn_format() {
        let msg = SlackMessage {
            header: "H".to_string(),
            fields: vec![("Cluster".to_string(), "prod".to_string())],
            context: "c".to_string(),
        };

        let payload = build_blocks_payload(&msg);
        let field_text = payload["blocks"][1]["fields"][0]["text"].as_str().unwrap();
        assert_eq!(field_text, "*Cluster*\nprod");
    }
}
