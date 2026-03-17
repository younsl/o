//! API request logging middleware

use axum::{body::Body, extract::State, http::Request, middleware::Next, response::Response};
use std::time::Instant;
use tracing::warn;

use crate::auth::session::AuthSession;
use crate::web::AppState;

/// Middleware that logs API requests to SQLite
pub async fn api_request_logger(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let path = request.uri().path().to_string();

    // Skip non-API paths and collector report ingestion
    if !path.starts_with("/api/")
        || path == "/api/v1/reports"
        || path.starts_with("/api/v1/auth/me")
    {
        return next.run(request).await;
    }

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
    let duration_ms = start.elapsed().as_millis() as u64;
    let status_code = response.status().as_u16();

    // Async DB write to avoid blocking response
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
        if let Err(e) = db.insert_api_log(&entry) {
            warn!(error = %e, "Failed to log API request");
        }
    });

    response
}
