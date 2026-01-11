//! HTTP request handlers for API endpoints

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use std::sync::atomic::Ordering;
use tracing::{debug, error, info};

use crate::collector::types::{ReportEvent, ReportEventType};
use crate::config::env;
use crate::storage::{ClusterInfo, FullReport, ReportMeta, Stats};

use super::state::AppState;
use super::types::{
    ConfigItem, ConfigResponse, ErrorResponse, HealthResponse, ListQuery, ListResponse,
    StatusResponse, UpdateNotesRequest, VersionResponse, WatcherInfo, WatcherStatusResponse,
};

/// Health check endpoint for collectors
#[utoipa::path(
    get,
    path = "/healthz",
    tag = "Health",
    responses(
        (status = 200, description = "Service is healthy", body = HealthResponse)
    )
)]
pub async fn healthz(
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    debug!(
        remote_addr = %addr,
        "Health check request received"
    );
    (
        StatusCode::OK,
        Json(HealthResponse {
            status: "ok".to_string(),
        }),
    )
}

/// Receive report from collector
#[utoipa::path(
    post,
    path = "/api/v1/reports",
    tag = "Reports",
    request_body = ReportEvent,
    responses(
        (status = 200, description = "Report received successfully"),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    )
)]
pub async fn receive_report(
    State(state): State<AppState>,
    Json(event): Json<ReportEvent>,
) -> impl IntoResponse {
    debug!(
        cluster = %event.payload.cluster,
        report_type = %event.payload.report_type,
        namespace = %event.payload.namespace,
        name = %event.payload.name,
        "Received report event"
    );

    match event.event_type {
        ReportEventType::Apply => match state.db.upsert_report(&event.payload) {
            Ok(()) => {
                info!(
                    cluster = %event.payload.cluster,
                    report_type = %event.payload.report_type,
                    namespace = %event.payload.namespace,
                    name = %event.payload.name,
                    "Report stored"
                );
                (StatusCode::OK, Json(serde_json::json!({"status": "ok"})))
            }
            Err(e) => {
                error!(error = %e, "Failed to store report");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e.to_string()})),
                )
            }
        },
        ReportEventType::Delete => {
            match state.db.delete_report(
                &event.payload.cluster,
                &event.payload.namespace,
                &event.payload.name,
                &event.payload.report_type,
            ) {
                Ok(deleted) => {
                    info!(
                        cluster = %event.payload.cluster,
                        report_type = %event.payload.report_type,
                        namespace = %event.payload.namespace,
                        name = %event.payload.name,
                        deleted = deleted,
                        "Report delete processed"
                    );
                    (
                        StatusCode::OK,
                        Json(serde_json::json!({"status": "ok", "deleted": deleted})),
                    )
                }
                Err(e) => {
                    error!(error = %e, "Failed to delete report");
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({"error": e.to_string()})),
                    )
                }
            }
        }
    }
}

/// List vulnerability reports
#[utoipa::path(
    get,
    path = "/api/v1/vulnerabilityreports",
    tag = "Vulnerability Reports",
    params(ListQuery),
    responses(
        (status = 200, description = "List of vulnerability reports", body = ListResponse<ReportMeta>),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn list_vulnerability_reports(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> impl IntoResponse {
    let params = query.to_query_params();

    match state.db.query_reports("vulnerabilityreport", &params) {
        Ok(reports) => {
            let total = reports.len();
            (
                StatusCode::OK,
                Json(ListResponse {
                    items: reports,
                    total,
                }),
            )
        }
        Err(e) => {
            error!(error = %e, "Failed to query vulnerability reports");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ListResponse {
                    items: vec![],
                    total: 0,
                }),
            )
        }
    }
}

/// Get specific vulnerability report
#[utoipa::path(
    get,
    path = "/api/v1/vulnerabilityreports/{cluster}/{namespace}/{name}",
    tag = "Vulnerability Reports",
    params(
        ("cluster" = String, Path, description = "Cluster name"),
        ("namespace" = String, Path, description = "Kubernetes namespace"),
        ("name" = String, Path, description = "Report name")
    ),
    responses(
        (status = 200, description = "Vulnerability report details", body = FullReport),
        (status = 404, description = "Report not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    )
)]
pub async fn get_vulnerability_report(
    State(state): State<AppState>,
    Path((cluster, namespace, name)): Path<(String, String, String)>,
) -> impl IntoResponse {
    match state
        .db
        .get_report(&cluster, &namespace, &name, "vulnerabilityreport")
    {
        Ok(Some(report)) => (StatusCode::OK, Json(serde_json::to_value(report).unwrap())),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Report not found"})),
        ),
        Err(e) => {
            error!(error = %e, "Failed to get vulnerability report");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        }
    }
}

/// List SBOM reports
#[utoipa::path(
    get,
    path = "/api/v1/sbomreports",
    tag = "SBOM Reports",
    params(ListQuery),
    responses(
        (status = 200, description = "List of SBOM reports", body = ListResponse<ReportMeta>),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn list_sbom_reports(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> impl IntoResponse {
    let params = query.to_query_params();

    match state.db.query_reports("sbomreport", &params) {
        Ok(reports) => {
            let total = reports.len();
            (
                StatusCode::OK,
                Json(ListResponse {
                    items: reports,
                    total,
                }),
            )
        }
        Err(e) => {
            error!(error = %e, "Failed to query SBOM reports");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ListResponse {
                    items: vec![],
                    total: 0,
                }),
            )
        }
    }
}

/// Get specific SBOM report
#[utoipa::path(
    get,
    path = "/api/v1/sbomreports/{cluster}/{namespace}/{name}",
    tag = "SBOM Reports",
    params(
        ("cluster" = String, Path, description = "Cluster name"),
        ("namespace" = String, Path, description = "Kubernetes namespace"),
        ("name" = String, Path, description = "Report name")
    ),
    responses(
        (status = 200, description = "SBOM report details", body = FullReport),
        (status = 404, description = "Report not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    )
)]
pub async fn get_sbom_report(
    State(state): State<AppState>,
    Path((cluster, namespace, name)): Path<(String, String, String)>,
) -> impl IntoResponse {
    match state
        .db
        .get_report(&cluster, &namespace, &name, "sbomreport")
    {
        Ok(Some(report)) => (StatusCode::OK, Json(serde_json::to_value(report).unwrap())),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Report not found"})),
        ),
        Err(e) => {
            error!(error = %e, "Failed to get SBOM report");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        }
    }
}

/// List clusters
#[utoipa::path(
    get,
    path = "/api/v1/clusters",
    tag = "Clusters",
    responses(
        (status = 200, description = "List of clusters", body = ListResponse<ClusterInfo>),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn list_clusters(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.list_clusters() {
        Ok(clusters) => {
            let total = clusters.len();
            (
                StatusCode::OK,
                Json(ListResponse {
                    items: clusters,
                    total,
                }),
            )
        }
        Err(e) => {
            error!(error = %e, "Failed to list clusters");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ListResponse {
                    items: vec![],
                    total: 0,
                }),
            )
        }
    }
}

/// Get statistics
#[utoipa::path(
    get,
    path = "/api/v1/stats",
    tag = "Statistics",
    responses(
        (status = 200, description = "Overall statistics", body = Stats),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn get_stats(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.get_stats() {
        Ok(stats) => (StatusCode::OK, Json(stats)),
        Err(e) => {
            error!(error = %e, "Failed to get stats");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(Stats {
                    total_clusters: 0,
                    total_vuln_reports: 0,
                    total_sbom_reports: 0,
                    total_critical: 0,
                    total_high: 0,
                    total_medium: 0,
                    total_low: 0,
                    total_unknown: 0,
                    db_size_bytes: 0,
                    db_size_human: "0 B".to_string(),
                    sqlite_version: "unknown".to_string(),
                }),
            )
        }
    }
}

/// List namespaces
#[utoipa::path(
    get,
    path = "/api/v1/namespaces",
    tag = "Namespaces",
    params(
        ("cluster" = Option<String>, Query, description = "Filter by cluster name")
    ),
    responses(
        (status = 200, description = "List of namespaces", body = ListResponse<String>),
        (status = 500, description = "Internal server error")
    )
)]
pub async fn list_namespaces(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> impl IntoResponse {
    match state.db.list_namespaces(query.cluster.as_deref()) {
        Ok(namespaces) => {
            let total = namespaces.len();
            (
                StatusCode::OK,
                Json(ListResponse {
                    items: namespaces,
                    total,
                }),
            )
        }
        Err(e) => {
            error!(error = %e, "Failed to list namespaces");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ListResponse {
                    items: vec![],
                    total: 0,
                }),
            )
        }
    }
}

/// Delete report
#[utoipa::path(
    delete,
    path = "/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}",
    tag = "Reports",
    params(
        ("cluster" = String, Path, description = "Cluster name"),
        ("report_type" = String, Path, description = "Report type (vulnerabilityreport or sbomreport)"),
        ("namespace" = String, Path, description = "Kubernetes namespace"),
        ("name" = String, Path, description = "Report name")
    ),
    responses(
        (status = 200, description = "Report deleted successfully"),
        (status = 404, description = "Report not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    )
)]
pub async fn delete_report(
    State(state): State<AppState>,
    Path((cluster, report_type, namespace, name)): Path<(String, String, String, String)>,
) -> impl IntoResponse {
    match state
        .db
        .delete_report(&cluster, &namespace, &name, &report_type)
    {
        Ok(deleted) => {
            if deleted {
                (
                    StatusCode::OK,
                    Json(serde_json::json!({"status": "deleted"})),
                )
            } else {
                (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "Report not found"})),
                )
            }
        }
        Err(e) => {
            error!(error = %e, "Failed to delete report");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        }
    }
}

/// Update report notes
#[utoipa::path(
    put,
    path = "/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}/notes",
    tag = "Reports",
    params(
        ("cluster" = String, Path, description = "Cluster name"),
        ("report_type" = String, Path, description = "Report type (vulnerabilityreport or sbomreport)"),
        ("namespace" = String, Path, description = "Kubernetes namespace"),
        ("name" = String, Path, description = "Report name")
    ),
    request_body = UpdateNotesRequest,
    responses(
        (status = 200, description = "Notes updated successfully"),
        (status = 404, description = "Report not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    )
)]
pub async fn update_notes(
    State(state): State<AppState>,
    Path((cluster, report_type, namespace, name)): Path<(String, String, String, String)>,
    Json(request): Json<UpdateNotesRequest>,
) -> impl IntoResponse {
    match state
        .db
        .update_notes(&cluster, &namespace, &name, &report_type, &request.notes)
    {
        Ok(updated) => {
            if updated {
                info!(
                    cluster = %cluster,
                    report_type = %report_type,
                    namespace = %namespace,
                    name = %name,
                    "Report notes updated"
                );
                (
                    StatusCode::OK,
                    Json(serde_json::json!({"status": "updated"})),
                )
            } else {
                (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "Report not found"})),
                )
            }
        }
        Err(e) => {
            error!(error = %e, "Failed to update notes");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
        }
    }
}

/// Get watcher status
#[utoipa::path(
    get,
    path = "/api/v1/watcher/status",
    tag = "Watcher",
    responses(
        (status = 200, description = "Watcher status", body = WatcherStatusResponse)
    )
)]
pub async fn get_watcher_status(State(state): State<AppState>) -> impl IntoResponse {
    let status = WatcherStatusResponse {
        vuln_watcher: WatcherInfo {
            running: state
                .watcher_status
                .vuln_watcher_running
                .load(Ordering::SeqCst),
            initial_sync_done: state
                .watcher_status
                .vuln_initial_sync_done
                .load(Ordering::SeqCst),
        },
        sbom_watcher: WatcherInfo {
            running: state
                .watcher_status
                .sbom_watcher_running
                .load(Ordering::SeqCst),
            initial_sync_done: state
                .watcher_status
                .sbom_initial_sync_done
                .load(Ordering::SeqCst),
        },
    };
    (StatusCode::OK, Json(status))
}

/// Get version info (build-time information)
#[utoipa::path(
    get,
    path = "/api/v1/version",
    tag = "Version",
    responses(
        (status = 200, description = "Version information", body = VersionResponse)
    )
)]
pub async fn get_version() -> impl IntoResponse {
    let version = VersionResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: env!("VERGEN_GIT_SHA").to_string(),
        build_date: env!("VERGEN_BUILD_TIMESTAMP").to_string(),
        rust_version: env!("VERGEN_RUSTC_SEMVER").to_string(),
        rust_channel: env!("VERGEN_RUSTC_CHANNEL").to_string(),
        platform: env!("VERGEN_CARGO_TARGET_TRIPLE").to_string(),
        llvm_version: option_env!("VERGEN_RUSTC_LLVM_VERSION")
            .unwrap_or("unknown")
            .to_string(),
    };
    (StatusCode::OK, Json(version))
}

/// Get server status (runtime information)
#[utoipa::path(
    get,
    path = "/api/v1/status",
    tag = "Status",
    responses(
        (status = 200, description = "Server status", body = StatusResponse)
    )
)]
pub async fn get_status(State(state): State<AppState>) -> impl IntoResponse {
    let collectors = state
        .db
        .list_clusters()
        .map(|c| c.len() as i64)
        .unwrap_or(0);

    let status = StatusResponse {
        hostname: state.runtime.hostname.clone(),
        uptime: state.runtime.uptime_string(),
        collectors,
    };
    (StatusCode::OK, Json(status))
}

/// Get config info
#[utoipa::path(
    get,
    path = "/api/v1/config",
    tag = "Config",
    responses(
        (status = 200, description = "Configuration information", body = ConfigResponse)
    )
)]
pub async fn get_config(State(state): State<AppState>) -> impl IntoResponse {
    let c = &state.config;

    // Helper to format namespaces
    let namespaces_str = if c.namespaces.is_empty() {
        "all".to_string()
    } else {
        c.namespaces.join(", ")
    };

    // Build config items list - easy to extend by adding new entries
    // Use ConfigItem::public() for normal values
    // Use ConfigItem::sensitive() for values that should be masked (e.g., API keys, passwords)
    // ENV names are defined in crate::config::env module (single source of truth)
    let items = vec![
        ConfigItem::public(env::MODE, &c.mode),
        ConfigItem::public(env::CLUSTER_NAME, &c.cluster_name),
        ConfigItem::public(env::NAMESPACES, &namespaces_str),
        ConfigItem::public(env::SERVER_PORT, c.server_port),
        ConfigItem::public(env::HEALTH_PORT, c.health_port),
        ConfigItem::public(env::STORAGE_PATH, &c.storage_path),
        ConfigItem::public(env::LOG_LEVEL, &c.log_level),
        ConfigItem::public(env::LOG_FORMAT, &c.log_format),
        ConfigItem::public(env::WATCH_LOCAL, c.watch_local),
        ConfigItem::public(env::COLLECT_VULN, c.collect_vulnerability_reports),
        ConfigItem::public(env::COLLECT_SBOM, c.collect_sbom_reports),
        // Example of sensitive config (uncomment when adding sensitive values):
        // ConfigItem::sensitive(env::API_KEY, &c.api_key),
    ];

    (StatusCode::OK, Json(ConfigResponse { items }))
}
