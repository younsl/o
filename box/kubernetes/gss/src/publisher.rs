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
