//! Application state and watcher status management

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use crate::auth::AuthState;
use crate::auth::rbac::RbacPolicy;
use crate::config::Config;
use crate::metrics::Metrics;
use crate::storage::Database;

/// Watcher status shared across the application
#[derive(Default)]
pub struct WatcherStatus {
    pub vuln_watcher_running: AtomicBool,
    pub sbom_watcher_running: AtomicBool,
    pub vuln_initial_sync_done: AtomicBool,
    pub sbom_initial_sync_done: AtomicBool,
}

impl WatcherStatus {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_vuln_running(&self, running: bool) {
        self.vuln_watcher_running.store(running, Ordering::SeqCst);
    }

    pub fn set_sbom_running(&self, running: bool) {
        self.sbom_watcher_running.store(running, Ordering::SeqCst);
    }

    pub fn set_vuln_sync_done(&self, done: bool) {
        self.vuln_initial_sync_done.store(done, Ordering::SeqCst);
    }

    pub fn set_sbom_sync_done(&self, done: bool) {
        self.sbom_initial_sync_done.store(done, Ordering::SeqCst);
    }
}

/// Runtime configuration info (subset of Config for API exposure)
#[derive(Clone)]
pub struct ConfigInfo {
    pub mode: String,
    pub log_format: String,
    pub log_level: String,
    pub health_port: u16,
    pub cluster_name: String,
    pub namespaces: Vec<String>,
    pub collect_vulnerability_reports: bool,
    pub collect_sbom_reports: bool,
    pub server_port: u16,
    pub storage_path: String,
    pub watch_local: bool,
    pub auth_mode: Option<String>,
}

impl From<&Config> for ConfigInfo {
    fn from(config: &Config) -> Self {
        let auth_mode = if config.auth_mode == "none" {
            None
        } else {
            Some(config.auth_mode.clone())
        };

        Self {
            mode: config.mode.to_string(),
            log_format: config.log_format.clone(),
            log_level: config.log_level.clone(),
            health_port: config.health_port,
            cluster_name: config.cluster_name.clone(),
            namespaces: config.namespaces.clone(),
            collect_vulnerability_reports: config.collect_vulnerability_reports,
            collect_sbom_reports: config.collect_sbom_reports,
            server_port: config.server_port,
            storage_path: config.storage_path.clone(),
            watch_local: config.watch_local,
            auth_mode,
        }
    }
}

/// Runtime information collected at server startup
#[derive(Clone)]
pub struct RuntimeInfo {
    pub start_time: Instant,
    pub hostname: String,
}

impl RuntimeInfo {
    pub fn new() -> Self {
        Self {
            start_time: Instant::now(),
            hostname: hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string()),
        }
    }

    /// Get uptime as human-readable string
    pub fn uptime_string(&self) -> String {
        let duration = self.start_time.elapsed();
        let total_secs = duration.as_secs();

        let days = total_secs / 86400;
        let hours = (total_secs % 86400) / 3600;
        let minutes = (total_secs % 3600) / 60;
        let seconds = total_secs % 60;

        if days > 0 {
            format!("{}d {}h {}m {}s", days, hours, minutes, seconds)
        } else if hours > 0 {
            format!("{}h {}m {}s", hours, minutes, seconds)
        } else if minutes > 0 {
            format!("{}m {}s", minutes, seconds)
        } else {
            format!("{}s", seconds)
        }
    }
}

impl Default for RuntimeInfo {
    fn default() -> Self {
        Self::new()
    }
}

/// Application state shared across handlers
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    pub watcher_status: Arc<WatcherStatus>,
    pub config: Arc<ConfigInfo>,
    pub runtime: Arc<RuntimeInfo>,
    /// Authentication state (None when auth_mode == "none")
    pub auth: Option<Arc<AuthState>>,
    /// RBAC policy engine
    pub rbac: Arc<RbacPolicy>,
    /// Prometheus metrics
    pub metrics: Arc<Metrics>,
}

/// Allow axum-extra PrivateCookieJar to extract the cookie Key from AppState
impl axum::extract::FromRef<AppState> for cookie::Key {
    fn from_ref(state: &AppState) -> Self {
        state
            .auth
            .as_ref()
            .map(|a| a.cookie_key.clone())
            .unwrap_or_else(cookie::Key::generate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_watcher_status_default() {
        let status = WatcherStatus::new();
        assert!(!status.vuln_watcher_running.load(Ordering::SeqCst));
        assert!(!status.sbom_watcher_running.load(Ordering::SeqCst));
        assert!(!status.vuln_initial_sync_done.load(Ordering::SeqCst));
        assert!(!status.sbom_initial_sync_done.load(Ordering::SeqCst));
    }

    #[test]
    fn test_watcher_status_set_vuln() {
        let status = WatcherStatus::new();
        status.set_vuln_running(true);
        status.set_vuln_sync_done(true);
        assert!(status.vuln_watcher_running.load(Ordering::SeqCst));
        assert!(status.vuln_initial_sync_done.load(Ordering::SeqCst));
        assert!(!status.sbom_watcher_running.load(Ordering::SeqCst));
    }

    #[test]
    fn test_watcher_status_set_sbom() {
        let status = WatcherStatus::new();
        status.set_sbom_running(true);
        status.set_sbom_sync_done(true);
        assert!(status.sbom_watcher_running.load(Ordering::SeqCst));
        assert!(status.sbom_initial_sync_done.load(Ordering::SeqCst));
        assert!(!status.vuln_watcher_running.load(Ordering::SeqCst));
    }

    #[test]
    fn test_runtime_info_uptime_string() {
        let runtime = RuntimeInfo::new();
        let uptime = runtime.uptime_string();
        // Just created, should be 0s
        assert_eq!(uptime, "0s");
    }

    #[test]
    fn test_runtime_info_hostname() {
        let runtime = RuntimeInfo::new();
        // hostname should be non-empty
        assert!(!runtime.hostname.is_empty());
    }

    #[test]
    fn test_runtime_info_default() {
        let runtime = RuntimeInfo::default();
        assert!(!runtime.hostname.is_empty());
        assert_eq!(runtime.uptime_string(), "0s");
    }

    #[test]
    fn test_config_info_from_server() {
        let config = crate::config::Config {
            command: None,
            mode: crate::config::Mode::Server,
            log_format: "json".to_string(),
            log_level: "debug".to_string(),
            health_port: 9090,
            server_url: None,
            cluster_name: "my-cluster".to_string(),
            namespaces: vec!["ns1".to_string()],
            collect_vulnerability_reports: true,
            collect_sbom_reports: false,
            retry_attempts: 3,
            retry_delay_secs: 5,
            health_check_interval_secs: 30,
            server_port: 8080,
            storage_path: "/tmp".to_string(),
            watch_local: true,
            auth_mode: "keycloak".to_string(),
            oidc_issuer_url: None,
            oidc_client_id: None,
            oidc_client_secret: None,
            oidc_redirect_url: None,
            oidc_scopes: "openid".to_string(),
            rbac_policy_csv: String::new(),
            rbac_default_policy: "role:readonly".to_string(),
        };
        let info = ConfigInfo::from(&config);
        assert_eq!(info.mode, "server");
        assert_eq!(info.log_level, "debug");
        assert_eq!(info.health_port, 9090);
        assert_eq!(info.cluster_name, "my-cluster");
        assert_eq!(info.namespaces, vec!["ns1"]);
        assert!(info.collect_vulnerability_reports);
        assert!(!info.collect_sbom_reports);
        assert_eq!(info.server_port, 8080);
        assert!(info.watch_local);
        assert_eq!(info.auth_mode, Some("keycloak".to_string()));
    }

    #[test]
    fn test_config_info_auth_mode_none() {
        let config = crate::config::Config {
            command: None,
            mode: crate::config::Mode::Collector,
            log_format: "pretty".to_string(),
            log_level: "info".to_string(),
            health_port: 8080,
            server_url: Some("http://server:3000".to_string()),
            cluster_name: "edge".to_string(),
            namespaces: vec![],
            collect_vulnerability_reports: true,
            collect_sbom_reports: true,
            retry_attempts: 3,
            retry_delay_secs: 5,
            health_check_interval_secs: 30,
            server_port: 3000,
            storage_path: "/data".to_string(),
            watch_local: false,
            auth_mode: "none".to_string(),
            oidc_issuer_url: None,
            oidc_client_id: None,
            oidc_client_secret: None,
            oidc_redirect_url: None,
            oidc_scopes: "openid".to_string(),
            rbac_policy_csv: String::new(),
            rbac_default_policy: "role:readonly".to_string(),
        };
        let info = ConfigInfo::from(&config);
        assert_eq!(info.mode, "collector");
        assert!(info.auth_mode.is_none());
    }
}
