//! Hub-pull mode: central cluster watches Edge clusters via registered Secrets
//!
//! # Module Structure
//! - `client_builder`: Builds `kube::Client` from registered cluster Secrets
//! - `cluster_manager`: Tracks per-cluster watcher tasks
//! - `secret_watcher`: Watches cluster-registration Secrets and drives the manager

pub mod client_builder;
pub mod cluster_manager;
pub mod secret_watcher;
pub mod self_register;
pub mod types;

use anyhow::{Context, Result};
use std::sync::Arc;
use tracing::info;

use crate::storage::Database;
use crate::web::state::WatcherStatus;

pub use cluster_manager::ClusterManager;
pub use secret_watcher::SecretWatcher;
pub use types::{HubConfig, SECRET_TYPE_LABEL, SECRET_TYPE_VALUE};

/// Start hub-pull mode: watches cluster Secrets and runs per-cluster watchers.
pub async fn run(
    hub_config: HubConfig,
    db: Arc<Database>,
    watcher_status: Arc<WatcherStatus>,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    info!(
        namespace = %hub_config.secret_namespace,
        label_selector = %hub_config.label_selector(),
        "Starting hub-pull mode"
    );

    let manager = Arc::new(ClusterManager::new(db, watcher_status));

    let secret_watcher = SecretWatcher::new(hub_config, manager.clone())
        .await
        .context("Failed to initialize hub Secret watcher")?;

    secret_watcher.run(shutdown).await?;
    manager.stop_all().await;

    Ok(())
}
