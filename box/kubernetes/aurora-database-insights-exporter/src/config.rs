use clap::Parser;
use serde::Deserialize;
use std::path::PathBuf;

use crate::error::{Error, Result};

#[derive(Parser, Debug)]
#[command(name = "adie", about = "Aurora Database Insights Exporter")]
pub struct Args {
    /// Path to config file
    #[arg(
        short,
        long,
        default_value = "/etc/adie/config.yaml",
        env = "ADIE_CONFIG"
    )]
    pub config: PathBuf,

    /// Listen port (overrides config file)
    #[arg(short, long, env = "ADIE_PORT")]
    pub port: Option<u16>,

    /// AWS region (overrides config file)
    #[arg(long, env = "ADIE_AWS_REGION")]
    pub region: Option<String>,

    /// Log level (overrides config file)
    #[arg(long, env = "ADIE_LOG_LEVEL")]
    pub log_level: Option<String>,

    /// Log format: json or text (overrides config file)
    #[arg(long, env = "ADIE_LOG_FORMAT")]
    pub log_format: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
#[derive(Default)]
pub struct Config {
    pub server: ServerConfig,
    pub aws: AwsConfig,
    pub discovery: DiscoveryConfig,
    pub collection: CollectionConfig,
    pub logging: LoggingConfig,
    pub leader_election: LeaderElectionConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub listen_address: String,
    pub metrics_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct AwsConfig {
    pub region: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct DiscoveryConfig {
    pub interval_seconds: u64,
    /// Target RDS engine to discover.
    pub engine: String,
    /// Only discover instances with Performance Insights enabled.
    pub require_pi_enabled: bool,
    pub include: FilterConfig,
    pub exclude: FilterConfig,
    /// AWS tags to export as additional Prometheus labels (YACE-style exported_tags).
    pub exported_tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct FilterConfig {
    pub identifier: Vec<String>,
    pub tags: Vec<TagFilter>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TagFilter {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct CollectionConfig {
    pub interval_seconds: u64,
    pub pi_period_seconds: i32,
    pub top_sql_limit: i32,
    pub top_host_limit: i32,
    pub max_concurrent_api_calls: usize,
    pub retry: RetryConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct RetryConfig {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct LoggingConfig {
    pub level: String,
    pub format: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct LeaderElectionConfig {
    pub enabled: bool,
    pub lease_name: String,
    pub lease_namespace: String,
    pub lease_duration_seconds: u64,
    pub renew_deadline_seconds: u64,
    pub retry_period_seconds: u64,
}

// --- Default implementations ---

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen_address: "0.0.0.0:9090".to_string(),
            metrics_path: "/metrics".to_string(),
        }
    }
}

impl Default for AwsConfig {
    fn default() -> Self {
        Self {
            region: "ap-northeast-2".to_string(),
        }
    }
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        Self {
            interval_seconds: 300,
            engine: "aurora-mysql".to_string(),
            require_pi_enabled: true,
            include: FilterConfig::default(),
            exclude: FilterConfig::default(),
            exported_tags: Vec::new(),
        }
    }
}

impl Default for CollectionConfig {
    fn default() -> Self {
        Self {
            interval_seconds: 60,
            pi_period_seconds: 60,
            top_sql_limit: 10,
            top_host_limit: 20,
            max_concurrent_api_calls: 5,
            retry: RetryConfig::default(),
        }
    }
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay_ms: 1000,
        }
    }
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: "info".to_string(),
            format: "json".to_string(),
        }
    }
}

impl Default for LeaderElectionConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            lease_name: "adie-leader".to_string(),
            lease_namespace: std::env::var("POD_NAMESPACE")
                .unwrap_or_else(|_| "default".to_string()),
            lease_duration_seconds: 15,
            renew_deadline_seconds: 10,
            retry_period_seconds: 2,
        }
    }
}

impl Config {
    /// Load config from YAML file, falling back to defaults if file doesn't exist.
    pub fn load(args: &Args) -> Result<Self> {
        let mut config = if args.config.exists() {
            let content = std::fs::read_to_string(&args.config)?;
            serde_yaml::from_str(&content)?
        } else {
            tracing::warn!(
                path = %args.config.display(),
                "Config file not found. Using defaults"
            );
            Config::default()
        };

        // CLI overrides
        if let Some(port) = args.port {
            config.server.listen_address = format!("0.0.0.0:{port}");
        }
        if let Some(ref region) = args.region {
            config.aws.region = region.clone();
        }
        if let Some(ref level) = args.log_level {
            config.logging.level = level.clone();
        }
        if let Some(ref format) = args.log_format {
            config.logging.format = format.clone();
        }

        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
        if self.discovery.engine.is_empty() {
            return Err(Error::Config(
                "discovery.engine must not be empty".to_string(),
            ));
        }
        if self.discovery.interval_seconds == 0 {
            return Err(Error::Config(
                "discovery.interval_seconds must be > 0".to_string(),
            ));
        }
        if self.collection.interval_seconds == 0 {
            return Err(Error::Config(
                "collection.interval_seconds must be > 0".to_string(),
            ));
        }
        if self.collection.top_sql_limit < 1 || self.collection.top_sql_limit > 25 {
            return Err(Error::Config(
                "collection.top_sql_limit must be 1..25".to_string(),
            ));
        }
        if self.collection.top_host_limit < 1 || self.collection.top_host_limit > 50 {
            return Err(Error::Config(
                "collection.top_host_limit must be 1..50".to_string(),
            ));
        }
        Ok(())
    }

    /// Extract the port from listen_address.
    #[allow(dead_code)]
    pub fn port(&self) -> u16 {
        self.server
            .listen_address
            .rsplit(':')
            .next()
            .and_then(|p| p.parse().ok())
            .unwrap_or(9090)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = Config::default();
        assert_eq!(config.server.listen_address, "0.0.0.0:9090");
        assert_eq!(config.aws.region, "ap-northeast-2");
        assert_eq!(config.discovery.interval_seconds, 300);
        assert_eq!(config.collection.interval_seconds, 60);
        assert_eq!(config.collection.top_sql_limit, 10);
        assert_eq!(config.collection.top_host_limit, 20);
        assert_eq!(config.collection.max_concurrent_api_calls, 5);
        assert_eq!(config.collection.retry.max_attempts, 3);
        assert_eq!(config.logging.level, "info");
        assert_eq!(config.logging.format, "json");
    }

    #[test]
    fn test_parse_yaml_config() {
        let yaml = r#"
server:
  listen_address: "0.0.0.0:8080"
aws:
  region: "us-east-1"
discovery:
  interval_seconds: 600
collection:
  top_sql_limit: 5
  top_host_limit: 10
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.server.listen_address, "0.0.0.0:8080");
        assert_eq!(config.aws.region, "us-east-1");
        assert_eq!(config.discovery.interval_seconds, 600);
        assert_eq!(config.collection.top_sql_limit, 5);
        assert_eq!(config.collection.top_host_limit, 10);
        // Defaults for unspecified fields
        assert_eq!(config.collection.interval_seconds, 60);
    }

    #[test]
    fn test_parse_empty_yaml() {
        let config: Config = serde_yaml::from_str("{}").unwrap();
        assert_eq!(config.server.listen_address, "0.0.0.0:9090");
    }

    #[test]
    fn test_validate_zero_discovery_interval() {
        let mut config = Config::default();
        config.discovery.interval_seconds = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_zero_collection_interval() {
        let mut config = Config::default();
        config.collection.interval_seconds = 0;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_invalid_top_sql_limit() {
        let mut config = Config::default();
        config.collection.top_sql_limit = 0;
        assert!(config.validate().is_err());

        config.collection.top_sql_limit = 26;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_invalid_top_host_limit() {
        let mut config = Config::default();
        config.collection.top_host_limit = 0;
        assert!(config.validate().is_err());

        config.collection.top_host_limit = 51;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_validate_valid_config() {
        let config = Config::default();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_port_extraction() {
        let config = Config::default();
        assert_eq!(config.port(), 9090);

        let mut config2 = Config::default();
        config2.server.listen_address = "0.0.0.0:8080".to_string();
        assert_eq!(config2.port(), 8080);
    }

    #[test]
    fn test_parse_yaml_with_filters() {
        let yaml = r#"
discovery:
  include:
    identifier: ["^prod-"]
    tags:
      - key: "Environment"
        value: "production"
  exclude:
    identifier: ["-test$"]
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.discovery.include.identifier, vec!["^prod-"]);
        assert_eq!(config.discovery.include.tags.len(), 1);
        assert_eq!(config.discovery.include.tags[0].key, "Environment");
        assert_eq!(config.discovery.exclude.identifier, vec!["-test$"]);
    }

    #[test]
    fn test_parse_yaml_with_exported_tags() {
        let yaml = r#"
discovery:
  exported_tags:
    - Team
    - Environment
    - Service
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.discovery.exported_tags.len(), 3);
        assert_eq!(config.discovery.exported_tags[0], "Team");
    }

    #[test]
    fn test_parse_yaml_with_leader_election() {
        let yaml = r#"
leader_election:
  enabled: true
  lease_name: "my-lease"
  lease_namespace: "monitoring"
  lease_duration_seconds: 30
  renew_deadline_seconds: 20
  retry_period_seconds: 5
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert!(config.leader_election.enabled);
        assert_eq!(config.leader_election.lease_name, "my-lease");
        assert_eq!(config.leader_election.lease_namespace, "monitoring");
        assert_eq!(config.leader_election.lease_duration_seconds, 30);
    }

    #[test]
    fn test_default_leader_election() {
        let config = Config::default();
        assert!(config.leader_election.enabled);
        assert_eq!(config.leader_election.lease_name, "adie-leader");
        assert_eq!(config.leader_election.lease_duration_seconds, 15);
        assert_eq!(config.leader_election.renew_deadline_seconds, 10);
        assert_eq!(config.leader_election.retry_period_seconds, 2);
    }

    #[test]
    fn test_default_exported_tags_empty() {
        let config = Config::default();
        assert!(config.discovery.exported_tags.is_empty());
    }

    #[test]
    fn test_load_nonexistent_config() {
        let args = Args {
            config: std::path::PathBuf::from("/tmp/nonexistent-adie-config.yaml"),
            port: None,
            region: None,
            log_level: None,
            log_format: None,
        };
        let config = Config::load(&args).unwrap();
        assert_eq!(config.server.listen_address, "0.0.0.0:9090");
    }

    #[test]
    fn test_load_with_cli_overrides() {
        let args = Args {
            config: std::path::PathBuf::from("/tmp/nonexistent-adie-config.yaml"),
            port: Some(8080),
            region: Some("us-west-2".to_string()),
            log_level: Some("debug".to_string()),
            log_format: Some("text".to_string()),
        };
        let config = Config::load(&args).unwrap();
        assert_eq!(config.server.listen_address, "0.0.0.0:8080");
        assert_eq!(config.aws.region, "us-west-2");
        assert_eq!(config.logging.level, "debug");
        assert_eq!(config.logging.format, "text");
    }

    #[test]
    fn test_parse_yaml_with_retry() {
        let yaml = r#"
collection:
  retry:
    max_attempts: 5
    base_delay_ms: 2000
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.collection.retry.max_attempts, 5);
        assert_eq!(config.collection.retry.base_delay_ms, 2000);
    }

    #[test]
    fn test_validate_boundary_top_sql_limit() {
        let mut config = Config::default();
        config.collection.top_sql_limit = 1;
        assert!(config.validate().is_ok());

        config.collection.top_sql_limit = 25;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_boundary_top_host_limit() {
        let mut config = Config::default();
        config.collection.top_host_limit = 1;
        assert!(config.validate().is_ok());

        config.collection.top_host_limit = 50;
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_empty_engine() {
        let mut config = Config::default();
        config.discovery.engine = "".to_string();
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_default_engine_and_pi() {
        let config = Config::default();
        assert_eq!(config.discovery.engine, "aurora-mysql");
        assert!(config.discovery.require_pi_enabled);
    }

    #[test]
    fn test_parse_yaml_with_engine() {
        let yaml = r#"
discovery:
  engine: "aurora-postgresql"
  require_pi_enabled: false
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(config.discovery.engine, "aurora-postgresql");
        assert!(!config.discovery.require_pi_enabled);
    }
}
