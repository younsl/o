//! API request logging middleware

use axum::{body::Body, extract::State, http::Request, middleware::Next, response::Response};
use std::time::Instant;
use tracing::warn;

use crate::auth::session::AuthSession;
use crate::metrics::{HttpDurationLabels, HttpLabels};
use crate::web::AppState;

/// Middleware that logs API requests to SQLite and records Prometheus metrics
pub async fn api_request_logger(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();

    // Skip non-API paths and collector report ingestion for DB logging
    let skip_db_log = !path.starts_with("/api/")
        || path == "/api/v1/reports"
        || path.starts_with("/api/v1/auth/me");

    // Skip infrastructure paths for metrics
    let skip_metrics = path == "/healthz"
        || path == "/readyz"
        || path == "/metrics"
        || path.starts_with("/assets/")
        || path.starts_with("/static/");

    let method = request.method().to_string();
    let user_agent = request
        .headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let remote_addr = request
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Extract user info from extensions (set by require_auth middleware)
    let (user_sub, user_email) = request
        .extensions()
        .get::<AuthSession>()
        .map(|s| (s.sub.clone(), s.email.clone().unwrap_or_default()))
        .unwrap_or_default();

    let start = Instant::now();
    let response = next.run(request).await;
    let duration_secs = start.elapsed().as_secs_f64();
    let duration_ms = (duration_secs * 1000.0) as u64;
    let status_code = response.status().as_u16();

    // Record Prometheus metrics
    if !skip_metrics {
        if let Some(ref counter) = state.metrics.http_requests_total {
            counter
                .get_or_create(&HttpLabels {
                    method: method.clone(),
                    status: status_code.to_string(),
                })
                .inc();
        }
        if let Some(ref histogram) = state.metrics.http_request_duration_seconds {
            histogram
                .get_or_create(&HttpDurationLabels {
                    method: method.clone(),
                })
                .observe(duration_secs);
        }
    }

    // Async DB write to avoid blocking response
    if !skip_db_log {
        let db = state.db.clone();
        let entry = crate::storage::ApiLogEntry {
            id: None,
            method,
            path,
            status_code,
            duration_ms,
            user_sub,
            user_email,
            remote_addr,
            user_agent,
            created_at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        };

        tokio::spawn(async move {
            if let Err(e) = db.insert_api_log(&entry).await {
                warn!(error = %e, "Failed to log API request");
            }
        });
    }

    response
}
