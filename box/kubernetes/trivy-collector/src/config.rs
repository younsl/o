use clap::{Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};

// ============================================
// Environment variable name constants
// These are shared between config parsing and API exposure
// ============================================
pub mod env {
    pub const MODE: &str = "MODE";
    pub const LOG_FORMAT: &str = "LOG_FORMAT";
    pub const LOG_LEVEL: &str = "LOG_LEVEL";
    pub const HEALTH_PORT: &str = "HEALTH_PORT";
    pub const SERVER_URL: &str = "SERVER_URL";
    pub const CLUSTER_NAME: &str = "CLUSTER_NAME";
    pub const NAMESPACES: &str = "NAMESPACES";
    pub const COLLECT_VULN: &str = "COLLECT_VULN";
    pub const COLLECT_SBOM: &str = "COLLECT_SBOM";
    pub const RETRY_ATTEMPTS: &str = "RETRY_ATTEMPTS";
    pub const RETRY_DELAY_SECS: &str = "RETRY_DELAY_SECS";
    pub const HEALTH_CHECK_INTERVAL_SECS: &str = "HEALTH_CHECK_INTERVAL_SECS";
    pub const SERVER_PORT: &str = "SERVER_PORT";
    pub const STORAGE_PATH: &str = "STORAGE_PATH";
    pub const WATCH_LOCAL: &str = "WATCH_LOCAL";

    // Authentication
    pub use crate::auth::config::env::*;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Collector mode: Watch Trivy CRDs and send to central server
    Collector,
    /// Server mode: Receive reports, store in SQLite, serve UI
    Server,
}

impl std::fmt::Display for Mode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Mode::Collector => write!(f, "collector"),
            Mode::Server => write!(f, "server"),
        }
    }
}

#[derive(Subcommand, Debug, Clone)]
pub enum Command {
    /// Show version information
    Version,
}

#[derive(Parser, Debug, Clone)]
#[command(
    name = "trivy-collector",
    version,
    about = "Multi-cluster Trivy report collector and viewer",
    long_about = "A Kubernetes application that collects Trivy Operator reports from multiple clusters and provides a centralized UI for viewing and filtering security reports."
)]
pub struct Config {
    #[command(subcommand)]
    pub command: Option<Command>,
    /// Deployment mode
    #[arg(long, env = env::MODE, value_enum, default_value = "collector")]
    pub mode: Mode,

    /// Log format: json or pretty
    #[arg(long, env = env::LOG_FORMAT, default_value = "json")]
    pub log_format: String,

    /// Log level: trace, debug, info, warn, error
    #[arg(long, env = env::LOG_LEVEL, default_value = "info")]
    pub log_level: String,

    /// Health check server port
    #[arg(long, env = env::HEALTH_PORT, default_value = "8080")]
    pub health_port: u16,

    // ============================================
    // Collector mode settings
    // ============================================
    /// Central server URL (collector mode only)
    #[arg(long, env = env::SERVER_URL)]
    pub server_url: Option<String>,

    /// Cluster identifier
    #[arg(long, env = env::CLUSTER_NAME, default_value = "local")]
    pub cluster_name: String,

    /// Namespaces to watch, comma-separated (empty = all namespaces)
    #[arg(long, env = env::NAMESPACES, value_delimiter = ',')]
    pub namespaces: Vec<String>,

    /// Collect VulnerabilityReports
    #[arg(long, env = env::COLLECT_VULN, default_value = "true")]
    pub collect_vulnerability_reports: bool,

    /// Collect SbomReports
    #[arg(long, env = env::COLLECT_SBOM, default_value = "true")]
    pub collect_sbom_reports: bool,

    /// Retry attempts on failure
    #[arg(long, env = env::RETRY_ATTEMPTS, default_value = "3")]
    pub retry_attempts: u32,

    /// Retry delay in seconds
    #[arg(long, env = env::RETRY_DELAY_SECS, default_value = "5")]
    pub retry_delay_secs: u64,

    /// Health check interval in seconds (0 to disable)
    #[arg(long, env = env::HEALTH_CHECK_INTERVAL_SECS, default_value = "30")]
    pub health_check_interval_secs: u64,

    // ============================================
    // Server mode settings
    // ============================================
    /// API/UI server port (server mode only)
    #[arg(long, env = env::SERVER_PORT, default_value = "3000")]
    pub server_port: u16,

    /// Storage path for SQLite database (server mode only)
    #[arg(long, env = env::STORAGE_PATH, default_value = "/data")]
    pub storage_path: String,

    /// Enable local Kubernetes API watching in server mode
    #[arg(long, env = env::WATCH_LOCAL, default_value = "true")]
    pub watch_local: bool,

    // ============================================
    // Authentication settings (server mode only)
    // ============================================
    /// Authentication mode: "none" or "keycloak"
    #[arg(long, env = env::AUTH_MODE, default_value = "none")]
    pub auth_mode: String,

    /// OIDC issuer URL (required for keycloak mode)
    #[arg(long, env = env::OIDC_ISSUER_URL)]
    pub oidc_issuer_url: Option<String>,

    /// OIDC client ID (required for keycloak mode)
    #[arg(long, env = env::OIDC_CLIENT_ID)]
    pub oidc_client_id: Option<String>,

    /// OIDC client secret (required for keycloak mode)
    #[arg(long, env = env::OIDC_CLIENT_SECRET)]
    pub oidc_client_secret: Option<String>,

    /// OIDC redirect URL (required for keycloak mode)
    #[arg(long, env = env::OIDC_REDIRECT_URL)]
    pub oidc_redirect_url: Option<String>,

    /// OIDC scopes (space-separated)
    #[arg(long, env = env::OIDC_SCOPES, default_value = "openid profile email groups")]
    pub oidc_scopes: String,
}

impl Config {
    pub fn from_args() -> Self {
        Config::parse()
    }

    /// Validate configuration based on mode
    pub fn validate(&self) -> Result<(), String> {
        match self.mode {
            Mode::Collector => {
                if self.server_url.is_none() {
                    return Err("SERVER_URL is required in collector mode".to_string());
                }
            }
            Mode::Server => {
                if self.auth_mode == "keycloak" {
                    crate::auth::config::validate_keycloak_config(
                        &self.oidc_issuer_url,
                        &self.oidc_client_id,
                        &self.oidc_client_secret,
                        &self.oidc_redirect_url,
                    )?;
                }
            }
        }
        Ok(())
    }

    /// Get server URL (collector mode)
    pub fn get_server_url(&self) -> &str {
        self.server_url.as_deref().unwrap_or("")
    }

    /// Get cluster name
    pub fn get_cluster_name(&self) -> &str {
        &self.cluster_name
    }

    /// Get SQLite database path
    pub fn get_db_path(&self) -> String {
        format!("{}/trivy.db", self.storage_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_config(mode: Mode) -> Config {
        Config {
            command: None,
            mode,
            log_format: "json".to_string(),
            log_level: "info".to_string(),
            health_port: 8080,
            server_url: None,
            cluster_name: "local".to_string(),
            namespaces: vec![],
            collect_vulnerability_reports: true,
            collect_sbom_reports: true,
            retry_attempts: 3,
            retry_delay_secs: 5,
            health_check_interval_secs: 30,
            server_port: 3000,
            storage_path: "/data".to_string(),
            watch_local: true,
            auth_mode: "none".to_string(),
            oidc_issuer_url: None,
            oidc_client_id: None,
            oidc_client_secret: None,
            oidc_redirect_url: None,
            oidc_scopes: "openid profile email groups".to_string(),
        }
    }

    #[test]
    fn test_validate_collector_without_server_url() {
        let config = default_config(Mode::Collector);
        assert!(config.validate().is_err());
        assert_eq!(
            config.validate().unwrap_err(),
            "SERVER_URL is required in collector mode"
        );
    }

    #[test]
    fn test_validate_collector_with_server_url() {
        let mut config = default_config(Mode::Collector);
        config.server_url = Some("http://server:3000".to_string());
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_server_mode() {
        let config = default_config(Mode::Server);
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_get_server_url_present() {
        let mut config = default_config(Mode::Collector);
        config.server_url = Some("http://server:3000".to_string());
        assert_eq!(config.get_server_url(), "http://server:3000");
    }

    #[test]
    fn test_get_server_url_absent() {
        let config = default_config(Mode::Collector);
        assert_eq!(config.get_server_url(), "");
    }

    #[test]
    fn test_get_db_path() {
        let config = default_config(Mode::Server);
        assert_eq!(config.get_db_path(), "/data/trivy.db");
    }

    #[test]
    fn test_get_db_path_custom() {
        let mut config = default_config(Mode::Server);
        config.storage_path = "/tmp/custom".to_string();
        assert_eq!(config.get_db_path(), "/tmp/custom/trivy.db");
    }

    #[test]
    fn test_mode_display() {
        assert_eq!(Mode::Collector.to_string(), "collector");
        assert_eq!(Mode::Server.to_string(), "server");
    }

    #[test]
    fn test_get_cluster_name() {
        let config = default_config(Mode::Collector);
        assert_eq!(config.get_cluster_name(), "local");
    }

    #[test]
    fn test_validate_server_keycloak_missing_oidc() {
        let mut config = default_config(Mode::Server);
        config.auth_mode = "keycloak".to_string();
        let result = config.validate();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("OIDC_ISSUER_URL"));
    }

    #[test]
    fn test_validate_server_keycloak_all_present() {
        let mut config = default_config(Mode::Server);
        config.auth_mode = "keycloak".to_string();
        config.oidc_issuer_url = Some("https://keycloak.example.com/realms/test".to_string());
        config.oidc_client_id = Some("trivy-collector".to_string());
        config.oidc_client_secret = Some("secret".to_string());
        config.oidc_redirect_url = Some("http://localhost:3000/auth/callback".to_string());
        assert!(config.validate().is_ok());
    }

    #[test]
    fn test_validate_server_auth_none() {
        let config = default_config(Mode::Server);
        assert!(config.validate().is_ok());
    }
}
