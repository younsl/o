//! OIDC client for Keycloak integration
//!
//! Implements the Authorization Code Flow with PKCE manually using reqwest + jsonwebtoken.

use anyhow::{Context, Result};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::Rng;
use sha2::{Digest, Sha256};
use tracing::{debug, info};

use super::session::AuthSession;

/// OIDC provider metadata (from .well-known/openid-configuration)
#[derive(Debug, Clone, serde::Deserialize)]
struct OidcDiscovery {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    issuer: String,
}

/// Token response from the OIDC provider
#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
struct TokenResponse {
    id_token: Option<String>,
    access_token: String,
    expires_in: Option<u64>,
    #[serde(default)]
    token_type: String,
}

/// OIDC client wrapper
#[derive(Clone)]
pub struct OidcClient {
    authorization_endpoint: String,
    token_endpoint: String,
    jwks_uri: String,
    issuer: String,
    client_id: String,
    client_secret: String,
    redirect_url: String,
    scopes: Vec<String>,
    http_client: reqwest::Client,
}

impl OidcClient {
    /// Create a new OIDC client by performing discovery
    pub async fn discover(
        issuer_url: &str,
        client_id: &str,
        client_secret: &str,
        redirect_url: &str,
        scopes: &str,
    ) -> Result<Self> {
        info!(issuer = %issuer_url, "Performing OIDC discovery");

        let http_client = reqwest::Client::new();
        let discovery_url = format!(
            "{}/.well-known/openid-configuration",
            issuer_url.trim_end_matches('/')
        );

        let discovery: OidcDiscovery = http_client
            .get(&discovery_url)
            .send()
            .await
            .context("Failed to fetch OIDC discovery document")?
            .json()
            .await
            .context("Failed to parse OIDC discovery document")?;

        let scopes: Vec<String> = scopes.split_whitespace().map(|s| s.to_string()).collect();

        info!(
            authorization_endpoint = %discovery.authorization_endpoint,
            token_endpoint = %discovery.token_endpoint,
            jwks_uri = %discovery.jwks_uri,
            scopes = ?scopes,
            "OIDC discovery completed"
        );

        Ok(Self {
            authorization_endpoint: discovery.authorization_endpoint,
            token_endpoint: discovery.token_endpoint,
            jwks_uri: discovery.jwks_uri,
            issuer: discovery.issuer,
            client_id: client_id.to_string(),
            client_secret: client_secret.to_string(),
            redirect_url: redirect_url.to_string(),
            scopes,
            http_client,
        })
    }

    /// Generate authorization URL with PKCE
    pub fn authorize_url(&self) -> (String, String, String) {
        let (pkce_verifier, pkce_challenge) = generate_pkce();
        let csrf_token = generate_random_string(32);

        let scope = self.scopes.join(" ");
        let params = [
            ("response_type", "code"),
            ("client_id", &self.client_id),
            ("redirect_uri", &self.redirect_url),
            ("scope", &scope),
            ("state", &csrf_token),
            ("code_challenge", &pkce_challenge),
            ("code_challenge_method", "S256"),
        ];

        let query = params
            .iter()
            .map(|(k, v)| format!("{}={}", k, urlencoding::encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let url = format!("{}?{}", self.authorization_endpoint, query);

        debug!(authorize_url = %url, "Generated authorization URL");

        (url, csrf_token, pkce_verifier)
    }

    /// Exchange authorization code for tokens
    pub async fn exchange_code(&self, code: &str, pkce_verifier: &str) -> Result<AuthSession> {
        let params = [
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &self.redirect_url),
            ("client_id", &self.client_id),
            ("client_secret", &self.client_secret),
            ("code_verifier", pkce_verifier),
        ];

        let response: TokenResponse = self
            .http_client
            .post(&self.token_endpoint)
            .form(&params)
            .send()
            .await
            .context("Token exchange request failed")?
            .json()
            .await
            .context("Failed to parse token response")?;

        let id_token = response
            .id_token
            .as_deref()
            .context("Missing ID token in response")?;

        // Decode ID token claims (header + payload)
        let claims = decode_id_token_claims(id_token)?;

        let expires_at = response
            .expires_in
            .map(|d| chrono::Utc::now().timestamp() + d as i64)
            .unwrap_or_else(|| chrono::Utc::now().timestamp() + 3600);

        let session = AuthSession {
            sub: claims.sub,
            email: claims.email,
            name: claims.name,
            preferred_username: claims.preferred_username,
            groups: claims.groups,
            expires_at,
        };

        info!(
            sub = %session.sub,
            email = ?session.email,
            groups = ?session.groups,
            "User authenticated successfully"
        );

        Ok(session)
    }

    /// Get the JWKS URI for Bearer token validation
    pub fn jwks_uri(&self) -> &str {
        &self.jwks_uri
    }

    /// Get the issuer URL for token validation
    pub fn issuer_url(&self) -> &str {
        &self.issuer
    }

    /// Get the client ID for audience validation
    pub fn client_id(&self) -> &str {
        &self.client_id
    }
}

/// ID token claims extracted from JWT payload
#[derive(Debug, serde::Deserialize)]
struct IdTokenClaims {
    sub: String,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    preferred_username: Option<String>,
    #[serde(default)]
    groups: Vec<String>,
}

/// Decode JWT payload without signature verification (signature is verified
/// by the token endpoint's TLS connection trust)
fn decode_id_token_claims(id_token: &str) -> Result<IdTokenClaims> {
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() != 3 {
        anyhow::bail!("Invalid JWT format: expected 3 parts, got {}", parts.len());
    }

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .context("Failed to base64-decode JWT payload")?;

    let claims: IdTokenClaims =
        serde_json::from_slice(&payload_bytes).context("Failed to parse ID token claims")?;

    Ok(claims)
}

/// Generate PKCE verifier and challenge (S256)
fn generate_pkce() -> (String, String) {
    let verifier = generate_random_string(43);

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());

    (verifier, challenge)
}

/// Generate a cryptographically random URL-safe string
fn generate_random_string(len: usize) -> String {
    let mut rng = rand::thread_rng();
    let bytes: Vec<u8> = (0..len).map(|_| rng.r#gen()).collect();
    URL_SAFE_NO_PAD.encode(&bytes)
}
