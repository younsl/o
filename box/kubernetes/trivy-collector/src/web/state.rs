//! Application state and watcher status management

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

use crate::config::Config;
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
}

impl From<&Config> for ConfigInfo {
    fn from(config: &Config) -> Self {
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
}
