use crate::models::ScanResult;
use crate::publisher::Publisher;
use anyhow::{Context, Result};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::json;
use tracing::info;

const KST_OFFSET_HOURS: i32 = 9;

pub struct SlackCanvasPublisher {
    client: Client,
    token: String,
    canvas_id: String,
}

impl SlackCanvasPublisher {
    pub fn new(token: String, _channel_id: String, canvas_id: String) -> Self {
        Self {
            client: Client::new(),
            token,
            canvas_id,
        }
    }

    fn convert_cron_to_kst(cron: &str) -> String {
        let parts: Vec<&str> = cron.split_whitespace().collect();
        if parts.len() != 5 {
            return cron.to_string();
        }

        let minute = parts[0];
        let hour = parts[1];
        let day = parts[2];
        let month = parts[3];
        let dow = parts[4];

        // Parse hour field (simplified version for Slack)
        let kst_hour = if hour == "*" {
            "*".to_string()
        } else if hour.contains('/') {
            hour.to_string()
        } else if let Ok(h) = hour.parse::<i32>() {
            ((h + KST_OFFSET_HOURS) % 24).to_string()
        } else {
            hour.to_string()
        };

        format!("{} {} {} {} {}", minute, kst_hour, day, month, dow)
    }

    fn format_canvas_content(&self, result: &ScanResult) -> String {
        let mut content = String::new();

        // Header
        content.push_str("# GitHub Scheduled Workflows Report\n\n");

        // Build information
        content.push_str(&format!("**Version:** {}\n", env!("CARGO_PKG_VERSION")));
        content.push_str(&format!(
            "**Build Date:** {}\n",
            option_env!("BUILD_DATE").unwrap_or("unknown")
        ));
        content.push_str(&format!(
            "**Git Commit:** {}\n\n",
            option_env!("GIT_COMMIT").unwrap_or("unknown")
        ));

        // Summary
        content.push_str("## Summary\n\n");
        content.push_str(&format!(
            "- **Total Workflows:** {}\n",
            result.workflows.len()
        ));
        content.push_str(&format!(
            "- **Total Repositories:** {}\n",
            result.total_repos
        ));
        content.push_str(&format!(
            "- **Excluded Repositories:** {}\n",
            result.excluded_repos_count
        ));
        content.push_str(&format!(
            "- **Scan Duration:** {:?}\n\n",
            result.scan_duration
        ));

        // Workflows table
        if result.workflows.is_empty() {
            content.push_str("No scheduled workflows found.\n");
        } else {
            content.push_str("## Scheduled Workflows\n\n");

            for (idx, workflow) in result.workflows.iter().enumerate() {
                let schedules = workflow.cron_schedules.join(", ");
                let kst_schedules = workflow
                    .cron_schedules
                    .iter()
                    .map(|s| Self::convert_cron_to_kst(s))
                    .collect::<Vec<_>>()
                    .join(", ");

                let status_emoji = match workflow.last_status.as_str() {
                    "success" | "completed" => "✅",
                    "failure" | "failed" => "❌",
                    "cancelled" => "🚫",
                    "never_run" => "⏸️",
                    _ => "❓",
                };

                let user_status = if workflow.is_active_user {
                    "✅ Active"
                } else {
                    "⚠️ Inactive"
                };

                content.push_str(&format!("### {}. {}\n", idx + 1, workflow.workflow_name));
                content.push_str(&format!("- **Repository:** `{}`\n", workflow.repo_name));
                content.push_str(&format!(
                    "- **Workflow File:** `{}`\n",
                    workflow.workflow_file_name
                ));
                content.push_str(&format!("- **UTC Schedule:** `{}`\n", schedules));
                content.push_str(&format!("- **KST Schedule:** `{}`\n", kst_schedules));
                content.push_str(&format!(
                    "- **Last Status:** {} {}\n",
                    status_emoji, workflow.last_status
                ));
                content.push_str(&format!(
                    "- **Workflow Last Author:** {} ({})\n",
                    workflow.workflow_last_author, user_status
                ));
                content.push('\n');
            }
        }

        content
    }

    async fn update_canvas(&self, content: &str) -> Result<()> {
        let url = "https://slack.com/api/canvases.edit";

        let payload = json!({
            "canvas_id": self.canvas_id,
            "changes": [{
                "operation": "replace",
                "document_content": {
                    "type": "markdown",
                    "markdown": content
                }
            }]
        });

        let response = self
            .client
            .post(url)
            .header("Authorization", format!("Bearer {}", self.token))
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await
            .context("Failed to send request to Slack API")?;

        let status = response.status();
        let body: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse Slack API response")?;

        if !status.is_success() {
            anyhow::bail!("Slack API request failed with status {}: {}", status, body);
        }

        if let Some(ok) = body.get("ok").and_then(|v| v.as_bool())
            && !ok
        {
            let error = body
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            anyhow::bail!("Slack API returned error: {}", error);
        }

        Ok(())
    }
}

#[async_trait]
impl Publisher for SlackCanvasPublisher {
    async fn publish(&self, result: &ScanResult) -> Result<()> {
        info!("Publishing results to Slack Canvas");

        let content = self.format_canvas_content(result);

        self.update_canvas(&content)
            .await
            .context("Failed to update Slack Canvas")?;

        info!("Successfully published to Slack Canvas");
        Ok(())
    }

    fn name(&self) -> &str {
        "slack-canvas"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_convert_cron_to_kst() {
        assert_eq!(
            SlackCanvasPublisher::convert_cron_to_kst("0 9 * * *"),
            "0 18 * * *"
        );
        assert_eq!(
            SlackCanvasPublisher::convert_cron_to_kst("0 0 * * *"),
            "0 9 * * *"
        );
        assert_eq!(
            SlackCanvasPublisher::convert_cron_to_kst("30 15 * * 1"),
            "30 0 * * 1"
        );
    }

    #[test]
    fn test_format_canvas_content() {
        let publisher = SlackCanvasPublisher::new(
            "xoxb-test".to_string(),
            "C123".to_string(),
            "F456".to_string(),
        );

        let mut result = ScanResult::new();
        result.total_repos = 10;

        let content = publisher.format_canvas_content(&result);
        assert!(content.contains("# GitHub Scheduled Workflows Report"));
        assert!(content.contains("Total Repositories:** 10"));
    }
}
