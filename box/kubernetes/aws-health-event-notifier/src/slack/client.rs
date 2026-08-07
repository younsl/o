use std::time::Duration;

use reqwest::Client;
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;

use crate::error::{AppError, AppResult};

#[derive(Clone)]
pub struct SlackClient {
    http: Client,
    webhook_url: SecretString,
}

impl SlackClient {
    pub fn new(webhook_url: SecretString, timeout: Duration) -> AppResult<Self> {
        let http = Client::builder()
            .timeout(timeout)
            .user_agent(concat!(
                "aws-health-event-notifier/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()
            .map_err(|e| AppError::Other(anyhow::anyhow!("build slack http client: {e}")))?;
        Ok(Self { http, webhook_url })
    }

    pub async fn post(&self, payload: &Value) -> AppResult<()> {
        let resp = self
            .http
            .post(self.webhook_url.expose_secret())
            .json(payload)
            .send()
            .await
            .map_err(|e| AppError::Slack(format!("request failed: {e}")))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(AppError::Slack(format!("status={status} body={body}")));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client(url: &str) -> SlackClient {
        SlackClient::new(SecretString::from(url.to_string()), Duration::from_secs(5)).unwrap()
    }

    #[tokio::test]
    async fn post_ok_on_2xx() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/hook"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;
        let c = client(&format!("{}/hook", server.uri()));
        assert!(c.post(&json!({"text": "hi"})).await.is_ok());
    }

    #[tokio::test]
    async fn post_errors_on_non_2xx() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(403).set_body_string("invalid_token"))
            .mount(&server)
            .await;
        let c = client(&server.uri());
        let err = c.post(&json!({"text": "hi"})).await.unwrap_err();
        assert!(matches!(err, AppError::Slack(m) if m.contains("403")));
    }

    #[tokio::test]
    async fn post_errors_on_connection_failure() {
        // Unroutable port: request itself fails before any response.
        let c = client("http://127.0.0.1:1/hook");
        let err = c.post(&json!({"text": "hi"})).await.unwrap_err();
        assert!(matches!(err, AppError::Slack(m) if m.contains("request failed")));
    }
}
