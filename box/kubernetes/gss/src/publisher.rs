pub mod console;
pub mod slack;

use crate::config::Config;
use crate::models::ScanResult;
use anyhow::{Result, anyhow};
use async_trait::async_trait;

#[async_trait]
pub trait Publisher: Send + Sync {
    async fn publish(&self, result: &ScanResult) -> Result<()>;
    fn name(&self) -> &str;
}

pub struct PublisherFactory;

impl PublisherFactory {
    pub fn create(config: &Config) -> Result<Box<dyn Publisher>> {
        match config.publisher_type.as_str() {
            "console" => Ok(Box::new(console::ConsolePublisher::new())),
            "slack-canvas" => {
                let token = config
                    .slack_bot_token
                    .as_ref()
                    .ok_or_else(|| anyhow!("Slack token is required for slack-canvas publisher"))?;
                let channel_id = config.slack_channel_id.as_ref().ok_or_else(|| {
                    anyhow!("Slack channel ID is required for slack-canvas publisher")
                })?;
                let canvas_id = config.slack_canvas_id.as_ref().ok_or_else(|| {
                    anyhow!("Slack canvas ID is required for slack-canvas publisher")
                })?;

                Ok(Box::new(slack::SlackCanvasPublisher::new(
                    token.clone(),
                    channel_id.clone(),
                    canvas_id.clone(),
                )))
            }
            _ => Err(anyhow!(
                "Unknown publisher type: {}. Supported types: console, slack-canvas",
                config.publisher_type
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;

    #[test]
    fn test_create_console_publisher() {
        let config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );
        let publisher = PublisherFactory::create(&config);
        assert!(publisher.is_ok());
        assert_eq!(publisher.unwrap().name(), "console");
    }

    #[test]
    fn test_create_slack_canvas_publisher() {
        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );
        config.publisher_type = "slack-canvas".to_string();
        config.slack_bot_token = Some("xoxb-test-token".to_string());
        config.slack_channel_id = Some("C123456".to_string());
        config.slack_canvas_id = Some("F789012".to_string());
        let publisher = PublisherFactory::create(&config);
        assert!(publisher.is_ok());
        assert_eq!(publisher.unwrap().name(), "slack-canvas");
    }

    #[test]
    fn test_create_unknown_publisher() {
        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );
        config.publisher_type = "unknown".to_string();
        let result = PublisherFactory::create(&config);
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.to_string().contains("Unknown publisher type"));
    }

    #[test]
    fn test_create_slack_canvas_missing_token() {
        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );
        config.publisher_type = "slack-canvas".to_string();
        let result = PublisherFactory::create(&config);
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.to_string().contains("Slack token is required"));
    }

    #[test]
    fn test_create_slack_canvas_missing_channel() {
        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );
        config.publisher_type = "slack-canvas".to_string();
        config.slack_bot_token = Some("xoxb-test-token".to_string());
        let result = PublisherFactory::create(&config);
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.to_string().contains("Slack channel ID is required"));
    }

    #[test]
    fn test_create_slack_canvas_missing_canvas() {
        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );
        config.publisher_type = "slack-canvas".to_string();
        config.slack_bot_token = Some("xoxb-test-token".to_string());
        config.slack_channel_id = Some("C123456".to_string());
        let result = PublisherFactory::create(&config);
        assert!(result.is_err());
        let err = result.err().unwrap();
        assert!(err.to_string().contains("Slack canvas ID is required"));
    }
}
