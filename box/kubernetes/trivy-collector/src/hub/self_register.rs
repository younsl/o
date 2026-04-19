//! Auto-register the Hub's own cluster as a cluster-registration Secret.
//!
//! ArgoCD creates a `cluster-kubernetes.default.svc-<hash>` Secret on install
//! so that the in-cluster target appears alongside registered remotes. This
//! module does the equivalent for trivy-collector.
//!
//! The self-secret is **display-only**:
//!   - The per-cluster watcher is skipped (see `ClusterManager::upsert`);
//!     in-cluster Trivy CRDs are watched by `LocalWatcher` on the scraper
//!     pod directly.
//!   - The UI flags rows carrying `trivy-collector.io/in-cluster=true` and
//!     disables the Delete button to prevent wiping the Hub's own reports.
//!
//! The Secret stores no credentials. `server` is set to
//! `https://kubernetes.default.svc`; auth is handled by `Client::try_default()`
//! when a watcher (hypothetically) is ever built from it.

use anyhow::{Context, Result};
use k8s_openapi::api::core::v1::Secret;
use kube::{
    Api, Client,
    api::{ObjectMeta, Patch, PatchParams},
};
use std::collections::BTreeMap;
use tracing::{info, warn};

use super::types::{IN_CLUSTER_LABEL, IN_CLUSTER_SERVER, SECRET_TYPE_LABEL, SECRET_TYPE_VALUE};

const SELF_FIELD_MANAGER: &str = "trivy-collector-self-register";

/// Ensure a Secret representing the Hub's own cluster exists in `hub_ns`.
///
/// Safe to call on every scraper startup: uses server-side apply so a
/// pre-existing self-secret is upserted in place without generating spurious
/// resource version churn.
pub async fn ensure_local_cluster_secret(
    hub_ns: &str,
    cluster_name: &str,
    namespaces: &[String],
) -> Result<()> {
    let client = Client::try_default()
        .await
        .context("self-register: failed to build in-cluster client")?;
    let api: Api<Secret> = Api::namespaced(client, hub_ns);

    let secret_name = format!("cluster-{}-kubernetes.default.svc", cluster_name);

    let mut labels = BTreeMap::new();
    labels.insert(SECRET_TYPE_LABEL.to_string(), SECRET_TYPE_VALUE.to_string());
    labels.insert(IN_CLUSTER_LABEL.to_string(), "true".to_string());
    labels.insert(
        "app.kubernetes.io/managed-by".to_string(),
        "trivy-collector".to_string(),
    );

    // No bearerToken / caData — local access goes through the pod's own SA
    // via LocalWatcher. The Secret exists purely for discovery/display.
    let config_json = r#"{"bearerToken":null,"tlsClientConfig":{}}"#.to_string();
    let namespaces_json = serde_json::to_string(namespaces)
        .context("self-register: failed to serialise namespaces")?;

    let mut string_data = BTreeMap::new();
    string_data.insert("name".to_string(), cluster_name.to_string());
    string_data.insert("server".to_string(), IN_CLUSTER_SERVER.to_string());
    string_data.insert("config".to_string(), config_json);
    string_data.insert("namespaces".to_string(), namespaces_json);

    let secret = Secret {
        metadata: ObjectMeta {
            name: Some(secret_name.clone()),
            namespace: Some(hub_ns.to_string()),
            labels: Some(labels),
            ..Default::default()
        },
        string_data: Some(string_data),
        type_: Some("Opaque".to_string()),
        ..Default::default()
    };

    let pp = PatchParams::apply(SELF_FIELD_MANAGER).force();
    match api.patch(&secret_name, &pp, &Patch::Apply(&secret)).await {
        Ok(_) => {
            info!(
                secret = %secret_name,
                namespace = %hub_ns,
                cluster_name = %cluster_name,
                "Self-registered local cluster"
            );
            Ok(())
        }
        Err(e) => {
            warn!(
                secret = %secret_name,
                error = %e,
                "self-register: failed to apply self-secret — local cluster \
                 will not appear in Registered Clusters table"
            );
            // Non-fatal: LocalWatcher still works, the UI just won't list it.
            Ok(())
        }
    }
}

/// Does this Secret carry the `in-cluster=true` marker?
pub fn is_in_cluster(secret: &Secret) -> bool {
    secret
        .metadata
        .labels
        .as_ref()
        .and_then(|m| m.get(IN_CLUSTER_LABEL))
        .map(|v| v == "true")
        .unwrap_or(false)
}
