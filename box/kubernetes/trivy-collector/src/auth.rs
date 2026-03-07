//! Authentication module for Trivy Collector
//!
//! Supports two modes:
//! - `none`: No authentication (default, backward compatible)
//! - `keycloak`: Keycloak OIDC authentication with Authorization Code Flow + PKCE

pub mod config;
pub mod handlers;
pub mod middleware;
pub mod oidc;
pub mod session;

use serde::{Deserialize, Serialize};

/// Authentication mode
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// No authentication (default)
    None,
    /// Keycloak OIDC authentication
    Keycloak,
}

impl AuthMode {
    pub fn from_str_lossy(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "keycloak" => Self::Keycloak,
            _ => Self::None,
        }
    }
}

impl std::fmt::Display for AuthMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::None => write!(f, "none"),
            Self::Keycloak => write!(f, "keycloak"),
        }
    }
}

/// Authentication state shared across handlers
#[derive(Clone)]
pub struct AuthState {
    pub oidc_client: oidc::OidcClient,
    pub cookie_key: cookie::Key,
}
