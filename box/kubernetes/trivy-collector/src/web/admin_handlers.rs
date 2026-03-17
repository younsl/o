//! Admin API handlers

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use axum_extra::extract::PrivateCookieJar;
use serde::Deserialize;
use tracing::{error, info};

use crate::auth::session::{AuthSession, SESSION_COOKIE_NAME};
use crate::storage::ApiLogQuery;
use crate::web::AppState;

#[derive(Deserialize)]
pub struct LogsQuery {
    pub method: Option<String>,
    pub path: Option<String>,
    pub status_min: Option<u16>,
    pub status_max: Option<u16>,
    pub user: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// GET /api/v1/admin/logs — List API logs with filtering
#[utoipa::path(
    get,
    path = "/api/v1/admin/logs",
    tag = "Admin",
    params(
        ("method" = Option<String>, Query, description = "Filter by HTTP method"),
        ("path" = Option<String>, Query, description = "Filter by path prefix"),
        ("status_min" = Option<u16>, Query, description = "Minimum status code"),
        ("status_max" = Option<u16>, Query, description = "Maximum status code"),
        ("user" = Option<String>, Query, description = "Filter by user email or sub"),
        ("limit" = Option<i64>, Query, description = "Page size (default 50, max 200)"),
        ("offset" = Option<i64>, Query, description = "Pagination offset"),
    ),
    responses(
        (status = 200, description = "API logs list"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn list_api_logs(
    State(state): State<AppState>,
    Query(query): Query<LogsQuery>,
) -> impl IntoResponse {
    let params = ApiLogQuery {
        method: query.method,
        path_prefix: query.path,
        status_min: query.status_min,
        status_max: query.status_max,
        user: query.user,
        limit: query.limit.unwrap_or(50).min(200),
        offset: query.offset.unwrap_or(0),
    };

    match state.db.list_api_logs(&params) {
        Ok((items, total)) => Json(serde_json::json!({
            "items": items,
            "total": total,
        }))
        .into_response(),
        Err(e) => {
            error!(error = %e, "Failed to list API logs");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to list API logs"})),
            )
                .into_response()
        }
    }
}

/// GET /api/v1/admin/logs/stats — Get API log statistics
#[utoipa::path(
    get,
    path = "/api/v1/admin/logs/stats",
    tag = "Admin",
    responses(
        (status = 200, description = "API log statistics"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn get_api_log_stats(State(state): State<AppState>) -> impl IntoResponse {
    match state.db.get_api_log_stats() {
        Ok(stats) => Json(serde_json::json!(stats)).into_response(),
        Err(e) => {
            error!(error = %e, "Failed to get API log stats");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to get API log stats"})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct CleanupQuery {
    pub retention_days: Option<u32>,
}

/// DELETE /api/v1/admin/logs — Cleanup old API logs
#[utoipa::path(
    delete,
    path = "/api/v1/admin/logs",
    tag = "Admin",
    params(
        ("retention_days" = Option<u32>, Query, description = "Days to retain (default 7)"),
    ),
    responses(
        (status = 200, description = "Cleanup result"),
        (status = 500, description = "Internal server error"),
    )
)]
pub async fn cleanup_api_logs(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    Query(query): Query<CleanupQuery>,
) -> impl IntoResponse {
    let retention_days = query.retention_days.unwrap_or(7);

    // Extract user identity for audit trail
    let triggered_by = cookie_jar
        .get(SESSION_COOKIE_NAME)
        .and_then(|c| serde_json::from_str::<AuthSession>(c.value()).ok())
        .and_then(|s| {
            if s.is_expired() {
                None
            } else {
                Some(s.email.unwrap_or(s.sub))
            }
        })
        .unwrap_or_else(|| "anonymous".to_string());

    match state.db.cleanup_old_api_logs(retention_days, &triggered_by) {
        Ok(deleted) => {
            info!(
                deleted = deleted,
                retention_days = retention_days,
                triggered_by = %triggered_by,
                "API logs cleaned up"
            );
            Json(serde_json::json!({
                "deleted": deleted,
                "retention_days": retention_days,
                "triggered_by": triggered_by,
            }))
            .into_response()
        }
        Err(e) => {
            error!(error = %e, "Failed to cleanup API logs");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to cleanup API logs"})),
            )
                .into_response()
        }
    }
}

/// GET /api/v1/admin/info — Admin info summary
#[utoipa::path(
    get,
    path = "/api/v1/admin/info",
    tag = "Admin",
    responses(
        (status = 200, description = "Admin info summary"),
    )
)]
pub async fn admin_info(State(state): State<AppState>) -> impl IntoResponse {
    let log_count: i64 = state
        .db
        .get_api_log_stats()
        .map(|s| s.total_requests)
        .unwrap_or(0);

    let rbac_summary = serde_json::json!({
        "default_policy": state.rbac.default_policy_name(),
    });

    Json(serde_json::json!({
        "log_count": log_count,
        "rbac": rbac_summary,
    }))
}
