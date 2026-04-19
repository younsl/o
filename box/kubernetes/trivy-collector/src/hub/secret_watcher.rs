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
use super::self_register::{ensure_local_cluster_secret, is_in_cluster};
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
                // Self-healing: if someone deletes the Hub-self Secret via
                // kubectl, immediately recreate it so the UI's Registered
                // Clusters table keeps showing the local entry without
                // waiting for a scraper restart. Metadata for the recreate
                // is derived from the deleted Secret itself.
                if is_in_cluster(&s) {
                    let hub_ns = s.metadata.namespace.clone();
                    let cluster_name = cluster_name_from_secret(&s);
                    let namespaces = namespaces_from_secret(&s);
                    match (hub_ns, cluster_name) {
                        (Some(ns), Some(name)) => {
                            warn!(
                                secret = ?s.metadata.name,
                                "In-cluster self-secret deleted — recreating"
                            );
                            let _ =
                                ensure_local_cluster_secret(&ns, &name, &namespaces).await;
                        }
                        _ => warn!(
                            secret = ?s.metadata.name,
                            "In-cluster self-secret deleted but metadata was incomplete \
                             — cannot auto-recreate"
                        ),
                    }
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

/// Best-effort read of the Secret's `namespaces` JSON array field. Used to
/// preserve the original namespace filter when auto-recreating the deleted
/// self-secret.
fn namespaces_from_secret(secret: &Secret) -> Vec<String> {
    let raw = secret
        .string_data
        .as_ref()
        .and_then(|m| m.get("namespaces"))
        .cloned()
        .or_else(|| {
            secret
                .data
                .as_ref()
                .and_then(|m| m.get("namespaces"))
                .and_then(|v| std::str::from_utf8(&v.0).ok().map(str::to_string))
        });
    match raw {
        Some(s) if !s.trim().is_empty() => {
            serde_json::from_str::<Vec<String>>(&s).unwrap_or_default()
        }
        _ => Vec::new(),
    }
}
