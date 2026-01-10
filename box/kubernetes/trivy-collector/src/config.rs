use clap::{Parser, ValueEnum};
use serde::{Deserialize, Serialize};

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

#[derive(Parser, Debug, Clone)]
#[command(
    name = "trivy-collector",
    version,
    about = "Multi-cluster Trivy report collector and viewer",
    long_about = "A Kubernetes application that collects Trivy Operator reports from multiple clusters and provides a centralized UI for viewing and filtering security reports."
)]
pub struct Config {
    /// Deployment mode
    #[arg(long, env = "MODE", value_enum, default_value = "collector")]
    pub mode: Mode,

    /// Log format: json or pretty
    #[arg(long, env = "LOG_FORMAT", default_value = "json")]
    pub log_format: String,

    /// Log level: trace, debug, info, warn, error
    #[arg(long, env = "LOG_LEVEL", default_value = "info")]
    pub log_level: String,

    /// Health check server port
    #[arg(long, env = "HEALTH_PORT", default_value = "8080")]
    pub health_port: u16,

    // ============================================
    // Collector mode settings
    // ============================================
    /// Central server URL (collector mode only)
    #[arg(long, env = "SERVER_URL")]
    pub server_url: Option<String>,

    /// Cluster identifier (collector mode only)
    #[arg(long, env = "CLUSTER_NAME")]
    pub cluster_name: Option<String>,

    /// Namespaces to watch, comma-separated (empty = all namespaces)
    #[arg(long, env = "NAMESPACES", value_delimiter = ',')]
    pub namespaces: Vec<String>,

    /// Collect VulnerabilityReports
    #[arg(long, env = "COLLECT_VULN", default_value = "true")]
    pub collect_vulnerability_reports: bool,

    /// Collect SbomReports
    #[arg(long, env = "COLLECT_SBOM", default_value = "true")]
    pub collect_sbom_reports: bool,

    /// Retry attempts on failure
    #[arg(long, env = "RETRY_ATTEMPTS", default_value = "3")]
    pub retry_attempts: u32,

    /// Retry delay in seconds
    #[arg(long, env = "RETRY_DELAY_SECS", default_value = "5")]
    pub retry_delay_secs: u64,

    /// Health check interval in seconds (0 to disable)
    #[arg(long, env = "HEALTH_CHECK_INTERVAL_SECS", default_value = "30")]
    pub health_check_interval_secs: u64,

    // ============================================
    // Server mode settings
    // ============================================
    /// API/UI server port (server mode only)
    #[arg(long, env = "SERVER_PORT", default_value = "3000")]
    pub server_port: u16,

    /// Storage path for SQLite database (server mode only)
    #[arg(long, env = "STORAGE_PATH", default_value = "/data")]
    pub storage_path: String,

    /// Enable local Kubernetes API watching in server mode
    #[arg(long, env = "WATCH_LOCAL", default_value = "true")]
    pub watch_local: bool,

    /// Local cluster name for server mode K8s watching
    #[arg(long, env = "LOCAL_CLUSTER_NAME", default_value = "local")]
    pub local_cluster_name: String,
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
                if self.cluster_name.is_none() {
                    return Err("CLUSTER_NAME is required in collector mode".to_string());
                }
            }
            Mode::Server => {
                // Server mode has sensible defaults, no required fields
            }
        }
        Ok(())
    }

    /// Get server URL (collector mode)
    pub fn get_server_url(&self) -> &str {
        self.server_url.as_deref().unwrap_or("")
    }

    /// Get cluster name (collector mode)
    pub fn get_cluster_name(&self) -> &str {
        self.cluster_name.as_deref().unwrap_or("unknown")
    }

    /// Get SQLite database path
    pub fn get_db_path(&self) -> String {
        format!("{}/trivy.db", self.storage_path)
    }
}
