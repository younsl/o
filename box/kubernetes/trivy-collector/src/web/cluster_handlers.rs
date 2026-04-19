//! HTTP handlers for cluster registration (hub-pull mode).
//!
//! Operates on Secrets with the `trivy-collector.io/secret-type=cluster` label
//! in the hub's configured namespace.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use k8s_openapi::api::core::v1::Secret;
use kube::{
    Api, Client,
    api::{DeleteParams, ObjectMeta, PostParams},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tracing::{error, info, warn};
use utoipa::ToSchema;

use super::state::AppState;
use super::types::ErrorResponse;
use crate::hub::client_builder::{build_client, parse_cluster_secret};
use crate::hub::self_register::is_in_cluster;
use crate::hub::types::{
    ClusterCredentials, ClusterSecret, SECRET_TYPE_LABEL, SECRET_TYPE_VALUE, TlsClientConfig,
};

#[derive(Debug, Deserialize, ToSchema)]
pub struct RegisterClusterRequest {
    /// Display name (must be DNS-safe; used in cluster column on reports)
    pub name: String,
    /// Edge API server URL (https://...)
    pub server: String,
    /// Base64-encoded CA certificate (kubeconfig `certificate-authority-data`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_data: Option<String>,
    /// Bearer token (SA token extracted from Edge)
    pub bearer_token: String,
    /// Skip TLS verification (not recommended)
    #[serde(default)]
    pub insecure: bool,
    /// Optional namespace filter (empty = all namespaces)
    #[serde(default)]
    pub namespaces: Vec<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct RegisteredCluster {
    pub name: String,
    pub server: String,
    pub namespaces: Vec<String>,
    pub insecure: bool,
    /// True when this entry represents the Hub's own cluster (auto-registered,
    /// not user-created). UI uses this to show a "Local" badge and disable
    /// the Delete button.
    #[serde(default)]
    pub in_cluster: bool,
    /// Result of a live probe to the Edge API server performed at list time.
    /// `true` = `/version` returned OK within the timeout. `false` = network,
    /// TLS, or auth failure. `None` = probe was skipped (in-cluster entries
    /// always report `Some(true)` so consumers don't special-case them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachable: Option<bool>,
    /// One-line human-readable probe result (e.g. `"Kubernetes v1.31"` or
    /// `"connection timed out"`). Meant for tooltip display in the UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachability_message: Option<String>,
    /// Wall-clock duration of the probe in milliseconds. `None` when the
    /// probe was skipped (in-cluster entries).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reachability_latency_ms: Option<u64>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ValidationResponse {
    pub reachable: bool,
    pub message: String,
}

fn hub_namespace(state: &AppState) -> Option<String> {
    let ns = state.config.hub_secret_namespace.trim();
    if ns.is_empty() {
        None
    } else {
        Some(ns.to_string())
    }
}

async fn secret_api(state: &AppState) -> Result<Api<Secret>, (StatusCode, Json<ErrorResponse>)> {
    let Some(namespace) = hub_namespace(state) else {
        return Err((
            StatusCode::PRECONDITION_FAILED,
            Json(ErrorResponse {
                error: "HUB_SECRET_NAMESPACE is not set. \
                    In-cluster deployments receive it via the Downward API. \
                    For local dev, export HUB_SECRET_NAMESPACE before starting the server."
                    .to_string(),
            }),
        ));
    };
    let client = Client::try_default().await.map_err(|e| {
        error!(error = %e, "Failed to build in-cluster client for hub API");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "failed to create Kubernetes client".to_string(),
            }),
        )
    })?;
    Ok(Api::namespaced(client, &namespace))
}

fn sanitize_name(name: &str) -> Result<String, String> {
    if name.is_empty() || name.len() > 63 {
        return Err("name must be 1-63 characters".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("name may only contain lowercase letters, digits, and hyphens".to_string());
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err("name may not start or end with a hyphen".to_string());
    }
    Ok(name.to_string())
}

/// Extract the hostname (lowercased, no scheme/port/path) from a server URL.
fn server_host(server: &str) -> String {
    let after_scheme = server
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(server);
    let host_with_path = after_scheme
        .split_once('/')
        .map(|(h, _)| h)
        .unwrap_or(after_scheme);
    let host = host_with_path
        .split_once(':')
        .map(|(h, _)| h)
        .unwrap_or(host_with_path);
    host.to_lowercase()
}

/// Truncate to the DNS-1123 subdomain limit (253 chars) and trim any trailing
/// separators that become invalid.
fn truncate_dns_subdomain(name: &str, limit: usize) -> String {
    let mut s: String = name.chars().take(limit).collect();
    while matches!(s.chars().last(), Some('-' | '.')) {
        s.pop();
    }
    s
}

/// Secret name format: `cluster-<CLUSTER_NAME>-<API_SERVER_HOST>`.
/// Example: `cluster-dev-mpay-cluster-e7d03ab...yl4.ap-northeast-2.eks.amazonaws.com`.
fn secret_name(cluster: &str, server: &str) -> String {
    let host = server_host(server);
    let raw = if host.is_empty() {
        format!("cluster-{}", cluster)
    } else {
        format!("cluster-{}-{}", cluster, host)
    };
    truncate_dns_subdomain(&raw, 253)
}

fn build_secret(namespace: &str, req: &RegisterClusterRequest) -> Result<Secret, String> {
    let name = sanitize_name(&req.name)?;
    if req.server.trim().is_empty() {
        return Err("server URL is required".to_string());
    }
    if req.bearer_token.trim().is_empty() {
        return Err("bearer_token is required".to_string());
    }

    let credentials = ClusterCredentials {
        bearer_token: Some(req.bearer_token.clone()),
        tls_client_config: TlsClientConfig {
            insecure: req.insecure,
            ca_data: req.ca_data.clone(),
            ..Default::default()
        },
    };
    let config_json = serde_json::to_string(&credentials)
        .map_err(|e| format!("failed to serialize credentials: {}", e))?;
    let namespaces_json = serde_json::to_string(&req.namespaces)
        .map_err(|e| format!("failed to serialize namespaces: {}", e))?;

    let mut labels = BTreeMap::new();
    labels.insert(SECRET_TYPE_LABEL.to_string(), SECRET_TYPE_VALUE.to_string());
    labels.insert(
        "app.kubernetes.io/managed-by".to_string(),
        "trivy-collector".to_string(),
    );

    let mut string_data = BTreeMap::new();
    string_data.insert("name".to_string(), name.clone());
    string_data.insert("server".to_string(), req.server.clone());
    string_data.insert("config".to_string(), config_json);
    string_data.insert("namespaces".to_string(), namespaces_json);

    Ok(Secret {
        metadata: ObjectMeta {
            name: Some(secret_name(&name, &req.server)),
            namespace: Some(namespace.to_string()),
            labels: Some(labels),
            ..Default::default()
        },
        string_data: Some(string_data),
        type_: Some("Opaque".to_string()),
        ..Default::default()
    })
}

fn to_registered(
    parsed: &ClusterSecret,
    in_cluster: bool,
    reachable: Option<bool>,
    reachability_message: Option<String>,
    reachability_latency_ms: Option<u64>,
) -> RegisteredCluster {
    RegisteredCluster {
        name: parsed.name.clone(),
        server: parsed.server.clone(),
        namespaces: parsed.namespaces.clone(),
        insecure: parsed.credentials.tls_client_config.insecure,
        in_cluster,
        reachable,
        reachability_message,
        reachability_latency_ms,
    }
}

/// Probe an Edge cluster's /version endpoint with a short timeout.
/// Returns `(reachable, human-readable-message, latency_ms)`.
async fn probe_cluster(parsed: &ClusterSecret) -> (bool, String, u64) {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

    let started = std::time::Instant::now();
    let client = match build_client(parsed).await {
        Ok(c) => c,
        Err(e) => {
            let ms = started.elapsed().as_millis() as u64;
            return (false, format!("client build failed: {}", e), ms);
        }
    };

    let (reachable, msg) = match tokio::time::timeout(TIMEOUT, client.apiserver_version()).await
    {
        Ok(Ok(v)) => (true, format!("Kubernetes v{}.{}", v.major, v.minor)),
        Ok(Err(e)) => (false, format!("API error: {}", e)),
        Err(_) => (false, format!("timed out after {}s", TIMEOUT.as_secs())),
    };
    let ms = started.elapsed().as_millis() as u64;
    (reachable, msg, ms)
}

/// List registered clusters
#[utoipa::path(
    get,
    path = "/api/v1/hub/clusters",
    tag = "Hub",
    responses(
        (status = 200, description = "Registered clusters", body = Vec<RegisteredCluster>)
    )
)]
pub async fn list_registered_clusters(State(state): State<AppState>) -> impl IntoResponse {
    let api = match secret_api(&state).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };
    let lp = kube::api::ListParams::default()
        .labels(&format!("{}={}", SECRET_TYPE_LABEL, SECRET_TYPE_VALUE));

    match api.list(&lp).await {
        Ok(list) => {
            // Parse all Secrets first so we can decide which ones need a
            // probe, then fire the probes in parallel.
            let parsed_all: Vec<(bool, ClusterSecret)> = list
                .items
                .iter()
                .filter_map(|s| {
                    let in_cluster = is_in_cluster(s);
                    parse_cluster_secret(s).ok().map(|p| (in_cluster, p))
                })
                .collect();

            let items: Vec<RegisteredCluster> = futures::future::join_all(
                parsed_all.into_iter().map(|(in_cluster, p)| async move {
                    // In-cluster: we are currently running inside it, so the
                    // concept of "reachable" is trivially true; skip the probe
                    // to save latency.
                    if in_cluster {
                        return to_registered(
                            &p,
                            true,
                            Some(true),
                            Some("in-cluster (pod's own SA)".to_string()),
                            None,
                        );
                    }
                    let (reachable, msg, ms) = probe_cluster(&p).await;
                    to_registered(&p, false, Some(reachable), Some(msg), Some(ms))
                }),
            )
            .await;

            (StatusCode::OK, Json(items)).into_response()
        }
        Err(e) => {
            error!(error = %e, "Failed to list cluster Secrets");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "failed to list clusters".to_string(),
                }),
            )
                .into_response()
        }
    }
}

/// Register a new cluster (creates or updates the cluster Secret).
#[utoipa::path(
    post,
    path = "/api/v1/hub/clusters",
    tag = "Hub",
    request_body = RegisterClusterRequest,
    responses(
        (status = 201, description = "Cluster registered", body = RegisteredCluster),
        (status = 400, description = "Invalid request", body = ErrorResponse),
        (status = 412, description = "Hub mode not enabled", body = ErrorResponse)
    )
)]
pub async fn register_cluster(
    State(state): State<AppState>,
    Json(req): Json<RegisterClusterRequest>,
) -> impl IntoResponse {
    let Some(namespace) = hub_namespace(&state) else {
        return (
            StatusCode::PRECONDITION_FAILED,
            Json(ErrorResponse {
                error: "HUB_SECRET_NAMESPACE is not set. \
                    In-cluster deployments receive it via the Downward API. \
                    For local dev, export HUB_SECRET_NAMESPACE before starting the server."
                    .to_string(),
            }),
        )
            .into_response();
    };

    let secret = match build_secret(&namespace, &req) {
        Ok(s) => s,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: e })).into_response();
        }
    };

    let api = match secret_api(&state).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };

    let name = secret
        .metadata
        .name
        .clone()
        .unwrap_or_else(|| secret_name(&req.name, &req.server));

    // Try create; if already exists, replace to support "update" semantics.
    match api.create(&PostParams::default(), &secret).await {
        Ok(_) => {
            info!(cluster = %req.name, "Cluster registered");
        }
        Err(kube::Error::Api(e)) if e.code == 409 => {
            if let Err(e) = api.replace(&name, &PostParams::default(), &secret).await {
                error!(cluster = %req.name, error = %e, "Failed to update cluster Secret");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("failed to update cluster: {}", e),
                    }),
                )
                    .into_response();
            }
            info!(cluster = %req.name, "Cluster registration updated");
        }
        Err(e) => {
            error!(cluster = %req.name, error = %e, "Failed to create cluster Secret");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to register cluster: {}", e),
                }),
            )
                .into_response();
        }
    }

    // Echo back without the bearer token. Reachability fields are omitted
    // here — they're computed on list; the caller can re-list to see status.
    let response = RegisteredCluster {
        name: req.name,
        server: req.server,
        namespaces: req.namespaces,
        insecure: req.insecure,
        in_cluster: false,
        reachable: None,
        reachability_message: None,
        reachability_latency_ms: None,
    };
    (StatusCode::CREATED, Json(response)).into_response()
}

/// Delete a registered cluster
#[utoipa::path(
    delete,
    path = "/api/v1/hub/clusters/{name}",
    tag = "Hub",
    params(("name" = String, Path, description = "Cluster name")),
    responses(
        (status = 204, description = "Cluster removed"),
        (status = 404, description = "Cluster not found", body = ErrorResponse)
    )
)]
pub async fn delete_registered_cluster(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    if let Err(e) = sanitize_name(&name) {
        return (StatusCode::BAD_REQUEST, Json(ErrorResponse { error: e })).into_response();
    }

    let api = match secret_api(&state).await {
        Ok(a) => a,
        Err(e) => return e.into_response(),
    };

    // Secret name embeds the API server host, which the caller doesn't know.
    // Look up the matching Secret by label + `name` field, then delete by its
    // actual metadata.name.
    let lp = kube::api::ListParams::default()
        .labels(&format!("{}={}", SECRET_TYPE_LABEL, SECRET_TYPE_VALUE));
    let list = match api.list(&lp).await {
        Ok(list) => list,
        Err(e) => {
            error!(cluster = %name, error = %e, "Failed to list cluster Secrets for delete");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to look up cluster: {}", e),
                }),
            )
                .into_response();
        }
    };

    let matching = list.items.iter().find(|s| {
        parse_cluster_secret(s)
            .map(|p| p.name == name)
            .unwrap_or(false)
    });

    let Some(secret) = matching else {
        return (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("cluster '{}' not found", name),
            }),
        )
            .into_response();
    };
    if is_in_cluster(secret) {
        return (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error:
                    "cannot delete the Hub's own cluster — this is an auto-managed entry"
                        .to_string(),
            }),
        )
            .into_response();
    }
    let Some(obj_name) = secret.metadata.name.clone() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "matching secret has no metadata.name".to_string(),
            }),
        )
            .into_response();
    };

    match api.delete(&obj_name, &DeleteParams::default()).await {
        Ok(_) => {
            // Also wipe this cluster's reports from the DB so it disappears
            // from Dashboard / Vulnerabilities / SBOM views immediately.
            match state.db.delete_reports_for_cluster(&name).await {
                Ok(n) => {
                    info!(
                        cluster = %name,
                        secret = %obj_name,
                        reports_deleted = n,
                        "Cluster unregistered and reports purged"
                    );
                }
                Err(e) => {
                    warn!(
                        cluster = %name,
                        error = %e,
                        "Cluster Secret removed but failed to purge reports"
                    );
                }
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Err(kube::Error::Api(e)) if e.code == 404 => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("cluster '{}' not found", name),
            }),
        )
            .into_response(),
        Err(e) => {
            error!(cluster = %name, error = %e, "Failed to delete cluster Secret");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("failed to delete cluster: {}", e),
                }),
            )
                .into_response()
        }
    }
}

/// Test connection to an Edge cluster without persisting credentials.
#[utoipa::path(
    post,
    path = "/api/v1/hub/clusters/validate",
    tag = "Hub",
    request_body = RegisterClusterRequest,
    responses(
        (status = 200, description = "Validation result", body = ValidationResponse)
    )
)]
pub async fn validate_cluster(
    State(_state): State<AppState>,
    Json(req): Json<RegisterClusterRequest>,
) -> impl IntoResponse {
    let cluster_secret = ClusterSecret {
        name: req.name.clone(),
        server: req.server.clone(),
        credentials: ClusterCredentials {
            bearer_token: Some(req.bearer_token.clone()),
            tls_client_config: TlsClientConfig {
                insecure: req.insecure,
                ca_data: req.ca_data.clone(),
                ..Default::default()
            },
        },
        namespaces: req.namespaces.clone(),
    };

    let client = match build_client(&cluster_secret).await {
        Ok(c) => c,
        Err(e) => {
            warn!(cluster = %req.name, error = %e, "Validation: client build failed");
            return (
                StatusCode::OK,
                Json(ValidationResponse {
                    reachable: false,
                    message: format!("failed to build client: {}", e),
                }),
            )
                .into_response();
        }
    };

    // Probe with a lightweight apiserver version call.
    match client.apiserver_version().await {
        Ok(v) => (
            StatusCode::OK,
            Json(ValidationResponse {
                reachable: true,
                message: format!("connected to Kubernetes {}.{}", v.major, v.minor),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::OK,
            Json(ValidationResponse {
                reachable: false,
                message: format!("connection failed: {}", e),
            }),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_server_host_strips_scheme_and_port() {
        assert_eq!(
            server_host("https://bb72fe0d.gr7.ap-northeast-2.eks.amazonaws.com:443"),
            "bb72fe0d.gr7.ap-northeast-2.eks.amazonaws.com"
        );
        assert_eq!(
            server_host("https://BB72FE0D.GR7.EKS.AMAZONAWS.COM"),
            "bb72fe0d.gr7.eks.amazonaws.com"
        );
        assert_eq!(server_host("http://example:8080/path"), "example");
        assert_eq!(server_host("no-scheme-host"), "no-scheme-host");
    }

    #[test]
    fn test_secret_name_format() {
        let n = secret_name(
            "dev-mpay-cluster",
            "https://e7d03ab76076b016e287e8f66081e4e0.yl4.ap-northeast-2.eks.amazonaws.com",
        );
        assert_eq!(
            n,
            "cluster-dev-mpay-cluster-e7d03ab76076b016e287e8f66081e4e0.yl4.ap-northeast-2.eks.amazonaws.com"
        );
    }

    #[test]
    fn test_secret_name_without_host_falls_back() {
        assert_eq!(secret_name("edge-a", ""), "cluster-edge-a");
    }

    #[test]
    fn test_truncate_dns_subdomain_trims_trailing_sep() {
        // Exactly 253 chars is fine; anything longer gets cut and trailing
        // '-' or '.' must be stripped so the result stays a valid subdomain.
        let long = format!("cluster-a-{}", "x".repeat(300));
        let t = truncate_dns_subdomain(&long, 253);
        assert_eq!(t.len(), 253);
        assert!(!t.ends_with('-'));
        assert!(!t.ends_with('.'));
    }

    #[test]
    fn test_build_secret_has_discovery_label() {
        // Regression guard: every registration-created Secret MUST carry
        // `trivy-collector.io/secret-type=cluster` so the scraper's watcher
        // picks it up. Without this label the cluster never connects.
        let req = RegisterClusterRequest {
            name: "edge-a".to_string(),
            server: "https://edge:443".to_string(),
            bearer_token: "tok".to_string(),
            ca_data: None,
            insecure: false,
            namespaces: vec![],
        };
        let secret = build_secret("trivy-system", &req).unwrap();
        let labels = secret.metadata.labels.expect("labels must be set");
        assert_eq!(
            labels.get(SECRET_TYPE_LABEL),
            Some(&SECRET_TYPE_VALUE.to_string()),
            "registration Secret is missing the discovery label"
        );
        assert_eq!(
            labels.get("app.kubernetes.io/managed-by"),
            Some(&"trivy-collector".to_string()),
        );
    }
}
