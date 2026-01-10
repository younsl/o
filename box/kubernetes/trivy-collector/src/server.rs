pub mod api;
pub mod watcher;

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
use api::{AppState, WatcherStatus};
use watcher::LocalWatcher;

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

    let state = AppState { db, watcher_status };

    // Configure CORS
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_origin(Any)
        .allow_headers([header::CONTENT_TYPE]);

    // Build router
    let app = Router::new()
        // Health check endpoint (for collector health checks)
        .route("/healthz", get(api::healthz))
        // API routes
        .route("/api/v1/reports", post(api::receive_report))
        .route(
            "/api/v1/vulnerabilityreports",
            get(api::list_vulnerability_reports),
        )
        .route(
            "/api/v1/vulnerabilityreports/{cluster}/{namespace}/{name}",
            get(api::get_vulnerability_report),
        )
        .route("/api/v1/sbomreports", get(api::list_sbom_reports))
        .route(
            "/api/v1/sbomreports/{cluster}/{namespace}/{name}",
            get(api::get_sbom_report),
        )
        .route("/api/v1/clusters", get(api::list_clusters))
        .route("/api/v1/stats", get(api::get_stats))
        .route("/api/v1/namespaces", get(api::list_namespaces))
        .route("/api/v1/watcher/status", get(api::get_watcher_status))
        .route("/api/v1/version", get(api::get_version))
        .route(
            "/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}",
            delete(api::delete_report),
        )
        .route(
            "/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}/notes",
            put(api::update_notes),
        )
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
