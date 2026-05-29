use std::sync::Arc;
use std::time::Duration;
use tracing::{debug, error, info, warn};

use crate::metrics::Metrics;

/// Periodic health checker for the central server
pub struct HealthChecker {
    client: reqwest::Client,
    server_url: String,
    interval_secs: u64,
    metrics: Arc<Metrics>,
}

impl HealthChecker {
    pub fn new(
        server_url: String,
        interval_secs: u64,
        metrics: Arc<Metrics>,
    ) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .connect_timeout(Duration::from_secs(5))
            .build()?;

        Ok(Self {
            client,
            server_url,
            interval_secs,
            metrics,
        })
    }

    /// Run the health checker in a loop until shutdown signal is received
    pub async fn run(&self, mut shutdown: tokio::sync::watch::Receiver<bool>) {
        if self.interval_secs == 0 {
            debug!("Health check disabled (interval_secs=0)");
            return;
        }

        let interval = Duration::from_secs(self.interval_secs);
        info!(
            server_url = %self.server_url,
            interval_secs = self.interval_secs,
            "Starting periodic server health check"
        );

        // Initial health check
        self.check().await;

        loop {
            tokio::select! {
                _ = tokio::time::sleep(interval) => {
                    self.check().await;
                }
                _ = shutdown.changed() => {
                    debug!("Health checker shutting down");
                    break;
                }
            }
        }
    }

    /// Perform a single health check and log the result
    async fn check(&self) -> bool {
        let url = format!("{}/healthz", self.server_url);
        let start = std::time::Instant::now();

        match self.client.get(&url).send().await {
            Ok(response) => {
                let elapsed = start.elapsed();
                let status = response.status();

                if status.is_success() {
                    if let Some(ref gauge) = self.metrics.server_up {
                        gauge.set(1);
                    }
                    info!(
                        server_url = %self.server_url,
                        status = "success",
                        response_time_ms = elapsed.as_millis(),
                        interval_secs = self.interval_secs,
                        "Server health check passed"
                    );
                    true
                } else {
                    if let Some(ref gauge) = self.metrics.server_up {
                        gauge.set(0);
                    }
                    warn!(
                        server_url = %self.server_url,
                        status = "failed",
                        http_status = %status,
                        response_time_ms = elapsed.as_millis(),
                        interval_secs = self.interval_secs,
                        "Server health check failed: unexpected status"
                    );
                    false
                }
            }
            Err(e) => {
                let elapsed = start.elapsed();
                if let Some(ref gauge) = self.metrics.server_up {
                    gauge.set(0);
                }
                error!(
                    server_url = %self.server_url,
                    status = "failed",
                    error = %e,
                    response_time_ms = elapsed.as_millis(),
                    interval_secs = self.interval_secs,
                    "Server health check failed: connection error"
                );
                false
            }
        }
    }
}
