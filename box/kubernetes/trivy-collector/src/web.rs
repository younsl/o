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
    CleanupHistoryEntry, ClusterInfo, ComponentSearchResult, FullReport, ReportMeta, Stats,
    TrendDataPoint, TrendMeta, TrendResponse, VulnSearchResult, VulnSummary,
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
        admin_handlers::list_api_logs,
        admin_handlers::get_api_log_stats,
        admin_handlers::cleanup_api_logs,
        admin_handlers::admin_info,
        crate::auth::handlers::auth_me,
        crate::auth::handlers::list_tokens,
        crate::auth::handlers::create_token,
        crate::auth::handlers::delete_token,
        crate::auth::handlers::logout,
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
        CleanupHistoryEntry,
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
        (name = "Admin", description = "Admin API log management endpoints"),
        (name = "Auth", description = "Authentication and token management endpoints"),
    )
)]
pub struct ApiDoc;

use anyhow::Result;
use axum::{
    Router,
    extract::DefaultBodyLimit,
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
use crate::metrics::{CleanupResultLabels, Metrics, ReportTypeLabels};
use crate::storage::Database;

#[derive(Embed)]
#[folder = "static/"]
struct StaticAssets;

pub async fn run(
    config: Config,
    health_server: HealthServer,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    metrics: Arc<Metrics>,
) -> Result<()> {
    info!(
        port = config.server_port,
        storage_path = %config.storage_path,
        watch_local = config.watch_local,
        "Starting server mode"
    );

    // Initialize database
    let db = Arc::new(Database::new(&config.get_db_path()).await?);

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
        metrics: metrics.clone(),
    };

    // Configure CORS
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE])
        .allow_origin(Any)
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION]);

    // Build router based on auth mode
    // Request body limit: 10MB to accommodate large Trivy reports
    let app = build_router(state, auth_mode)
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024))
        .layer(cors);

    let addr = SocketAddr::from(([0, 0, 0, 0], config.server_port));
    let listener = tokio::net::TcpListener::bind(addr).await?;

    info!(addr = %addr, "Server listening");

    // Mark as ready
    health_server.set_ready(true);

    // Start background log cleanup task (every 6 hours, retain 7 days)
    let db_cleanup = db.clone();
    let metrics_cleanup = metrics.clone();
    let mut shutdown_cleanup = shutdown.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(6 * 3600));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    match db_cleanup.cleanup_old_api_logs(7, "system").await {
                        Ok(deleted) => {
                            if let Some(ref runs) = metrics_cleanup.api_logs_cleanup_runs_total {
                                runs.get_or_create(&CleanupResultLabels {
                                    result: "success".to_string(),
                                }).inc();
                            }
                            if deleted > 0 {
                                if let Some(ref deleted_counter) = metrics_cleanup.api_logs_cleanup_deleted_total {
                                    deleted_counter.inc_by(deleted);
                                }
                                info!(deleted = deleted, "Background API log cleanup completed");
                            }
                        }
                        Err(e) => {
                            if let Some(ref runs) = metrics_cleanup.api_logs_cleanup_runs_total {
                                runs.get_or_create(&CleanupResultLabels {
                                    result: "error".to_string(),
                                }).inc();
                            }
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

    // Start background DB metrics refresh task (every 60 seconds)
    let db_metrics_refresh = db.clone();
    let metrics_refresh = metrics.clone();
    let db_path = config.get_db_path();
    let mut shutdown_metrics = shutdown.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    // Update DB file size gauge
                    if let Some(ref gauge) = metrics_refresh.db_size_bytes
                        && let Ok(metadata) = std::fs::metadata(&db_path) {
                            gauge.set(metadata.len() as i64);
                    }
                    // Update report count gauges
                    if let Some(ref family) = metrics_refresh.db_reports_total {
                        if let Ok(count) = db_metrics_refresh.count_reports("vulnerabilityreport").await {
                            family.get_or_create(&ReportTypeLabels {
                                report_type: "vulnerabilityreport".to_string(),
                            }).set(count);
                        }
                        if let Ok(count) = db_metrics_refresh.count_reports("sbomreport").await {
                            family.get_or_create(&ReportTypeLabels {
                                report_type: "sbomreport".to_string(),
                            }).set(count);
                        }
                    }
                    // Update API logs count gauge
                    if let Some(ref gauge) = metrics_refresh.api_logs_total
                        && let Ok(count) = db_metrics_refresh.count_api_logs().await {
                            gauge.set(count);
                    }
                }
                _ = shutdown_metrics.changed() => {
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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    async fn create_test_app_state() -> AppState {
        let db = Arc::new(crate::storage::Database::new(":memory:").await.unwrap());
        let mut registry = prometheus_client::registry::Registry::default();
        let metrics = crate::metrics::Metrics::new(&mut registry, crate::config::Mode::Server);

        AppState {
            db,
            watcher_status: Arc::new(WatcherStatus::new()),
            config: Arc::new(state::ConfigInfo {
                mode: "server".to_string(),
                log_format: "json".to_string(),
                log_level: "info".to_string(),
                health_port: 8080,
                cluster_name: "test".to_string(),
                namespaces: vec![],
                collect_vulnerability_reports: true,
                collect_sbom_reports: true,
                server_port: 3000,
                storage_path: ":memory:".to_string(),
                watch_local: false,
                auth_mode: None,
            }),
            runtime: Arc::new(state::RuntimeInfo::new()),
            auth: None,
            rbac: Arc::new(
                auth::rbac::RbacPolicy::from_csv(
                    auth::rbac::RbacPolicy::default_csv(),
                    "role:readonly",
                )
                .unwrap(),
            ),
            metrics,
        }
    }

    async fn create_router_no_auth() -> Router {
        let state = create_test_app_state().await;
        build_router(state, auth::AuthMode::None)
    }

    #[tokio::test]
    async fn test_build_router_version() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/version")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(json["version"].is_string());
    }

    #[tokio::test]
    async fn test_build_router_status() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_config() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_stats() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/stats")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_clusters() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/clusters")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_watcher_status() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/watcher/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_vuln_reports() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/vulnerabilityreports")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_sbom_reports() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/sbomreports")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_admin_info() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/admin/info")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_admin_logs() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/admin/logs")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_admin_log_stats() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/admin/logs/stats")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_dashboard_trends() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/dashboard/trends")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_receive_report() {
        let app = create_router_no_auth().await;
        let body = serde_json::json!({
            "event_type": "Apply",
            "payload": {
                "cluster": "test",
                "report_type": "vulnerabilityreport",
                "namespace": "default",
                "name": "test-report",
                "data_json": "{}",
                "received_at": "2024-01-01T00:00:00Z"
            }
        });
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/reports")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&body).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_auth_me() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/auth/me")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Without auth, should return 200 with anonymous user
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_namespaces() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/namespaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_static_not_found() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/static/nonexistent.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_build_router_asset_not_found() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/assets/nonexistent.css")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_build_router_vuln_search() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/vulnerabilityreports/vulnerabilities/search?q=CVE-2024")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_vuln_suggest() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/vulnerabilityreports/vulnerabilities/suggest?q=CVE")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_sbom_search() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/sbomreports/components/search?component=log4j")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_sbom_suggest() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/sbomreports/components/suggest?q=log")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_build_router_auth_tokens_list() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/api/v1/auth/tokens")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Without auth cookie, handler returns either tokens list or unauthorized
        assert!(resp.status() == StatusCode::OK || resp.status() == StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_build_router_fallback_index() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/some/unknown/path")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Fallback serves index or 404
        let status = resp.status();
        assert!(status == StatusCode::OK || status == StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_build_router_root() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        assert!(status == StatusCode::OK || status == StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_build_router_swagger_ui() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/swagger-ui/")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Swagger UI should redirect or serve
        assert!(resp.status().is_success() || resp.status().is_redirection());
    }

    #[tokio::test]
    async fn test_build_router_auth_login() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/auth/login")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // Without OIDC configured, login redirects to /
        assert!(resp.status().is_redirection());
    }

    #[tokio::test]
    async fn test_build_router_auth_callback() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/auth/callback")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().is_redirection() || resp.status().is_client_error());
    }

    #[tokio::test]
    async fn test_build_router_auth_logout() {
        let app = create_router_no_auth().await;
        let resp = app
            .oneshot(
                axum::http::Request::builder()
                    .uri("/auth/logout")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert!(resp.status().is_redirection() || resp.status().is_success());
    }
}
