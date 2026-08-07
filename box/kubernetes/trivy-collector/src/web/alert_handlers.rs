//! HTTP handlers for `/api/v1/alerts` (RBAC-gated CRUD over the alerts ConfigMap).

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use axum_extra::extract::PrivateCookieJar;
use serde::Deserialize;
use tracing::{error, info};

use crate::alerts::evaluator::TestRunError;
use crate::alerts::preview::{self, PreviewResult};
use crate::alerts::types::{AlertRule, Matchers, Receiver, validate_webhook_url};
use crate::alerts::{AlertEvaluator, AlertStore, AlertStoreError};
use crate::auth::session::{AuthSession, SESSION_COOKIE_NAME};
use crate::web::AppState;
use std::collections::BTreeMap;

#[derive(Deserialize, utoipa::ToSchema)]
pub struct AlertRuleInput {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub matchers: Matchers,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default)]
    pub annotations: BTreeMap<String, String>,
    pub receivers: Vec<Receiver>,
    pub cooldown_secs: Option<u64>,
}

fn default_true() -> bool {
    true
}

#[utoipa::path(
    get,
    path = "/api/v1/alerts",
    tag = "Alerts",
    responses((status = 200, description = "Alert rules"))
)]
pub async fn list_alerts(State(state): State<AppState>) -> impl IntoResponse {
    let store = match get_store(&state) {
        Some(s) => s,
        None => return unavailable(),
    };
    match store.list().await {
        Ok(rules) => Json(serde_json::json!({
            "items": rules,
            "total": rules.len(),
            "configmap": store.configmap_name(),
            "namespace": store.namespace(),
        }))
        .into_response(),
        Err(e) => store_error_response(e),
    }
}

#[utoipa::path(
    get,
    path = "/api/v1/alerts/{name}",
    tag = "Alerts",
    params(("name" = String, Path, description = "Rule name")),
    responses((status = 200, description = "Alert rule"), (status = 404, description = "Not found"))
)]
pub async fn get_alert(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let store = match get_store(&state) {
        Some(s) => s,
        None => return unavailable(),
    };
    match store.get(&name).await {
        Ok(rule) => Json(rule).into_response(),
        Err(e) => store_error_response(e),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/alerts",
    tag = "Alerts",
    request_body = AlertRuleInput,
    responses((status = 201, description = "Created"), (status = 400, description = "Invalid input"))
)]
pub async fn create_alert(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    Json(input): Json<AlertRuleInput>,
) -> impl IntoResponse {
    let store = match get_store(&state) {
        Some(s) => s,
        None => return unavailable(),
    };
    if let Err((name, msg)) = validate_receivers(&input.receivers) {
        return webhook_validation_error(&name, msg);
    }
    let user = current_user(&cookie_jar);
    let now = chrono::Utc::now().to_rfc3339();
    let rule = AlertRule {
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        matchers: input.matchers,
        labels: input.labels,
        annotations: input.annotations,
        receivers: input.receivers,
        cooldown_secs: input.cooldown_secs,
        created_at: now,
        created_by: user,
        updated_at: None,
        updated_by: None,
    };
    match store.upsert(&rule).await {
        Ok(()) => {
            info!(rule = %rule.name, by = %rule.created_by, "Alert rule created");
            (StatusCode::CREATED, Json(rule)).into_response()
        }
        Err(e) => store_error_response(e),
    }
}

#[utoipa::path(
    put,
    path = "/api/v1/alerts/{name}",
    tag = "Alerts",
    params(("name" = String, Path, description = "Rule name")),
    request_body = AlertRuleInput,
    responses((status = 200, description = "Updated"), (status = 404, description = "Not found"))
)]
pub async fn update_alert(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    Path(name): Path<String>,
    Json(input): Json<AlertRuleInput>,
) -> impl IntoResponse {
    if input.name != name {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "name in path and body must match"})),
        )
            .into_response();
    }
    let store = match get_store(&state) {
        Some(s) => s,
        None => return unavailable(),
    };
    if let Err((name, msg)) = validate_receivers(&input.receivers) {
        return webhook_validation_error(&name, msg);
    }
    let user = current_user(&cookie_jar);
    let existing = match store.get(&name).await {
        Ok(r) => r,
        Err(e) => return store_error_response(e),
    };
    let now = chrono::Utc::now().to_rfc3339();
    let rule = AlertRule {
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        matchers: input.matchers,
        labels: input.labels,
        annotations: input.annotations,
        receivers: input.receivers,
        cooldown_secs: input.cooldown_secs,
        created_at: existing.created_at,
        created_by: existing.created_by,
        updated_at: Some(now),
        updated_by: Some(user),
    };
    match store.upsert(&rule).await {
        Ok(()) => {
            info!(rule = %rule.name, by = ?rule.updated_by, "Alert rule updated");
            Json(rule).into_response()
        }
        Err(e) => store_error_response(e),
    }
}

#[utoipa::path(
    delete,
    path = "/api/v1/alerts/{name}",
    tag = "Alerts",
    params(("name" = String, Path, description = "Rule name")),
    responses((status = 204, description = "Deleted"), (status = 404, description = "Not found"))
)]
pub async fn delete_alert(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    Path(name): Path<String>,
) -> impl IntoResponse {
    let store = match get_store(&state) {
        Some(s) => s,
        None => return unavailable(),
    };
    let user = current_user(&cookie_jar);
    match store.delete(&name).await {
        Ok(()) => {
            info!(rule = %name, by = %user, "Alert rule deleted");
            StatusCode::NO_CONTENT.into_response()
        }
        Err(e) => store_error_response(e),
    }
}

#[derive(Deserialize, utoipa::ToSchema)]
pub struct PreviewRequest {
    pub matchers: Matchers,
}

#[utoipa::path(
    post,
    path = "/api/v1/alerts/preview",
    tag = "Alerts",
    request_body = PreviewRequest,
    responses(
        (status = 200, description = "Matching items in current data", body = PreviewResult),
        (status = 400, description = "Invalid matcher")
    )
)]
pub async fn preview_alert(
    State(state): State<AppState>,
    Json(req): Json<PreviewRequest>,
) -> impl IntoResponse {
    match preview::run(&state.db, &req.matchers).await {
        Ok(result) => Json(result).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

#[utoipa::path(
    post,
    path = "/api/v1/alerts/test",
    tag = "Alerts",
    request_body = AlertRuleInput,
    responses(
        (status = 200, description = "Test dispatch results per receiver"),
        (status = 400, description = "Invalid input")
    )
)]
pub async fn test_alert_draft(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    Json(input): Json<AlertRuleInput>,
) -> impl IntoResponse {
    let evaluator = match get_evaluator(&state) {
        Some(e) => e,
        None => return unavailable(),
    };
    if input.receivers.iter().all(|r| r.slack.is_none()) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "at least one Slack receiver is required to test"})),
        )
            .into_response();
    }
    if let Err((name, msg)) = validate_receivers(&input.receivers) {
        return webhook_validation_error(&name, msg);
    }
    let user = current_user(&cookie_jar);
    let now = chrono::Utc::now().to_rfc3339();
    let draft = AlertRule {
        name: if input.name.trim().is_empty() {
            "draft".to_string()
        } else {
            input.name
        },
        description: input.description,
        enabled: input.enabled,
        matchers: input.matchers,
        labels: input.labels,
        annotations: input.annotations,
        receivers: input.receivers,
        cooldown_secs: input.cooldown_secs,
        created_at: now,
        created_by: user.clone(),
        updated_at: None,
        updated_by: None,
    };
    let rule_name = draft.name.clone();
    match evaluator.test_with_rule(draft, state.db.as_ref()).await {
        Ok(results) => {
            let total = results.len();
            let succeeded = results.iter().filter(|r| r.success).count();
            info!(
                rule = %rule_name,
                by = %user,
                receivers = total,
                succeeded,
                "Alert draft test dispatched"
            );
            Json(serde_json::json!({
                "rule": rule_name,
                "total": total,
                "succeeded": succeeded,
                "results": results,
            }))
            .into_response()
        }
        Err(TestRunError::NoMatches) => (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(serde_json::json!({
                "error": "no current reports match these matchers — nothing realistic to send. Adjust matchers or wait for a matching report.",
            })),
        )
            .into_response(),
        Err(TestRunError::InvalidExpr(msg)) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("invalid version expression: {msg}")})),
        )
            .into_response(),
        Err(TestRunError::Storage(msg)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("storage error: {msg}")})),
        )
            .into_response(),
    }
}

/// Reject any receiver whose Slack webhook URL is not a canonical Slack
/// hooks endpoint. Without this, a rule author could (accidentally or
/// maliciously) point the alerts subsystem at an arbitrary internal URL
/// and use the trivy-collector pod as an SSRF probe. Returns the offending
/// receiver name and validator error so the caller can build a 400
/// response.
fn validate_receivers(receivers: &[Receiver]) -> Result<(), (String, &'static str)> {
    for r in receivers {
        if let Some(slack) = &r.slack
            && let Err(msg) = validate_webhook_url(&slack.webhook_url)
        {
            return Err((r.name.clone(), msg));
        }
    }
    Ok(())
}

fn webhook_validation_error(name: &str, msg: &str) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({
            "error": format!("receiver '{}': {}", name, msg),
        })),
    )
        .into_response()
}

fn get_store(state: &AppState) -> Option<&AlertStore> {
    state.alerts.as_ref().map(|e| e.store())
}

fn get_evaluator(state: &AppState) -> Option<&AlertEvaluator> {
    state.alerts.as_ref().map(|e| e.as_ref())
}

fn unavailable() -> axum::response::Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": "alerts subsystem unavailable (no Kubernetes API access)"
        })),
    )
        .into_response()
}

fn current_user(jar: &PrivateCookieJar) -> String {
    jar.get(SESSION_COOKIE_NAME)
        .and_then(|c| serde_json::from_str::<AuthSession>(c.value()).ok())
        .and_then(|s| {
            if s.is_expired() {
                None
            } else {
                Some(s.email.unwrap_or(s.sub))
            }
        })
        .unwrap_or_else(|| "anonymous".to_string())
}

fn store_error_response(err: AlertStoreError) -> axum::response::Response {
    match err {
        AlertStoreError::NotFound(n) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": format!("rule '{}' not found", n)})),
        )
            .into_response(),
        AlertStoreError::Invalid(msg) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg})),
        )
            .into_response(),
        e => {
            error!(error = %e, "Alert store error");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e.to_string()})),
            )
                .into_response()
        }
    }
}
