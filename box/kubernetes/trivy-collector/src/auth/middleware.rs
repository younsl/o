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
pub async fn require_auth(
    State(state): State<AppState>,
    cookie_jar: PrivateCookieJar,
    request: Request<Body>,
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
                Ok(()) => {
                    debug!("Authenticated via Bearer token");
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

/// Validate a Bearer JWT token against the OIDC provider's JWKS
async fn validate_bearer_token(token: &str, auth_state: &super::AuthState) -> Result<(), String> {
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

    jsonwebtoken::decode::<serde_json::Value>(token, &decoding_key, &validation)
        .map_err(|e| format!("JWT validation failed: {}", e))?;

    Ok(())
}
