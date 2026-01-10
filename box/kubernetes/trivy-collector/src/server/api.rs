use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::{debug, error, info};

use crate::collector::types::{ReportEvent, ReportEventType};
use crate::storage::db::{Database, QueryParams};

/// Watcher status shared across the application
#[derive(Default)]
pub struct WatcherStatus {
    pub vuln_watcher_running: AtomicBool,
    pub sbom_watcher_running: AtomicBool,
    pub vuln_initial_sync_done: AtomicBool,
    pub sbom_initial_sync_done: AtomicBool,
}

impl WatcherStatus {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_vuln_running(&self, running: bool) {
        self.vuln_watcher_running.store(running, Ordering::SeqCst);
    }

    pub fn set_sbom_running(&self, running: bool) {
        self.sbom_watcher_running.store(running, Ordering::SeqCst);
    }

    pub fn set_vuln_sync_done(&self, done: bool) {
        self.vuln_initial_sync_done.store(done, Ordering::SeqCst);
    }

    pub fn set_sbom_sync_done(&self, done: bool) {
        self.sbom_initial_sync_done.store(done, Ordering::SeqCst);
    }
}

/// Application state shared across handlers
#[derive(Clone)]
pub struct AppState {
    pub db: Arc<Database>,
    pub watcher_status: Arc<WatcherStatus>,
}

/// Query parameters for list endpoints
#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub cluster: Option<String>,
    pub namespace: Option<String>,
    pub app: Option<String>,
    pub severity: Option<String>, // comma-separated: "critical,high"
    pub image: Option<String>,
    pub cve: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

impl ListQuery {
    pub fn to_query_params(&self) -> QueryParams {
        QueryParams {
            cluster: self.cluster.clone(),
            namespace: self.namespace.clone(),
            app: self.app.clone(),
            severity: self.severity.as_ref().map(|s| {
                s.split(',')
                    .map(|x| x.trim().to_string())
                    .collect()
            }),
            image: self.image.clone(),
            cve: self.cve.clone(),
            limit: self.limit,
            offset: self.offset,
        }
    }
}

/// Response wrapper
#[derive(Serialize)]
pub struct ListResponse<T> {
    pub items: Vec<T>,
    pub total: usize,
}

/// Error response
#[derive(Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

/// Health response
#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
}

// ============================================
// Handlers
// ============================================

/// Health check endpoint for collectors
pub async fn healthz(
    axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>,
) -> impl IntoResponse {
    debug!(
        remote_addr = %addr,
        "Health check request received"
    );
    (StatusCode::OK, Json(HealthResponse { status: "ok".to_string() }))
}

/// Receive report from collector
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
        ReportEventType::Apply => {
            match state.db.upsert_report(&event.payload) {
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
            }
        }
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
                    (StatusCode::OK, Json(serde_json::json!({"status": "ok", "deleted": deleted})))
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
pub async fn get_vulnerability_report(
    State(state): State<AppState>,
    Path((cluster, namespace, name)): Path<(String, String, String)>,
) -> impl IntoResponse {
    match state.db.get_report(&cluster, &namespace, &name, "vulnerabilityreport") {
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
pub async fn get_sbom_report(
    State(state): State<AppState>,
    Path((cluster, namespace, name)): Path<(String, String, String)>,
) -> impl IntoResponse {
    match state.db.get_report(&cluster, &namespace, &name, "sbomreport") {
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
pub async fn get_stats(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.get_stats() {
        Ok(stats) => (StatusCode::OK, Json(stats)),
        Err(e) => {
            error!(error = %e, "Failed to get stats");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(crate::storage::db::Stats {
                    total_clusters: 0,
                    total_vuln_reports: 0,
                    total_sbom_reports: 0,
                    total_critical: 0,
                    total_high: 0,
                    total_medium: 0,
                    total_low: 0,
                    db_size_bytes: 0,
                    db_size_human: "0 B".to_string(),
                }),
            )
        }
    }
}

/// List namespaces
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
pub async fn delete_report(
    State(state): State<AppState>,
    Path((cluster, report_type, namespace, name)): Path<(String, String, String, String)>,
) -> impl IntoResponse {
    match state.db.delete_report(&cluster, &namespace, &name, &report_type) {
        Ok(deleted) => {
            if deleted {
                (StatusCode::OK, Json(serde_json::json!({"status": "deleted"})))
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

/// Update notes request
#[derive(Deserialize)]
pub struct UpdateNotesRequest {
    pub notes: String,
}

/// Update report notes
pub async fn update_notes(
    State(state): State<AppState>,
    Path((cluster, report_type, namespace, name)): Path<(String, String, String, String)>,
    Json(request): Json<UpdateNotesRequest>,
) -> impl IntoResponse {
    match state.db.update_notes(&cluster, &namespace, &name, &report_type, &request.notes) {
        Ok(updated) => {
            if updated {
                info!(
                    cluster = %cluster,
                    report_type = %report_type,
                    namespace = %namespace,
                    name = %name,
                    "Report notes updated"
                );
                (StatusCode::OK, Json(serde_json::json!({"status": "updated"})))
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

/// Watcher status response
#[derive(Serialize)]
pub struct WatcherStatusResponse {
    pub vuln_watcher: WatcherInfo,
    pub sbom_watcher: WatcherInfo,
}

#[derive(Serialize)]
pub struct WatcherInfo {
    pub running: bool,
    pub initial_sync_done: bool,
}

/// Get watcher status
pub async fn get_watcher_status(State(state): State<AppState>) -> impl IntoResponse {
    let status = WatcherStatusResponse {
        vuln_watcher: WatcherInfo {
            running: state.watcher_status.vuln_watcher_running.load(Ordering::SeqCst),
            initial_sync_done: state.watcher_status.vuln_initial_sync_done.load(Ordering::SeqCst),
        },
        sbom_watcher: WatcherInfo {
            running: state.watcher_status.sbom_watcher_running.load(Ordering::SeqCst),
            initial_sync_done: state.watcher_status.sbom_initial_sync_done.load(Ordering::SeqCst),
        },
    };
    (StatusCode::OK, Json(status))
}

/// Version info response
#[derive(Serialize)]
pub struct VersionResponse {
    pub version: String,
    pub commit: String,
    pub build_date: String,
}

/// Get version info
pub async fn get_version() -> impl IntoResponse {
    let version = VersionResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: env!("GIT_COMMIT").to_string(),
        build_date: env!("BUILD_DATE").to_string(),
    };
    (StatusCode::OK, Json(version))
}
