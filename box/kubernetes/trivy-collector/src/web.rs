//! Web layer for Trivy Collector
//!
//! This module provides the HTTP server and API endpoints.
//!
//! # Module Structure
//! - `handlers`: HTTP request handlers
//! - `state`: Application state and watcher status
//! - `types`: Request and response types
//! - `watcher`: Local Kubernetes watcher

mod handlers;
mod state;
mod types;
mod watcher;

// Re-export public types
pub use handlers::{
    delete_report, get_config, get_dashboard_trends, get_sbom_report, get_stats, get_status,
    get_version, get_vulnerability_report, get_watcher_status, healthz, list_clusters,
    list_namespaces, list_sbom_reports, list_vulnerability_reports, receive_report, update_notes,
};
pub use state::{AppState, RuntimeInfo, WatcherStatus};
pub use types::{
    ConfigItem, ConfigResponse, ErrorResponse, HealthResponse, ListQuery, ListResponse,
    StatusResponse, TrendQuery, UpdateNotesRequest, VersionResponse, WatcherInfo,
    WatcherStatusResponse,
};
pub use watcher::LocalWatcher;

use utoipa::OpenApi;

use crate::collector::types::{ReportEvent, ReportEventType, ReportPayload};
use crate::storage::{
    ClusterInfo, FullReport, ReportMeta, Stats, TrendDataPoint, TrendMeta, TrendResponse,
    VulnSummary,
};

/// OpenAPI documentation
#[derive(OpenApi)]
#[openapi(
    info(
        title = "Trivy Collector API",
        description = "Multi-cluster Trivy report collector and viewer API",
        version = env!("CARGO_PKG_VERSION"),
        license(name = "MIT")
    ),
    paths(
        handlers::healthz,
        handlers::receive_report,
        handlers::list_vulnerability_reports,
        handlers::get_vulnerability_report,
        handlers::list_sbom_reports,
        handlers::get_sbom_report,
        handlers::list_clusters,
        handlers::get_stats,
        handlers::list_namespaces,
        handlers::delete_report,
        handlers::update_notes,
        handlers::get_watcher_status,
        handlers::get_version,
        handlers::get_status,
        handlers::get_config,
        handlers::get_dashboard_trends,
    ),
    components(schemas(
        HealthResponse,
        ErrorResponse,
        UpdateNotesRequest,
        WatcherStatusResponse,
        WatcherInfo,
        VersionResponse,
        StatusResponse,
        ConfigResponse,
        ReportMeta,
        FullReport,
        ClusterInfo,
        Stats,
        VulnSummary,
        ReportEvent,
        ReportEventType,
        ReportPayload,
        TrendResponse,
        TrendMeta,
        TrendDataPoint,
    )),
    tags(
        (name = "Health", description = "Health check endpoints"),
        (name = "Reports", description = "Report management endpoints"),
        (name = "Vulnerability Reports", description = "Vulnerability report endpoints"),
        (name = "SBOM Reports", description = "SBOM report endpoints"),
        (name = "Clusters", description = "Cluster listing endpoints"),
        (name = "Namespaces", description = "Namespace listing endpoints"),
        (name = "Statistics", description = "Statistics endpoints"),
        (name = "Watcher", description = "Watcher status endpoints"),
        (name = "Version", description = "Build version information endpoints"),
        (name = "Status", description = "Server runtime status endpoints"),
        (name = "Config", description = "Configuration endpoints"),
        (name = "Dashboard", description = "Dashboard trend analysis endpoints"),
    )
)]
pub struct ApiDoc;

use anyhow::Result;
use axum::{
    Router,
    http::{Method, StatusCode, header},
    response::{Html, IntoResponse},
    routing::{delete, get, post, put},
};
use rust_embed::Embed;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};

use crate::config::Config;
use crate::health::HealthServer;
use crate::storage::Database;

#[derive(Embed)]
#[folder = "static/"]
struct StaticAssets;

pub async fn run(
    config: Config,
    health_server: HealthServer,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    info!(
        port = config.server_port,
        storage_path = %config.storage_path,
        watch_local = config.watch_local,
        "Starting server mode"
    );

    // Initialize database
    let db = Arc::new(Database::new(&config.get_db_path())?);

    // Initialize watcher status
    let watcher_status = Arc::new(WatcherStatus::new());

    // Start local Kubernetes watcher if enabled
    let watcher_handle = if config.watch_local {
        let db_clone = db.clone();
        let cluster_name = config.cluster_name.clone();
        let namespaces = config.namespaces.clone();
        let shutdown_rx = shutdown.clone();
        let watcher_status_clone = watcher_status.clone();

        info!(
            cluster = %cluster_name,
            namespaces = ?namespaces,
            "Local Kubernetes watcher enabled"
        );

        Some(tokio::spawn(async move {
            match LocalWatcher::new(db_clone, cluster_name, namespaces, watcher_status_clone).await
            {
                Ok(watcher) => {
                    if let Err(e) = watcher.run(shutdown_rx).await {
                        error!(error = %e, "Local watcher error");
                    }
                }
                Err(e) => {
                    warn!(error = %e, "Failed to create local watcher - running without K8s API watching");
                }
            }
        }))
    } else {
        None
    };

    let config_info = Arc::new(state::ConfigInfo::from(&config));
    let runtime_info = Arc::new(state::RuntimeInfo::new());
    let state = AppState {
        db,
        watcher_status,
        config: config_info,
        runtime: runtime_info,
    };

    // Configure CORS
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_origin(Any)
        .allow_headers([header::CONTENT_TYPE]);

    // Build router
    let app = Router::new()
        // Health check endpoint (for collector health checks)
        .route("/healthz", get(healthz))
        // API routes
        .route("/api/v1/reports", post(receive_report))
        .route(
            "/api/v1/vulnerabilityreports",
            get(list_vulnerability_reports),
        )
        .route(
            "/api/v1/vulnerabilityreports/{cluster}/{namespace}/{name}",
            get(get_vulnerability_report),
        )
        .route("/api/v1/sbomreports", get(list_sbom_reports))
        .route(
            "/api/v1/sbomreports/{cluster}/{namespace}/{name}",
            get(get_sbom_report),
        )
        .route("/api/v1/clusters", get(list_clusters))
        .route("/api/v1/stats", get(get_stats))
        .route("/api/v1/namespaces", get(list_namespaces))
        .route("/api/v1/watcher/status", get(get_watcher_status))
        .route("/api/v1/version", get(get_version))
        .route("/api/v1/status", get(get_status))
        .route("/api/v1/config", get(get_config))
        // Dashboard endpoints
        .route("/api/v1/dashboard/trends", get(get_dashboard_trends))
        .route(
            "/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}",
            delete(delete_report),
        )
        .route(
            "/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}/notes",
            put(update_notes),
        )
        // OpenAPI documentation
        .route("/api-docs/openapi.json", get(serve_openapi))
        // Static files and UI
        .route("/", get(serve_index))
        .route("/static/{*path}", get(serve_static))
        .route("/style.css", get(serve_css))
        .route("/app.js", get(serve_js))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.server_port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    info!(addr = %addr, "Server listening");

    // Mark as ready
    health_server.set_ready(true);

    // Run server with graceful shutdown (with ConnectInfo for remote addr logging)
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = shutdown.changed().await;
        info!("Server shutting down");
    })
    .await?;

    // Wait for watcher to finish if it was started
    if let Some(handle) = watcher_handle {
        let _ = handle.await;
    }

    Ok(())
}

async fn serve_index() -> impl IntoResponse {
    match StaticAssets::get("index.html") {
        Some(content) => Html(
            std::str::from_utf8(content.data.as_ref())
                .unwrap_or("")
                .to_string(),
        )
        .into_response(),
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn serve_css() -> impl IntoResponse {
    match StaticAssets::get("style.css") {
        Some(content) => (
            [(header::CONTENT_TYPE, "text/css")],
            std::str::from_utf8(content.data.as_ref())
                .unwrap_or("")
                .to_string(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn serve_js() -> impl IntoResponse {
    match StaticAssets::get("app.js") {
        Some(content) => (
            [(header::CONTENT_TYPE, "application/javascript")],
            std::str::from_utf8(content.data.as_ref())
                .unwrap_or("")
                .to_string(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn serve_static(axum::extract::Path(path): axum::extract::Path<String>) -> impl IntoResponse {
    let path = path.trim_start_matches('/');
    match StaticAssets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref())],
                content.data.to_vec(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, "Not found").into_response(),
    }
}

async fn serve_openapi() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "application/json")],
        ApiDoc::openapi().to_json().unwrap_or_default(),
    )
}
