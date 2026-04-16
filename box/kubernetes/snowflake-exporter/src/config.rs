use clap::Parser;
use serde::Deserialize;
use std::path::PathBuf;

use crate::error::{Error, Result};

#[derive(Parser, Debug)]
#[command(
    name = "snowflake-exporter",
    version,
    about = "Prometheus exporter for Snowflake"
)]
pub struct Args {
    /// Path to config file
    #[arg(
        short,
        long,
        default_value = "/etc/snowflake-exporter/config.yaml",
        env = "SNOWFLAKE_EXPORTER_CONFIG"
    )]
    pub config: PathBuf,

    /// Listen port (overrides config file)
    #[arg(short, long, env = "SNOWFLAKE_EXPORTER_PORT")]
    pub port: Option<u16>,

    /// Log level (overrides config file)
    #[arg(long, env = "SNOWFLAKE_EXPORTER_LOG_LEVEL")]
    pub log_level: Option<String>,

    /// Log format: json or text (overrides config file)
    #[arg(long, env = "SNOWFLAKE_EXPORTER_LOG_FORMAT")]
    pub log_format: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Config {
    pub server: ServerConfig,
    pub snowflake: SnowflakeConfig,
    pub collection: CollectionConfig,
    pub logging: LoggingConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub listen_address: String,
    pub metrics_path: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct SnowflakeConfig {
    /// Snowflake account identifier (e.g., xy12345.ap-northeast-2.aws).
    pub account: String,
    /// Role used for query execution.
    pub role: String,
    /// Warehouse used for query execution.
    pub warehouse: String,
    /// Database to run queries against (defaults to SNOWFLAKE).
    #[serde(default = "default_database")]
    pub database: String,
    /// Path to a file containing the Programmatic Access Token.
    pub token_path: Option<PathBuf>,
    /// API request timeout in seconds.
    #[serde(default = "default_timeout")]
    pub request_timeout_seconds: u64,
}

fn default_database() -> String {
    "SNOWFLAKE".to_string()
}

fn default_timeout() -> u64 {
    60
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct CollectionConfig {
    /// How often to re-query Snowflake for fresh metrics, in seconds.
    pub interval_seconds: u64,
    /// Skip the storage metric for deleted tables (expensive on large accounts).
    pub exclude_deleted_tables: bool,
    /// Emit per-pipe / per-task / per-materialized-view serverless credit
    /// metrics. Off by default because cardinality scales with the number of
    /// pipes/tasks/MVs in the account.
    pub enable_serverless_detail: bool,
    /// Per-query timeout in seconds. Individual collectors exceeding this are aborted.
    pub query_timeout_seconds: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct LoggingConfig {
    pub level: String,
    pub format: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen_address: "0.0.0.0:9975".to_string(),
            metrics_path: "/metrics".to_string(),
        }
    }
}

impl Default for CollectionConfig {
    fn default() -> Self {
        Self {
            interval_seconds: 300,
            exclude_deleted_tables: false,
            enable_serverless_detail: false,
            query_timeout_seconds: 120,
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

impl Config {
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

        if let Some(port) = args.port {
            config.server.listen_address = format!("0.0.0.0:{port}");
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
        if self.snowflake.account.is_empty() {
            return Err(Error::Config("snowflake.account must not be empty".into()));
        }
        if self.snowflake.role.is_empty() {
            return Err(Error::Config("snowflake.role must not be empty".into()));
        }
        if self.snowflake.warehouse.is_empty() {
            return Err(Error::Config(
                "snowflake.warehouse must not be empty".into(),
            ));
        }
        if self.snowflake.token_path.is_none() {
            return Err(Error::Config(
                "snowflake.token_path must be set (PAT authentication is required)".into(),
            ));
        }
        if self.collection.interval_seconds == 0 {
            return Err(Error::Config(
                "collection.interval_seconds must be > 0".into(),
            ));
        }
        if self.collection.query_timeout_seconds == 0 {
            return Err(Error::Config(
                "collection.query_timeout_seconds must be > 0".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_yaml() -> &'static str {
        r#"
snowflake:
  account: xy12345.ap-northeast-2.aws
  role: METRICS_ROLE
  warehouse: METRICS_WH
  token_path: /etc/snowflake-exporter/keys/token
"#
    }

    #[test]
    fn test_default_config() {
        let c = Config::default();
        assert_eq!(c.server.listen_address, "0.0.0.0:9975");
        assert_eq!(c.collection.interval_seconds, 300);
        assert!(!c.collection.exclude_deleted_tables);
        assert_eq!(c.snowflake.database, String::new());
        assert_eq!(c.logging.format, "json");
    }

    #[test]
    fn test_parse_yaml_minimal() {
        let c: Config = serde_yaml::from_str(base_yaml()).unwrap();
        assert_eq!(c.snowflake.account, "xy12345.ap-northeast-2.aws");
        assert_eq!(c.snowflake.database, "SNOWFLAKE");
        assert_eq!(c.snowflake.request_timeout_seconds, 60);
        assert_eq!(
            c.snowflake.token_path.as_deref(),
            Some(std::path::Path::new("/etc/snowflake-exporter/keys/token"))
        );
    }

    #[test]
    fn test_validate_missing_account() {
        let mut c: Config = serde_yaml::from_str(base_yaml()).unwrap();
        c.snowflake.account.clear();
        assert!(c.validate().is_err());
    }

    #[test]
    fn test_validate_missing_role() {
        let mut c: Config = serde_yaml::from_str(base_yaml()).unwrap();
        c.snowflake.role.clear();
        assert!(c.validate().is_err());
    }

    #[test]
    fn test_validate_missing_warehouse() {
        let mut c: Config = serde_yaml::from_str(base_yaml()).unwrap();
        c.snowflake.warehouse.clear();
        assert!(c.validate().is_err());
    }

    #[test]
    fn test_validate_missing_token_path() {
        let mut c: Config = serde_yaml::from_str(base_yaml()).unwrap();
        c.snowflake.token_path = None;
        assert!(c.validate().is_err());
    }

    #[test]
    fn test_validate_zero_interval() {
        let mut c: Config = serde_yaml::from_str(base_yaml()).unwrap();
        c.collection.interval_seconds = 0;
        assert!(c.validate().is_err());
    }

    #[test]
    fn test_validate_zero_query_timeout() {
        let mut c: Config = serde_yaml::from_str(base_yaml()).unwrap();
        c.collection.query_timeout_seconds = 0;
        assert!(c.validate().is_err());
    }

    #[test]
    fn test_validate_ok() {
        let c: Config = serde_yaml::from_str(base_yaml()).unwrap();
        assert!(c.validate().is_ok());
    }

    #[test]
    fn test_load_applies_cli_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("config.yaml");
        std::fs::write(&cfg_path, base_yaml()).unwrap();

        let args = Args {
            config: cfg_path,
            port: Some(8080),
            log_level: Some("debug".to_string()),
            log_format: Some("text".to_string()),
        };
        let c = Config::load(&args).unwrap();
        assert_eq!(c.server.listen_address, "0.0.0.0:8080");
        assert_eq!(c.logging.level, "debug");
        assert_eq!(c.logging.format, "text");
    }
}
