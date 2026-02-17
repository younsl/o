use anyhow::{Context, Result, anyhow};
use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    // Slack Configuration
    pub slack_bot_token: Option<String>,
    pub slack_channel_id: Option<String>,
    pub slack_canvas_id: Option<String>,

    // GitHub Configuration
    pub github_token: String,
    pub github_organization: String,
    pub github_base_url: String,

    // Application Configuration
    pub log_level: String,
    pub request_timeout: u64,
    pub concurrent_scans: usize,
    pub publisher_type: String,

    // Connectivity Configuration
    pub connectivity_max_retries: u32,
    pub connectivity_retry_interval: u64,
    pub connectivity_timeout: u64,
}

impl Config {
    pub fn load() -> Result<Self> {
        // Load required GitHub configuration
        let github_token = get_env_required("GITHUB_TOKEN")?;
        let github_organization = get_env_required("GITHUB_ORG")?;
        let github_base_url = get_env_required("GITHUB_BASE_URL")?;

        // Load optional Slack configuration
        let slack_bot_token = get_env_optional("SLACK_TOKEN");
        let slack_channel_id = get_env_optional("SLACK_CHANNEL_ID");
        let slack_canvas_id = get_env_optional("SLACK_CANVAS_ID");

        // Validate Slack token format if provided
        if let Some(ref token) = slack_bot_token
            && !token.starts_with("xoxb-")
        {
            return Err(anyhow!(
                "SLACK_TOKEN must start with 'xoxb-' (Bot User OAuth Token)"
            ));
        }

        // Load application configuration with defaults
        let log_level = get_env_with_default("LOG_LEVEL", "INFO");
        let request_timeout = get_env_u64_with_default("REQUEST_TIMEOUT", 60);
        let concurrent_scans = get_env_usize_with_default("CONCURRENT_SCANS", 10);
        let publisher_type = get_env_with_default("PUBLISHER_TYPE", "console");

        // Load connectivity configuration with defaults
        let connectivity_max_retries = get_env_u32_with_default("CONNECTIVITY_MAX_RETRIES", 3);
        let connectivity_retry_interval =
            get_env_u64_with_default("CONNECTIVITY_RETRY_INTERVAL", 5);
        let connectivity_timeout = get_env_u64_with_default("CONNECTIVITY_TIMEOUT", 5);

        Ok(Config {
            slack_bot_token,
            slack_channel_id,
            slack_canvas_id,
            github_token,
            github_organization,
            github_base_url,
            log_level,
            request_timeout,
            concurrent_scans,
            publisher_type,
            connectivity_max_retries,
            connectivity_retry_interval,
            connectivity_timeout,
        })
    }

    pub fn validate(&self) -> Result<()> {
        // Validate publisher type specific requirements
        match self.publisher_type.as_str() {
            "slack-canvas" => {
                if self.slack_bot_token.is_none() {
                    return Err(anyhow!(
                        "SLACK_TOKEN is required when using slack-canvas publisher"
                    ));
                }
                if self.slack_channel_id.is_none() {
                    return Err(anyhow!(
                        "SLACK_CHANNEL_ID is required when using slack-canvas publisher"
                    ));
                }
                if self.slack_canvas_id.is_none() {
                    return Err(anyhow!(
                        "SLACK_CANVAS_ID is required when using slack-canvas publisher"
                    ));
                }
            }
            "console" => {
                // No additional validation needed for console publisher
            }
            _ => {
                return Err(anyhow!(
                    "Invalid publisher type: {}. Supported types: console, slack-canvas",
                    self.publisher_type
                ));
            }
        }

        Ok(())
    }
}

fn get_env_required(key: &str) -> Result<String> {
    env::var(key).with_context(|| format!("Environment variable {} is required but not set", key))
}

fn get_env_optional(key: &str) -> Option<String> {
    env::var(key).ok()
}

fn get_env_with_default(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

fn get_env_u64_with_default(key: &str, default: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn get_env_usize_with_default(key: &str, default: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn get_env_u32_with_default(key: &str, default: u32) -> u32 {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[cfg(test)]
impl Config {
    pub fn new_for_test(github_token: String, github_org: String, github_base_url: String) -> Self {
        Self {
            github_token,
            github_organization: github_org,
            github_base_url,
            log_level: "INFO".to_string(),
            request_timeout: 60,
            concurrent_scans: 10,
            publisher_type: "console".to_string(),
            slack_bot_token: None,
            slack_channel_id: None,
            slack_canvas_id: None,
            connectivity_max_retries: 3,
            connectivity_retry_interval: 5,
            connectivity_timeout: 5,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_creation() {
        let config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );

        assert_eq!(config.github_token, "test-token");
        assert_eq!(config.github_organization, "test-org");
        assert_eq!(config.github_base_url, "https://github.example.com");
        assert_eq!(config.log_level, "INFO");
        assert_eq!(config.request_timeout, 60);
        assert_eq!(config.concurrent_scans, 10);
        assert_eq!(config.publisher_type, "console");
    }

    #[test]
    fn test_slack_token_validation() {
        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );

        // Test with invalid Slack token
        config.slack_bot_token = Some("invalid-token".to_string());
        config.publisher_type = "slack-canvas".to_string();

        let result = config.validate();
        assert!(result.is_err());
    }

    #[test]
    fn test_publisher_validation_slack_canvas_missing_token() {
        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );

        config.publisher_type = "slack-canvas".to_string();
        let result = config.validate();
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("SLACK_TOKEN is required")
        );
    }

    #[test]
    fn test_publisher_validation_slack_canvas_missing_channel() {
        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );

        config.publisher_type = "slack-canvas".to_string();
        config.slack_bot_token = Some("xoxb-valid-token".to_string());
        let result = config.validate();
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("SLACK_CHANNEL_ID is required")
        );
    }

    #[test]
    fn test_publisher_validation_console() {
        let config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );

        let result = config.validate();
        assert!(result.is_ok());
    }

    #[test]
    fn test_publisher_validation_invalid_type() {
        let mut config = Config::new_for_test(
            "test-token".to_string(),
            "test-org".to_string(),
            "https://github.example.com".to_string(),
        );

        config.publisher_type = "invalid-type".to_string();
        let result = config.validate();
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Invalid publisher type")
        );
    }
}
