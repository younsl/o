use crate::config::Config;
use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use std::time::Duration;
use tracing::{info, warn};

#[derive(Debug, Deserialize)]
struct ServerMeta {
    // Fields exist in API response but we don't need to read them
}

pub struct ConnectivityChecker {
    client: Client,
    base_url: String,
    max_retries: u32,
    retry_interval: Duration,
}

impl ConnectivityChecker {
    pub fn new(config: &Config) -> Result<Self> {
        let timeout = Duration::from_secs(config.connectivity_timeout);
        let client = Client::builder()
            .timeout(timeout)
            .build()
            .context("Failed to create HTTP client")?;

        Ok(Self {
            client,
            base_url: config.github_base_url.clone(),
            max_retries: config.connectivity_max_retries,
            retry_interval: Duration::from_secs(config.connectivity_retry_interval),
        })
    }

    pub async fn verify_connectivity(&self) -> Result<()> {
        let url = format!("{}/api/v3/meta", self.base_url.trim_end_matches('/'));

        for attempt in 1..=self.max_retries {
            let start = std::time::Instant::now();
            match self.check_endpoint(&url).await {
                Ok(_) => {
                    let elapsed = start.elapsed();
                    info!(
                        response_time_ms = elapsed.as_millis() as u64,
                        "Successfully connected to GitHub Enterprise Server"
                    );
                    return Ok(());
                }
                Err(e) => {
                    let elapsed = start.elapsed();
                    if attempt < self.max_retries {
                        warn!(
                            attempt = attempt,
                            max_retries = self.max_retries,
                            response_time_ms = elapsed.as_millis() as u64,
                            retry_interval_secs = self.retry_interval.as_secs(),
                            error = %e,
                            "Connectivity check failed, retrying"
                        );
                        tokio::time::sleep(self.retry_interval).await;
                    } else {
                        return Err(e).context(format!(
                            "Failed to connect to GitHub Enterprise Server after {} attempts",
                            self.max_retries
                        ));
                    }
                }
            }
        }

        unreachable!()
    }

    async fn check_endpoint(&self, url: &str) -> Result<ServerMeta> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .context("Failed to send request to GitHub Enterprise Server")?;

        if !response.status().is_success() {
            anyhow::bail!(
                "GitHub Enterprise Server returned non-success status: {}",
                response.status()
            );
        }

        let meta: ServerMeta = response
            .json()
            .await
            .context("Failed to parse server meta response")?;

        Ok(meta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn test_connectivity_checker_creation() {
        let config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://api.github.com".to_string(),
        );
        let checker = ConnectivityChecker::new(&config);
        assert!(checker.is_ok());
    }

    #[tokio::test]
    async fn test_verify_connectivity_success() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/meta"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({})))
            .mount(&mock_server)
            .await;

        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            mock_server.uri(),
        );
        config.connectivity_max_retries = 1;

        let checker = ConnectivityChecker::new(&config).unwrap();
        let result = checker.verify_connectivity().await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_verify_connectivity_non_success_status() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/meta"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock_server)
            .await;

        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            mock_server.uri(),
        );
        config.connectivity_max_retries = 1;

        let checker = ConnectivityChecker::new(&config).unwrap();
        let result = checker.verify_connectivity().await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_verify_connectivity_all_retries_fail() {
        let mock_server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/meta"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&mock_server)
            .await;

        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            mock_server.uri(),
        );
        config.connectivity_max_retries = 2;
        config.connectivity_retry_interval = 1;

        let checker = ConnectivityChecker::new(&config).unwrap();
        let result = checker.verify_connectivity().await;
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("after 2 attempts"));
    }
}
