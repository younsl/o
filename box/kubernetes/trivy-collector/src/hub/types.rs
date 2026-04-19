//! Shared types and constants for hub-pull mode

use serde::{Deserialize, Serialize};

/// Label key used to mark cluster-registration Secrets
pub const SECRET_TYPE_LABEL: &str = "trivy-collector.io/secret-type";
/// Expected label value for cluster Secrets
pub const SECRET_TYPE_VALUE: &str = "cluster";

/// Label marking a cluster Secret that represents the Hub's own cluster.
/// When `true`, the Secret is display-only — the per-cluster watcher is
/// skipped (the LocalWatcher already covers in-cluster Trivy CRDs) and the
/// Delete action is guarded so the Hub's own reports cannot be wiped.
pub const IN_CLUSTER_LABEL: &str = "trivy-collector.io/in-cluster";
/// Sentinel API server URL for the Hub's own cluster.
pub const IN_CLUSTER_SERVER: &str = "https://kubernetes.default.svc";

/// Hub-pull runtime configuration (derived from main `Config`).
#[derive(Debug, Clone)]
pub struct HubConfig {
    /// Namespace where cluster Secrets live (typically the Hub's own namespace)
    pub secret_namespace: String,
    /// Additional label selector filter (optional, empty string = no extra filter)
    pub extra_label_selector: String,
}

impl HubConfig {
    pub fn label_selector(&self) -> String {
        let base = format!("{}={}", SECRET_TYPE_LABEL, SECRET_TYPE_VALUE);
        if self.extra_label_selector.is_empty() {
            base
        } else {
            format!("{},{}", base, self.extra_label_selector)
        }
    }
}

/// ArgoCD-style TLS client configuration stored in Secret `config` field.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TlsClientConfig {
    #[serde(default)]
    pub insecure: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_data: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
}

/// Credential payload stored inside the Secret `config` field (ArgoCD layout).
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClusterCredentials {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer_token: Option<String>,
    #[serde(default)]
    pub tls_client_config: TlsClientConfig,
}

/// Parsed view of a cluster-registration Secret.
#[derive(Debug, Clone)]
pub struct ClusterSecret {
    pub name: String,
    pub server: String,
    pub credentials: ClusterCredentials,
    pub namespaces: Vec<String>,
}
