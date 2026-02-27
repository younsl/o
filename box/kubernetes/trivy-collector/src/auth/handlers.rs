//! Authentication HTTP handlers

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse, Redirect},
};
use axum_extra::extract::PrivateCookieJar;
use cookie::Cookie;
use serde::Deserialize;
use tracing::{error, info, warn};

use super::session::{AuthSession, PENDING_AUTH_COOKIE_NAME, PendingAuth, SESSION_COOKIE_NAME};
use crate::web::AppState;

#[derive(Deserialize)]
pub struct LoginQuery {
    pub return_to: Option<String>,
}

#[derive(Deserialize)]
pub struct CallbackQuery {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[derive(Deserialize)]
pub struct ErrorQuery {
    pub reason: Option<String>,
}

/// GET /auth/login — Initiate OIDC authorization flow
pub async fn login(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    Query(query): Query<LoginQuery>,
) -> impl IntoResponse {
    let auth_state = match &state.auth {
        Some(auth) => auth,
        None => {
            return (cookie_jar, Redirect::temporary("/")).into_response();
        }
    };

    let return_to = query.return_to.unwrap_or_else(|| "/".to_string());

    let (auth_url, csrf_token, pkce_verifier) = auth_state.oidc_client.authorize_url();

    // Store pending auth state in encrypted cookie
    let pending = PendingAuth {
        csrf_token,
        pkce_verifier,
        return_to,
    };

    let pending_json = serde_json::to_string(&pending).unwrap_or_default();
    let pending_cookie = Cookie::build((PENDING_AUTH_COOKIE_NAME, pending_json))
        .path("/")
        .http_only(true)
        .same_site(cookie::SameSite::Lax)
        .max_age(cookie::time::Duration::minutes(10))
        .build();

    let updated_jar = cookie_jar.add(pending_cookie);

    (updated_jar, Redirect::temporary(&auth_url)).into_response()
}

/// GET /auth/callback — Handle OIDC callback
pub async fn callback(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    Query(query): Query<CallbackQuery>,
) -> impl IntoResponse {
    let auth_state = match &state.auth {
        Some(auth) => auth,
        None => {
            return (cookie_jar, Redirect::temporary("/")).into_response();
        }
    };

    // Check for OIDC error response
    if let Some(err) = &query.error {
        let desc = query
            .error_description
            .as_deref()
            .unwrap_or("Unknown error");
        warn!(error = %err, description = %desc, "OIDC provider returned error");
        let reason = urlencoding::encode(err);
        return (
            cookie_jar,
            Redirect::temporary(&format!("/auth/error?reason={}", reason)),
        )
            .into_response();
    }

    // Retrieve pending auth state
    let pending_cookie = match cookie_jar.get(PENDING_AUTH_COOKIE_NAME) {
        Some(c) => c,
        None => {
            warn!("Missing pending auth cookie");
            return (
                cookie_jar,
                Redirect::temporary("/auth/error?reason=missing_state"),
            )
                .into_response();
        }
    };

    let pending: PendingAuth = match serde_json::from_str(pending_cookie.value()) {
        Ok(p) => p,
        Err(e) => {
            error!(error = %e, "Failed to parse pending auth cookie");
            return (
                cookie_jar,
                Redirect::temporary("/auth/error?reason=invalid_state"),
            )
                .into_response();
        }
    };

    // Verify CSRF token
    let state_param = match &query.state {
        Some(s) => s,
        None => {
            warn!("Missing state parameter in callback");
            return (
                cookie_jar,
                Redirect::temporary("/auth/error?reason=missing_state"),
            )
                .into_response();
        }
    };

    if state_param != &pending.csrf_token {
        warn!("CSRF token mismatch");
        return (
            cookie_jar,
            Redirect::temporary("/auth/error?reason=csrf_mismatch"),
        )
            .into_response();
    }

    // Exchange authorization code for tokens
    let code = match &query.code {
        Some(c) => c,
        None => {
            warn!("Missing authorization code");
            return (
                cookie_jar,
                Redirect::temporary("/auth/error?reason=missing_code"),
            )
                .into_response();
        }
    };

    let session = match auth_state
        .oidc_client
        .exchange_code(code, &pending.pkce_verifier)
        .await
    {
        Ok(s) => s,
        Err(e) => {
            error!(error = %e, "Token exchange failed");
            return (
                cookie_jar,
                Redirect::temporary("/auth/error?reason=token_exchange_failed"),
            )
                .into_response();
        }
    };

    // Set session cookie
    let session_json = serde_json::to_string(&session).unwrap_or_default();
    let session_cookie = Cookie::build((SESSION_COOKIE_NAME, session_json))
        .path("/")
        .http_only(true)
        .same_site(cookie::SameSite::Lax)
        .max_age(cookie::time::Duration::hours(8))
        .build();

    // Remove pending auth cookie
    let remove_pending = Cookie::build((PENDING_AUTH_COOKIE_NAME, ""))
        .path("/")
        .max_age(cookie::time::Duration::ZERO)
        .build();

    let updated_jar = cookie_jar.add(session_cookie).add(remove_pending);

    info!(
        sub = %session.sub,
        email = ?session.email,
        "Login successful, redirecting to {}",
        pending.return_to
    );

    (updated_jar, Redirect::temporary(&pending.return_to)).into_response()
}

/// GET /auth/logout — Clear session and redirect to login
pub async fn logout(cookie_jar: PrivateCookieJar) -> impl IntoResponse {
    let remove_session = Cookie::build((SESSION_COOKIE_NAME, ""))
        .path("/")
        .max_age(cookie::time::Duration::ZERO)
        .build();

    let updated_jar = cookie_jar.add(remove_session);

    info!("User logged out");

    (updated_jar, Redirect::temporary("/auth/login")).into_response()
}

/// GET /auth/error — Display authentication error page
pub async fn auth_error(Query(query): Query<ErrorQuery>) -> impl IntoResponse {
    let reason = query.reason.unwrap_or_else(|| "unknown".to_string());

    let message = match reason.as_str() {
        "token_exchange_failed" => {
            "Token exchange failed. The authorization server could not verify your credentials."
        }
        "csrf_mismatch" => "CSRF token mismatch. Your authentication session may have expired.",
        "missing_state" => "Authentication state is missing. Please try logging in again.",
        "missing_code" => "Authorization code is missing from the callback.",
        "invalid_state" => "Authentication state is invalid. Please try logging in again.",
        _ => "An unknown authentication error occurred.",
    };

    let html = format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Authentication Error - Trivy Collector</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background-color: #0f1117;
            color: #e1e4e8;
        }}
        .error-container {{
            text-align: center;
            max-width: 480px;
            padding: 40px;
        }}
        h1 {{
            font-size: 24px;
            margin-bottom: 16px;
            color: #f85149;
        }}
        p {{
            color: #8b949e;
            line-height: 1.6;
            margin-bottom: 24px;
        }}
        .error-code {{
            font-family: 'SF Mono', Monaco, Consolas, monospace;
            font-size: 12px;
            color: #6e7681;
            background: #161b22;
            padding: 8px 16px;
            border-radius: 6px;
            margin-bottom: 24px;
            display: inline-block;
        }}
        a {{
            color: #58a6ff;
            text-decoration: none;
            padding: 10px 24px;
            border: 1px solid #30363d;
            border-radius: 6px;
            transition: all 0.2s;
        }}
        a:hover {{
            background-color: #21262d;
            border-color: #58a6ff;
        }}
    </style>
</head>
<body>
    <div class="error-container">
        <h1>Authentication Failed</h1>
        <p>{message}</p>
        <div class="error-code">Error: {reason}</div>
        <br><br>
        <a href="/auth/login">Try Again</a>
    </div>
</body>
</html>"#
    );

    (StatusCode::OK, Html(html))
}

// ───── Token Management Handlers ─────

#[derive(Deserialize)]
pub struct CreateTokenRequest {
    pub name: String,
    /// Optional description for the token
    #[serde(default)]
    pub description: String,
    /// Token validity in days: 1, 7, 30, 90, 180, or 365
    pub expires_days: u32,
}

/// Extract the authenticated user's sub from the session cookie.
/// Returns None if not authenticated.
fn extract_user_sub(cookie_jar: &PrivateCookieJar) -> Option<String> {
    let cookie = cookie_jar.get(SESSION_COOKIE_NAME)?;
    let session: AuthSession = serde_json::from_str(cookie.value()).ok()?;
    if session.is_expired() {
        return None;
    }
    Some(session.sub)
}

/// GET /api/v1/auth/tokens — List current user's API tokens
pub async fn list_tokens(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
) -> impl IntoResponse {
    let user_sub = match extract_user_sub(&cookie_jar) {
        Some(sub) => sub,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                axum::Json(serde_json::json!({"error": "Authentication required"})),
            )
                .into_response();
        }
    };

    match state.db.list_tokens(&user_sub) {
        Ok(tokens) => axum::Json(serde_json::json!({ "tokens": tokens })).into_response(),
        Err(e) => {
            error!(error = %e, "Failed to list tokens");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "Failed to list tokens"})),
            )
                .into_response()
        }
    }
}

/// POST /api/v1/auth/tokens — Create a new API token
pub async fn create_token(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    axum::Json(body): axum::Json<CreateTokenRequest>,
) -> impl IntoResponse {
    let user_sub = match extract_user_sub(&cookie_jar) {
        Some(sub) => sub,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                axum::Json(serde_json::json!({"error": "Authentication required"})),
            )
                .into_response();
        }
    };

    let name = body.name.trim();
    if name.len() < 4
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "Token name must be 4-64 characters (letters, digits, hyphens, underscores only)"})),
        )
            .into_response();
    }

    if let Ok(existing) = state.db.list_tokens(&user_sub)
        && existing.len() >= 5
    {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(
                serde_json::json!({"error": "Maximum 5 tokens per user. Delete an existing token first."}),
            ),
        )
            .into_response();
    }

    if !matches!(body.expires_days, 1 | 7 | 30 | 90 | 180 | 365) {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(
                serde_json::json!({"error": "expires_days must be one of: 1, 7, 30, 90, 180, 365"}),
            ),
        )
            .into_response();
    }

    let description = body.description.trim();

    match state
        .db
        .create_token(&user_sub, name, description, body.expires_days)
    {
        Ok((plaintext, info)) => {
            info!(user_sub = %user_sub, token_name = %name, "API token created");
            axum::Json(serde_json::json!({
                "token": plaintext,
                "info": info,
            }))
            .into_response()
        }
        Err(e) => {
            let msg = format!("{e:#}");
            if msg.contains("UNIQUE constraint") {
                (
                    StatusCode::CONFLICT,
                    axum::Json(
                        serde_json::json!({"error": format!("A token named '{}' already exists. Please choose a different name.", name)}),
                    ),
                )
                    .into_response()
            } else {
                error!(error = format!("{e:#}"), "Failed to create token");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    axum::Json(serde_json::json!({"error": "Failed to create token"})),
                )
                    .into_response()
            }
        }
    }
}

/// DELETE /api/v1/auth/tokens/{id} — Delete one of the current user's tokens
pub async fn delete_token(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    Path(token_id): Path<i64>,
) -> impl IntoResponse {
    let user_sub = match extract_user_sub(&cookie_jar) {
        Some(sub) => sub,
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                axum::Json(serde_json::json!({"error": "Authentication required"})),
            )
                .into_response();
        }
    };

    match state.db.delete_token(&user_sub, token_id) {
        Ok(true) => {
            info!(user_sub = %user_sub, token_id = token_id, "API token deleted");
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(false) => (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error": "Token not found"})),
        )
            .into_response(),
        Err(e) => {
            error!(error = %e, "Failed to delete token");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(serde_json::json!({"error": "Failed to delete token"})),
            )
                .into_response()
        }
    }
}

/// GET /api/v1/auth/me — Return current user info
pub async fn auth_me(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
) -> impl IntoResponse {
    let auth_mode = state.config.auth_mode.as_deref().unwrap_or("none");

    // If auth is disabled, return anonymous status
    if auth_mode == "none" {
        return axum::Json(serde_json::json!({
            "authenticated": false,
            "auth_mode": "none"
        }))
        .into_response();
    }

    // Check session cookie
    if let Some(cookie) = cookie_jar.get(SESSION_COOKIE_NAME)
        && let Ok(session) = serde_json::from_str::<AuthSession>(cookie.value())
        && !session.is_expired()
    {
        return axum::Json(serde_json::json!({
            "authenticated": true,
            "auth_mode": "keycloak",
            "user": {
                "sub": session.sub,
                "email": session.email,
                "name": session.name,
                "preferred_username": session.preferred_username,
                "groups": session.groups,
            }
        }))
        .into_response();
    }

    axum::Json(serde_json::json!({
        "authenticated": false,
        "auth_mode": "keycloak"
    }))
    .into_response()
}
