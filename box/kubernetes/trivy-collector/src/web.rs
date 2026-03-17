//! Web layer for Trivy Collector
//!
//! This module provides the HTTP server and API endpoints.
//!
//! # Module Structure
//! - `handlers`: HTTP request handlers
//! - `state`: Application state and watcher status
//! - `types`: Request and response types
//! - `watcher`: Local Kubernetes watcher
//! - `admin_handlers`: Admin API handlers
//! - `logging_middleware`: API request logging

mod admin_handlers;
mod handlers;
mod logging_middleware;
mod state;
mod types;
mod watcher;

// Re-export public types
pub use handlers::{
    delete_report, get_config, get_dashboard_trends, get_sbom_report, get_stats, get_status,
    get_version, get_vulnerability_report, get_watcher_status, healthz, list_clusters,
    list_namespaces, list_sbom_reports, list_vulnerability_reports, receive_report,
    search_sbom_components, search_vulnerabilities, suggest_sbom_components,
    suggest_vulnerabilities, update_notes,
};
pub use state::{AppState, RuntimeInfo, WatcherStatus};
pub use types::{
    ComponentSearchQuery, ComponentSuggestQuery, ConfigItem, ConfigResponse, ErrorResponse,
    HealthResponse, ListQuery, ListResponse, StatusResponse, TrendQuery, UpdateNotesRequest,
    VersionResponse, VulnSearchQuery, VulnSuggestQuery, WatcherInfo, WatcherStatusResponse,
};
pub use watcher::LocalWatcher;

use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::collector::types::{ReportEvent, ReportEventType, ReportPayload};
use crate::storage::{
    ClusterInfo, ComponentSearchResult, FullReport, ReportMeta, Stats, TrendDataPoint, TrendMeta,
    TrendResponse, VulnSearchResult, VulnSummary,
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
        handlers::search_vulnerabilities,
        handlers::suggest_vulnerabilities,
        handlers::get_vulnerability_report,
        handlers::list_sbom_reports,
        handlers::search_sbom_components,
        handlers::suggest_sbom_components,
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
        ComponentSearchResult,
        VulnSearchResult,
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
    middleware as axum_middleware,
    response::{Html, IntoResponse},
    routing::{delete, get, post, put},
};
use rust_embed::Embed;
use std::net::SocketAddr;
use std::sync::Arc;
use tower_http::cors::{Any, CorsLayer};
use tracing::{error, info, warn};

use crate::auth;
use crate::auth::rbac::RbacPolicy;
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

    // Initialize authentication
    let auth_mode = auth::AuthMode::from_str_lossy(&config.auth_mode);
    info!(auth_mode = %auth_mode, "Authentication mode configured");

    let auth_state = if auth_mode == auth::AuthMode::Keycloak {
        let issuer_url = config.oidc_issuer_url.as_deref().unwrap();
        let client_id = config.oidc_client_id.as_deref().unwrap();
        let redirect_url = config.oidc_redirect_url.as_deref().unwrap();

        info!(
            issuer_url = %issuer_url,
            client_id = %client_id,
            redirect_url = %redirect_url,
            scopes = %config.oidc_scopes,
            "Connecting to OIDC provider"
        );

        let discover_start = std::time::Instant::now();
        match auth::oidc::OidcClient::discover(
            issuer_url,
            client_id,
            config.oidc_client_secret.as_deref().unwrap(),
            redirect_url,
            &config.oidc_scopes,
        )
        .await
        {
            Ok(oidc_client) => {
                let elapsed = discover_start.elapsed();
                info!(
                    issuer_url = %issuer_url,
                    elapsed_ms = elapsed.as_millis() as u64,
                    "OIDC provider connected successfully"
                );
                let cookie_key = cookie::Key::generate();
                Some(Arc::new(auth::AuthState {
                    oidc_client,
                    cookie_key,
                }))
            }
            Err(e) => {
                let elapsed = discover_start.elapsed();
                error!(
                    issuer_url = %issuer_url,
                    elapsed_ms = elapsed.as_millis() as u64,
                    error = %e,
                    "Failed to connect to OIDC provider"
                );
                return Err(e);
            }
        }
    } else {
        None
    };

    // Initialize RBAC policy
    let rbac_csv = if config.rbac_policy_csv.is_empty() {
        RbacPolicy::default_csv().to_string()
    } else if std::path::Path::new(&config.rbac_policy_csv).exists() {
        std::fs::read_to_string(&config.rbac_policy_csv)
            .unwrap_or_else(|e| {
                warn!(error = %e, path = %config.rbac_policy_csv, "Failed to read RBAC policy file, using default");
                RbacPolicy::default_csv().to_string()
            })
    } else {
        config.rbac_policy_csv.clone()
    };

    let rbac = match RbacPolicy::from_csv(&rbac_csv, &config.rbac_default_policy) {
        Ok(policy) => {
            info!(
                default_policy = %config.rbac_default_policy,
                "RBAC policy loaded"
            );
            Arc::new(policy)
        }
        Err(e) => {
            error!(error = %e, "Failed to parse RBAC policy, using permissive default");
            Arc::new(
                RbacPolicy::from_csv(RbacPolicy::default_csv(), &config.rbac_default_policy)
                    .expect("default policy must parse"),
            )
        }
    };

    let state = AppState {
        db: db.clone(),
        watcher_status,
        config: config_info,
        runtime: runtime_info,
        auth: auth_state,
        rbac,
    };

    // Configure CORS
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_origin(Any)
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    // Build router based on auth mode
    let app = build_router(state, auth_mode).layer(cors);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.server_port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    info!(addr = %addr, "Server listening");

    // Mark as ready
    health_server.set_ready(true);

    // Start background log cleanup task (every 6 hours, retain 7 days)
    let db_cleanup = db.clone();
    let mut shutdown_cleanup = shutdown.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(6 * 3600));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    match db_cleanup.cleanup_old_api_logs(7) {
                        Ok(deleted) if deleted > 0 => {
                            info!(deleted = deleted, "Background API log cleanup completed");
                        }
                        Ok(_) => {}
                        Err(e) => {
                            warn!(error = %e, "Background API log cleanup failed");
                        }
                    }
                }
                _ = shutdown_cleanup.changed() => {
                    break;
                }
            }
        }
    });

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

/// Build the router with conditional auth middleware
fn build_router(state: AppState, auth_mode: auth::AuthMode) -> Router {
    // Public routes (never require auth)
    let public_routes = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/v1/reports", post(receive_report))
        .route("/api/v1/auth/me", get(auth::handlers::auth_me))
        .route("/assets/{*path}", get(serve_asset))
        .route("/static/{*path}", get(serve_static));

    // Auth routes (login, callback, logout, error)
    let auth_routes = Router::new()
        .route("/auth/login", get(auth::handlers::login))
        .route("/auth/callback", get(auth::handlers::callback))
        .route("/auth/logout", get(auth::handlers::logout))
        .route("/auth/error", get(auth::handlers::auth_error));

    // Protected routes (require auth when keycloak is enabled)
    let protected_routes = Router::new()
        .merge(
            SwaggerUi::new("/swagger-ui")
                .url("/api-docs/openapi.json", ApiDoc::openapi())
                .config(
                    utoipa_swagger_ui::Config::from("/api-docs/openapi.json")
                        .display_request_duration(true)
                        .filter(true)
                        .try_it_out_enabled(true)
                        .deep_linking(true),
                ),
        )
        .route(
            "/api/v1/vulnerabilityreports",
            get(list_vulnerability_reports),
        )
        .route(
            "/api/v1/vulnerabilityreports/vulnerabilities/search",
            get(search_vulnerabilities),
        )
        .route(
            "/api/v1/vulnerabilityreports/vulnerabilities/suggest",
            get(suggest_vulnerabilities),
        )
        .route(
            "/api/v1/vulnerabilityreports/{cluster}/{namespace}/{name}",
            get(get_vulnerability_report),
        )
        .route("/api/v1/sbomreports", get(list_sbom_reports))
        .route(
            "/api/v1/sbomreports/components/search",
            get(search_sbom_components),
        )
        .route(
            "/api/v1/sbomreports/components/suggest",
            get(suggest_sbom_components),
        )
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
        .route("/api/v1/dashboard/trends", get(get_dashboard_trends))
        .route(
            "/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}",
            delete(delete_report),
        )
        .route(
            "/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}/notes",
            put(update_notes),
        )
        .route(
            "/api/v1/auth/tokens",
            get(auth::handlers::list_tokens).post(auth::handlers::create_token),
        )
        .route(
            "/api/v1/auth/tokens/{id}",
            delete(auth::handlers::delete_token),
        )
        // Admin routes
        .route(
            "/api/v1/admin/logs",
            get(admin_handlers::list_api_logs).delete(admin_handlers::cleanup_api_logs),
        )
        .route(
            "/api/v1/admin/logs/stats",
            get(admin_handlers::get_api_log_stats),
        )
        .route("/api/v1/admin/info", get(admin_handlers::admin_info))
        .route("/", get(serve_index))
        .fallback(get(serve_index));

    // Apply auth middleware only when keycloak is enabled
    // Middleware order: require_auth (outermost) -> require_rbac (inner)
    // Axum layers execute outer-to-inner, so add RBAC first, then auth
    let protected_routes = if auth_mode == auth::AuthMode::Keycloak {
        protected_routes
            .layer(axum_middleware::from_fn_with_state(
                state.clone(),
                auth::middleware::require_rbac,
            ))
            .layer(axum_middleware::from_fn_with_state(
                state.clone(),
                auth::middleware::require_auth,
            ))
    } else {
        protected_routes
    };

    // Logging middleware applies to all routes (outer layer)
    Router::new()
        .merge(public_routes)
        .merge(auth_routes)
        .merge(protected_routes)
        .layer(axum_middleware::from_fn_with_state(
            state.clone(),
            logging_middleware::api_request_logger,
        ))
        .with_state(state)
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

async fn serve_asset(axum::extract::Path(path): axum::extract::Path<String>) -> impl IntoResponse {
    let full_path = format!("assets/{}", path.trim_start_matches('/'));
    match StaticAssets::get(&full_path) {
        Some(content) => {
            let mime = mime_guess::from_path(&full_path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref())],
                content.data.to_vec(),
            )
                .into_response()
        }
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
