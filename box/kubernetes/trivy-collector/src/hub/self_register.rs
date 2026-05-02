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
//! Naming — two names are recognised:
//!   - **canonical**: `cluster-<clusterName>-kubernetes.default.svc`. The
//!     authoritative name, 1:1 with the current `clusterName` value.
//!   - **legacy**: `cluster-in-cluster-kubernetes.default.svc`. The fixed
//!     name produced by earlier versions. Still accepted as a self-secret
//!     identity so manual deletions trigger recreation, but never created
//!     anew — `ensure_local_cluster_secret` best-effort deletes it so the
//!     canonical and legacy forms don't coexist.
//!
//! The Secret stores no credentials. `server` is set to
//! `https://kubernetes.default.svc`; auth is handled by `Client::try_default()`
//! when a watcher (hypothetically) is ever built from it.

use anyhow::{Context, Result};
use k8s_openapi::api::core::v1::Secret;
use kube::{
    Api, Client,
    api::{DeleteParams, ObjectMeta, Patch, PatchParams},
};
use std::collections::BTreeMap;
use tracing::{info, warn};

use super::types::{IN_CLUSTER_LABEL, IN_CLUSTER_SERVER, SECRET_TYPE_LABEL, SECRET_TYPE_VALUE};

const SELF_FIELD_MANAGER: &str = "trivy-collector-self-register";

/// Legacy fixed self-secret name produced by pre-858d67b builds. Still treated
/// as a self-secret identity so manual deletions trigger recreation of the
/// canonical form, but never applied directly — see `ensure_local_cluster_secret`.
pub const LEGACY_SELF_SECRET_NAME: &str = "cluster-in-cluster-kubernetes.default.svc";

/// Build the canonical self-secret name for a given `clusterName`. Returns
/// `None` when `cluster_name` is empty so callers can skip the apply instead
/// of producing a DNS-1123-invalid name like `cluster--kubernetes.default.svc`.
pub fn self_secret_name(cluster_name: &str) -> Option<String> {
    let trimmed = cluster_name.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(format!("cluster-{}-kubernetes.default.svc", trimmed))
}

/// Does this Secret name identify a self-secret for `cluster_name`?
///
/// Matches either the canonical form or the legacy fixed name. The watcher
/// uses this to decide whether a Delete event should trigger a recreate.
pub fn is_managed_self_secret_name(name: &str, cluster_name: &str) -> bool {
    if name == LEGACY_SELF_SECRET_NAME {
        return true;
    }
    self_secret_name(cluster_name)
        .map(|canonical| canonical == name)
        .unwrap_or(false)
}

/// Ensure a Secret representing the Hub's own cluster exists in `hub_ns`.
///
/// Applies the canonical `cluster-<clusterName>-kubernetes.default.svc` via
/// server-side apply (idempotent) and best-effort deletes any legacy
/// `cluster-in-cluster-kubernetes.default.svc` so the two forms never coexist.
pub async fn ensure_local_cluster_secret(
    hub_ns: &str,
    cluster_name: &str,
    namespaces: &[String],
) -> Result<()> {
    let Some(secret_name) = self_secret_name(cluster_name) else {
        warn!(
            "self-register: cluster_name is empty — skipping. \
             LocalWatcher still runs; the Hub just won't appear in the \
             Registered Clusters table."
        );
        return Ok(());
    };

    let client = Client::try_default()
        .await
        .context("self-register: failed to build in-cluster client")?;
    let api: Api<Secret> = Api::namespaced(client, hub_ns);

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
        }
        Err(e) => {
            warn!(
                secret = %secret_name,
                error = %e,
                "self-register: failed to apply self-secret — local cluster \
                 will not appear in Registered Clusters table"
            );
            // Non-fatal: LocalWatcher still works, the UI just won't list it.
        }
    }

    // Mutual exclusion: evict the legacy fixed-name Secret if it still exists
    // and differs from the canonical name. 404 is the expected steady state.
    if secret_name != LEGACY_SELF_SECRET_NAME {
        match api
            .delete(LEGACY_SELF_SECRET_NAME, &DeleteParams::default())
            .await
        {
            Ok(_) => info!(
                legacy_secret = %LEGACY_SELF_SECRET_NAME,
                canonical = %secret_name,
                "self-register: evicted legacy self-secret"
            ),
            Err(kube::Error::Api(e)) if e.code == 404 => {}
            Err(e) => warn!(
                legacy_secret = %LEGACY_SELF_SECRET_NAME,
                error = %e,
                "self-register: failed to evict legacy self-secret"
            ),
        }
    }

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_self_secret_name_default() {
        assert_eq!(
            self_secret_name("local").as_deref(),
            Some("cluster-local-kubernetes.default.svc")
        );
    }

    #[test]
    fn test_self_secret_name_custom() {
        assert_eq!(
            self_secret_name("shared-mpay-cluster").as_deref(),
            Some("cluster-shared-mpay-cluster-kubernetes.default.svc")
        );
    }

    #[test]
    fn test_self_secret_name_empty_or_whitespace() {
        assert_eq!(self_secret_name(""), None);
        assert_eq!(self_secret_name("   "), None);
    }

    #[test]
    fn test_is_managed_self_secret_name_canonical() {
        assert!(is_managed_self_secret_name(
            "cluster-shared-mpay-cluster-kubernetes.default.svc",
            "shared-mpay-cluster"
        ));
    }

    #[test]
    fn test_is_managed_self_secret_name_legacy() {
        assert!(is_managed_self_secret_name(
            LEGACY_SELF_SECRET_NAME,
            "shared-mpay-cluster"
        ));
        // Legacy name is recognised even when clusterName is empty.
        assert!(is_managed_self_secret_name(LEGACY_SELF_SECRET_NAME, ""));
    }

    #[test]
    fn test_is_managed_self_secret_name_unrelated() {
        assert!(!is_managed_self_secret_name(
            "cluster-edge-a-somewhere.eks.amazonaws.com",
            "shared-mpay-cluster"
        ));
    }
}
