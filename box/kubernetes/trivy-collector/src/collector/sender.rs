use anyhow::{Context, Result};
use std::time::Duration;
use tracing::{debug, error, info, warn};

use crate::collector::types::{ReportEvent, ReportEventType, ReportPayload};

pub struct ReportSender {
    client: reqwest::Client,
    server_url: String,
    cluster_name: String,
    retry_attempts: u32,
    retry_delay: Duration,
}

impl ReportSender {
    pub fn new(
        server_url: String,
        cluster_name: String,
        retry_attempts: u32,
        retry_delay_secs: u64,
    ) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .context("Failed to create HTTP client")?;

        Ok(Self {
            client,
            server_url,
            cluster_name,
            retry_attempts,
            retry_delay: Duration::from_secs(retry_delay_secs),
        })
    }

    pub async fn send_report(
        &self,
        report_type: &str,
        namespace: &str,
        name: &str,
        data: serde_json::Value,
        event_type: ReportEventType,
    ) -> Result<()> {
        let payload = ReportPayload {
            cluster: self.cluster_name.clone(),
            report_type: report_type.to_string(),
            namespace: namespace.to_string(),
            name: name.to_string(),
            data,
            received_at: chrono::Utc::now(),
        };

        let event = ReportEvent {
            event_type,
            payload,
        };

        self.send_with_retry(&event).await
    }

    async fn send_with_retry(&self, event: &ReportEvent) -> Result<()> {
        let mut last_error = None;

        for attempt in 1..=self.retry_attempts {
            match self.send_once(event).await {
                Ok(()) => {
                    if attempt > 1 {
                        info!(
                            attempt = attempt,
                            cluster = %event.payload.cluster,
                            report_type = %event.payload.report_type,
                            namespace = %event.payload.namespace,
                            name = %event.payload.name,
                            "Successfully sent report after retry"
                        );
                    }
                    return Ok(());
                }
                Err(e) => {
                    last_error = Some(e);
                    if attempt < self.retry_attempts {
                        warn!(
                            attempt = attempt,
                            max_attempts = self.retry_attempts,
                            cluster = %event.payload.cluster,
                            report_type = %event.payload.report_type,
                            namespace = %event.payload.namespace,
                            name = %event.payload.name,
                            "Failed to send report, retrying..."
                        );
                        tokio::time::sleep(self.retry_delay).await;
                    }
                }
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Unknown error")))
    }

    async fn send_once(&self, event: &ReportEvent) -> Result<()> {
        let url = format!("{}/api/v1/reports", self.server_url);

        debug!(
            url = %url,
            cluster = %event.payload.cluster,
            report_type = %event.payload.report_type,
            namespace = %event.payload.namespace,
            name = %event.payload.name,
            "Sending report to server"
        );

        let response = self
            .client
            .post(&url)
            .json(event)
            .send()
            .await
            .context("Failed to send HTTP request")?;

        let status = response.status();
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "Unable to read response body".to_string());
            error!(
                status = %status,
                body = %body,
                "Server returned error response"
            );
            anyhow::bail!("Server returned status {}: {}", status, body);
        }

        debug!(
            cluster = %event.payload.cluster,
            report_type = %event.payload.report_type,
            namespace = %event.payload.namespace,
            name = %event.payload.name,
            "Report sent successfully"
        );

        Ok(())
    }

    pub fn cluster_name(&self) -> &str {
        &self.cluster_name
    }

    pub fn server_url(&self) -> &str {
        &self.server_url
    }
}
