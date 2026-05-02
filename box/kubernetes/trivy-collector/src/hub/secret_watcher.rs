//! Watches cluster-registration Secrets in the hub's own namespace and drives
//! the `ClusterManager` (upsert on Apply, remove on Delete).

use anyhow::{Context, Result};
use futures::StreamExt;
use k8s_openapi::api::core::v1::Secret;
use kube::{
    Client,
    api::Api,
    runtime::watcher::{Config as WatcherConfig, Event, watcher},
};
use std::sync::Arc;
use tracing::{debug, error, info, warn};

use super::client_builder::parse_cluster_secret;
use super::cluster_manager::ClusterManager;
use super::self_register::{
    ensure_local_cluster_secret, is_in_cluster, is_managed_self_secret_name,
};
use super::types::HubConfig;

pub struct SecretWatcher {
    client: Client,
    hub_config: HubConfig,
    manager: Arc<ClusterManager>,
}

impl SecretWatcher {
    pub async fn new(hub_config: HubConfig, manager: Arc<ClusterManager>) -> Result<Self> {
        let client = Client::try_default()
            .await
            .context("Failed to create in-cluster client for hub Secret watcher")?;
        Ok(Self {
            client,
            hub_config,
            manager,
        })
    }

    pub async fn run(&self, mut shutdown: tokio::sync::watch::Receiver<bool>) -> Result<()> {
        let api: Api<Secret> =
            Api::namespaced(self.client.clone(), &self.hub_config.secret_namespace);

        let cfg = WatcherConfig::default()
            .labels(&self.hub_config.label_selector())
            .page_size(50);

        let mut stream = watcher(api, cfg).boxed();

        info!(
            namespace = %self.hub_config.secret_namespace,
            label_selector = %self.hub_config.label_selector(),
            "Hub Secret watcher started"
        );

        loop {
            tokio::select! {
                _ = shutdown.changed() => {
                    info!("Hub Secret watcher shutting down");
                    break;
                }
                ev = stream.next() => {
                    match ev {
                        Some(Ok(event)) => self.handle_event(event).await,
                        Some(Err(e)) => error!(error = %e, "Hub Secret watcher error"),
                        None => {
                            warn!("Hub Secret watcher stream ended");
                            break;
                        }
                    }
                }
            }
        }

        Ok(())
    }

    async fn handle_event(&self, event: Event<Secret>) {
        match event {
            Event::Apply(s) | Event::InitApply(s) => self.handle_upsert(s).await,
            Event::Delete(s) => {
                // Self-healing for the Hub's own cluster entry: if someone
                // deletes the canonical or legacy self-secret (via kubectl,
                // ArgoCD prune, etc.), re-apply it so the Registered Clusters
                // table keeps showing the local entry.
                //
                // Recreation uses `cluster_name` / `namespaces` from HubConfig
                // — not the deleted Secret's stringData — so the canonical
                // name is always produced regardless of which form was deleted.
                // Calling `ensure_local_cluster_secret` is idempotent; the
                // legacy-eviction it performs internally is a no-op once legacy
                // is gone, so there's no recreate loop.
                let deleted_name = s.metadata.name.as_deref().unwrap_or_default();
                let is_self_secret = is_in_cluster(&s)
                    || is_managed_self_secret_name(deleted_name, &self.hub_config.cluster_name);
                if is_self_secret {
                    warn!(
                        secret = %deleted_name,
                        cluster_name = %self.hub_config.cluster_name,
                        "Self-secret deleted — recreating"
                    );
                    let _ = ensure_local_cluster_secret(
                        &self.hub_config.secret_namespace,
                        &self.hub_config.cluster_name,
                        &self.hub_config.namespaces,
                    )
                    .await;
                    return;
                }

                let name = cluster_name_from_secret(&s);
                if let Some(name) = name {
                    self.manager.remove(&name).await;
                } else {
                    warn!(secret = ?s.metadata.name, "Delete event for Secret without parseable name");
                }
            }
            Event::Init => debug!("Hub Secret watcher initial list starting"),
            Event::InitDone => {
                let count = self.manager.active_clusters().await;
                info!(
                    active_clusters = count,
                    "Hub Secret watcher initial sync completed"
                );
            }
        }
    }

    async fn handle_upsert(&self, secret: Secret) {
        // In-cluster (self) Secret is display-only; the LocalWatcher on this
        // pod already watches the Hub's own Trivy CRDs, so spawning another
        // per-cluster watcher against https://kubernetes.default.svc would
        // duplicate every report.
        if is_in_cluster(&secret) {
            debug!(
                secret = ?secret.metadata.name,
                "Skipping per-cluster watcher for in-cluster self-secret"
            );
            return;
        }
        let resource_version = secret.metadata.resource_version.clone();
        match parse_cluster_secret(&secret) {
            Ok(parsed) => {
                self.manager.upsert(parsed, resource_version).await;
            }
            Err(e) => {
                error!(
                    secret = ?secret.metadata.name,
                    namespace = ?secret.metadata.namespace,
                    error = %e,
                    "Failed to parse cluster Secret — skipping"
                );
            }
        }
    }
}

fn cluster_name_from_secret(secret: &Secret) -> Option<String> {
    if let Some(sd) = &secret.string_data
        && let Some(n) = sd.get("name")
    {
        return Some(n.clone());
    }
    if let Some(d) = &secret.data
        && let Some(v) = d.get("name")
        && let Ok(s) = std::str::from_utf8(&v.0)
    {
        return Some(s.to_string());
    }
    secret.metadata.name.clone()
}
