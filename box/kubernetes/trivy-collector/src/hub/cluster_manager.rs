//! Per-cluster watcher lifecycle manager.
//!
//! Holds a `HashMap<cluster_name, ClusterHandle>` where each entry owns a
//! spawned watcher task and its shutdown sender. The secret_watcher drives
//! upsert/remove calls as cluster-registration Secrets come and go.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::storage::Database;
use crate::web::LocalWatcher;
use crate::web::state::WatcherStatus;

use super::client_builder;
use super::types::ClusterSecret;

struct ClusterHandle {
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    task: JoinHandle<()>,
    resource_version: Option<String>,
}

pub struct ClusterManager {
    db: Arc<Database>,
    watcher_status: Arc<WatcherStatus>,
    clusters: Mutex<HashMap<String, ClusterHandle>>,
}

impl ClusterManager {
    pub fn new(db: Arc<Database>, watcher_status: Arc<WatcherStatus>) -> Self {
        Self {
            db,
            watcher_status,
            clusters: Mutex::new(HashMap::new()),
        }
    }

    /// Start (or restart) a watcher for the given cluster. If a watcher already
    /// exists for the same cluster name and the Secret's resourceVersion has
    /// not changed, this is a no-op.
    pub async fn upsert(&self, secret: ClusterSecret, resource_version: Option<String>) {
        let name = secret.name.clone();

        {
            let mut guard = self.clusters.lock().await;
            if let Some(existing) = guard.get(&name)
                && existing.resource_version == resource_version
            {
                return;
            }
            if let Some(old) = guard.remove(&name) {
                info!(cluster = %name, "Restarting watcher for updated cluster Secret");
                let _ = old.shutdown_tx.send(true);
                // task will drain on its own; we don't await to keep upsert non-blocking
                old.task.abort();
            }
        }

        let client = match client_builder::build_client(&secret).await {
            Ok(c) => c,
            Err(e) => {
                error!(cluster = %name, error = %e, "Failed to build client for cluster");
                return;
            }
        };

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let watcher = LocalWatcher::new_with_client(
            client,
            self.db.clone(),
            secret.name.clone(),
            secret.namespaces.clone(),
            self.watcher_status.clone(),
        );

        let cluster_label = name.clone();
        let task = tokio::spawn(async move {
            if let Err(e) = watcher.run(shutdown_rx).await {
                error!(cluster = %cluster_label, error = %e, "Remote watcher exited with error");
            }
        });

        let mut guard = self.clusters.lock().await;
        guard.insert(
            name.clone(),
            ClusterHandle {
                shutdown_tx,
                task,
                resource_version,
            },
        );
        info!(cluster = %name, total_clusters = guard.len(), "Hub watcher started for cluster");
    }

    /// Stop and remove a cluster's watcher.
    pub async fn remove(&self, cluster_name: &str) {
        let handle = {
            let mut guard = self.clusters.lock().await;
            guard.remove(cluster_name)
        };
        if let Some(h) = handle {
            info!(cluster = %cluster_name, "Stopping watcher for removed cluster");
            let _ = h.shutdown_tx.send(true);
            h.task.abort();
        } else {
            warn!(cluster = %cluster_name, "remove called for unknown cluster");
        }
    }

    /// Stop all cluster watchers (used on hub shutdown).
    pub async fn stop_all(&self) {
        let mut guard = self.clusters.lock().await;
        info!(count = guard.len(), "Stopping all cluster watchers");
        for (name, handle) in guard.drain() {
            let _ = handle.shutdown_tx.send(true);
            handle.task.abort();
            info!(cluster = %name, "Stopped watcher");
        }
    }

    /// Number of active cluster watchers.
    pub async fn active_clusters(&self) -> usize {
        self.clusters.lock().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_new_manager_empty() {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let mgr = ClusterManager::new(db, Arc::new(WatcherStatus::new()));
        assert_eq!(mgr.active_clusters().await, 0);
    }

    #[tokio::test]
    async fn test_remove_unknown_is_noop() {
        let db = Arc::new(Database::new(":memory:").await.unwrap());
        let mgr = ClusterManager::new(db, Arc::new(WatcherStatus::new()));
        mgr.remove("does-not-exist").await;
        assert_eq!(mgr.active_clusters().await, 0);
    }
}
