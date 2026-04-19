//! Central-cluster collector: pulls Trivy reports from the Hub's own cluster
//! and all registered Edge clusters, writing directly to the shared SQLite DB.
//!
//! This replaces the legacy Edge-side push collector. In the current
//! architecture the collector runs **only on the central cluster** alongside
//! (but separate from) the `server` pod, following single-responsibility:
//!
//! - `server` pod → HTTP UI/API, read-only access to the DB
//! - `collector` pod → all watchers, writes to the DB

pub mod types; // retained for ReportPayload / ReportEvent consumed by storage + hub

use anyhow::Result;
use std::sync::Arc;
use tracing::{error, info, warn};

use crate::config::Config;
use crate::health::HealthServer;
use crate::hub::{self, HubConfig};
use crate::metrics::Metrics;
use crate::storage::Database;
use crate::web::LocalWatcher;
use crate::web::state::WatcherStatus;

pub async fn run(
    config: Config,
    health_server: HealthServer,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    _metrics: Arc<Metrics>,
) -> Result<()> {
    info!(
        cluster = %config.cluster_name,
        namespaces = ?config.namespaces,
        storage_path = %config.storage_path,
        hub_secret_namespace = %config.hub_secret_namespace,
        "Starting collector (central cluster, hub-pull)"
    );

    let db = Arc::new(Database::new(&config.get_db_path()).await?);
    let watcher_status = Arc::new(WatcherStatus::new());

    // 1. Local watcher (Hub's own cluster, if trivy-operator is deployed there)
    let local_handle = if config.watch_local {
        let db = db.clone();
        let ws = watcher_status.clone();
        let cluster_name = config.cluster_name.clone();
        let namespaces = config.namespaces.clone();
        let shutdown_rx = shutdown.clone();

        info!(cluster = %cluster_name, namespaces = ?namespaces, "Local watcher enabled");

        Some(tokio::spawn(async move {
            match LocalWatcher::new(db, cluster_name, namespaces, ws).await {
                Ok(w) => {
                    if let Err(e) = w.run(shutdown_rx).await {
                        error!(error = %e, "Local watcher exited with error");
                    }
                }
                Err(e) => warn!(error = %e, "Failed to create local watcher — skipping"),
            }
        }))
    } else {
        None
    };

    // 2. Hub Secret watcher — spawns per-cluster watchers for every registered Edge
    let hub_handle = if config.hub_secret_namespace.trim().is_empty() {
        warn!(
            "HUB_SECRET_NAMESPACE is empty \
             (Downward API not wired or running outside a pod) \
             — skipping Edge cluster watcher"
        );
        None
    } else {
        // Self-register the Hub's own cluster as a display-only Secret so it
        // shows up alongside registered Edge clusters in the UI. Only when
        // the local watcher is active — otherwise we'd list a cluster that
        // isn't actually being watched.
        if config.watch_local
            && let Err(e) = hub::self_register::ensure_local_cluster_secret(
                &config.hub_secret_namespace,
                &config.cluster_name,
                &config.namespaces,
            )
            .await
        {
            warn!(error = %e, "self-register: non-fatal failure");
        }

        let hub_cfg = HubConfig {
            secret_namespace: config.hub_secret_namespace.clone(),
            extra_label_selector: config.hub_label_selector.clone(),
            cluster_name: config.cluster_name.clone(),
            namespaces: config.namespaces.clone(),
        };
        let db = db.clone();
        let ws = watcher_status.clone();
        let shutdown_rx = shutdown.clone();

        info!(
            secret_namespace = %hub_cfg.secret_namespace,
            label_selector = %hub_cfg.label_selector(),
            "Hub Secret watcher enabled"
        );

        Some(tokio::spawn(async move {
            if let Err(e) = hub::run(hub_cfg, db, ws, shutdown_rx).await {
                error!(error = %e, "Hub Secret watcher exited with error");
            }
        }))
    };

    health_server.set_ready(true);
    info!("Collector is ready");

    // Block until shutdown signal
    let _ = shutdown.changed().await;
    info!("Collector shutdown signal received");

    if let Some(h) = local_handle {
        let _ = h.await;
    }
    if let Some(h) = hub_handle {
        let _ = h.await;
    }

    Ok(())
}
