//! Authentication middleware for protecting routes

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Redirect, Response},
};
use axum_extra::extract::PrivateCookieJar;
use tracing::{debug, warn};

use super::session::{AuthSession, SESSION_COOKIE_NAME};
use crate::web::AppState;

/// Middleware that requires authentication for protected routes.
///
/// Authentication check order:
/// 1. Session cookie (`trivy_session`) — for browser sessions
/// 2. `Authorization: Bearer <token>` header — for API clients
/// 3. If neither: redirect browsers to login, return 401 for API requests
///
/// On success, inserts `AuthSession` into request extensions for downstream use.
pub async fn require_auth(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let auth_state = match &state.auth {
        Some(auth) => auth,
        // Should not reach here if routing is set up correctly
        None => return next.run(request).await,
    };

    // 1. Check session cookie
    if let Some(cookie) = cookie_jar.get(SESSION_COOKIE_NAME)
        && let Ok(session) = serde_json::from_str::<AuthSession>(cookie.value())
    {
        if !session.is_expired() {
            debug!(sub = %session.sub, "Authenticated via session cookie");
            request.extensions_mut().insert(session);
            return next.run(request).await;
        }
        debug!("Session cookie expired");
    }

    // 2. Check Bearer token
    if let Some(auth_header) = request.headers().get(header::AUTHORIZATION)
        && let Ok(auth_value) = auth_header.to_str()
        && let Some(token) = auth_value.strip_prefix("Bearer ")
    {
        if token.starts_with("tc_") {
            // trivy-collector self-issued API token
            match state.db.validate_token(token) {
                Ok(Some(user_sub)) => {
                    debug!(user_sub = %user_sub, "Authenticated via API token");
                    // Create a minimal session for RBAC
                    let session = AuthSession {
                        sub: user_sub,
                        email: None,
                        name: None,
                        preferred_username: None,
                        groups: vec![],
                        expires_at: i64::MAX,
                    };
                    request.extensions_mut().insert(session);
                    return next.run(request).await;
                }
                Ok(None) => {
                    warn!("API token validation failed: invalid or expired");
                }
                Err(e) => {
                    warn!(error = %e, "API token validation error");
                }
            }
        } else {
            // External JWT (Keycloak JWKS validation)
            match validate_bearer_token(token, auth_state).await {
                Ok(session) => {
                    debug!("Authenticated via Bearer token");
                    request.extensions_mut().insert(session);
                    return next.run(request).await;
                }
                Err(e) => {
                    warn!(error = %e, "Bearer token validation failed");
                }
            }
        }
    }

    // 3. Not authenticated — decide response based on path
    let path = request.uri().path().to_string();

    if path.starts_with("/api/") {
        // API requests get 401 JSON response
        (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({
                "error": "Authentication required",
                "login_url": "/auth/login"
            })),
        )
            .into_response()
    } else {
        // Browser requests get redirected to login
        let return_to = urlencoding::encode(&path);
        Redirect::temporary(&format!("/auth/login?return_to={}", return_to)).into_response()
    }
}

/// RBAC authorization middleware.
/// Must run after `require_auth` which inserts `AuthSession` into extensions.
pub async fn require_rbac(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let method = request.method().as_str().to_string();
    let path = request.uri().path().to_string();

    // Map endpoint to (resource, action)
    let (resource, action) = match super::rbac::resolve_endpoint(&method, &path) {
        Some(ra) => ra,
        None => return next.run(request).await, // Unmapped endpoints pass through
    };

    // Extract user groups from AuthSession in extensions
    let user_groups = request
        .extensions()
        .get::<AuthSession>()
        .map(|s| s.groups.clone())
        .unwrap_or_default();

    // Evaluate RBAC policy
    if !state.rbac.is_allowed(&user_groups, resource, action) {
        debug!(
            resource = resource,
            action = action,
            groups = ?user_groups,
            "RBAC access denied"
        );
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({
                "error": "Access denied",
                "resource": resource,
                "action": action,
            })),
        )
            .into_response();
    }

    next.run(request).await
}

/// Validate a Bearer JWT token against the OIDC provider's JWKS
async fn validate_bearer_token(
    token: &str,
    auth_state: &super::AuthState,
) -> Result<AuthSession, String> {
    // Decode the JWT header to get the key ID
    let header =
        jsonwebtoken::decode_header(token).map_err(|e| format!("Invalid JWT header: {}", e))?;

    let kid = header.kid.ok_or("JWT missing kid")?;

    // Fetch JWKS from the provider
    let jwks_response = reqwest::get(auth_state.oidc_client.jwks_uri())
        .await
        .map_err(|e| format!("Failed to fetch JWKS: {}", e))?
        .text()
        .await
        .map_err(|e| format!("Failed to read JWKS response: {}", e))?;

    let jwks: serde_json::Value =
        serde_json::from_str(&jwks_response).map_err(|e| format!("Invalid JWKS JSON: {}", e))?;

    // Find the matching key
    let keys = jwks["keys"].as_array().ok_or("JWKS missing keys array")?;

    let jwk = keys
        .iter()
        .find(|k| k["kid"].as_str() == Some(&kid))
        .ok_or_else(|| format!("No matching key found for kid: {}", kid))?;

    // Build the decoding key from the JWK
    let n = jwk["n"].as_str().ok_or("JWK missing 'n' field")?;
    let e = jwk["e"].as_str().ok_or("JWK missing 'e' field")?;

    let decoding_key = jsonwebtoken::DecodingKey::from_rsa_components(n, e)
        .map_err(|e| format!("Invalid RSA components: {}", e))?;

    // Validate the token
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
    validation.set_issuer(&[auth_state.oidc_client.issuer_url()]);
    validation.set_audience(&[auth_state.oidc_client.client_id()]);

    let token_data = jsonwebtoken::decode::<serde_json::Value>(token, &decoding_key, &validation)
        .map_err(|e| format!("JWT validation failed: {}", e))?;

    let claims = &token_data.claims;

    // Build AuthSession from JWT claims
    let session = AuthSession {
        sub: claims["sub"].as_str().unwrap_or_default().to_string(),
        email: claims["email"].as_str().map(String::from),
        name: claims["name"].as_str().map(String::from),
        preferred_username: claims["preferred_username"].as_str().map(String::from),
        groups: claims["groups"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        expires_at: claims["exp"].as_i64().unwrap_or(i64::MAX),
    };

    Ok(session)
}
