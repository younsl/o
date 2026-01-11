//! Application state and watcher status management

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

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

/// Application state shared across handlers
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    pub watcher_status: Arc<WatcherStatus>,
}
