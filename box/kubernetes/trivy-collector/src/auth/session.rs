//! Session types for authentication

use serde::{Deserialize, Serialize};

/// Cookie name for the encrypted session
pub const SESSION_COOKIE_NAME: &str = "trivy_session";

/// Authenticated user session stored in encrypted cookie
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSession {
    /// OIDC subject identifier
    pub sub: String,
    /// User email
    pub email: Option<String>,
    /// User display name
    pub name: Option<String>,
    /// Preferred username
    pub preferred_username: Option<String>,
    /// Keycloak groups (display only)
    pub groups: Vec<String>,
    /// Session expiration (Unix timestamp)
    pub expires_at: i64,
}

impl AuthSession {
    /// Check if the session has expired
    pub fn is_expired(&self) -> bool {
        chrono::Utc::now().timestamp() >= self.expires_at
    }
}

/// Pending OIDC authentication state stored in cookie during auth flow
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAuth {
    /// CSRF token (OIDC state parameter)
    pub csrf_token: String,
    /// PKCE code verifier
    pub pkce_verifier: String,
    /// Original URL to redirect back to after auth
    pub return_to: String,
}

/// Cookie name for pending auth state
pub const PENDING_AUTH_COOKIE_NAME: &str = "trivy_pending_auth";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_session_serialize_deserialize() {
        let session = AuthSession {
            sub: "user-123".to_string(),
            email: Some("user@example.com".to_string()),
            name: Some("Test User".to_string()),
            preferred_username: Some("testuser".to_string()),
            groups: vec!["security-team".to_string(), "admin".to_string()],
            expires_at: chrono::Utc::now().timestamp() + 3600,
        };

        let json = serde_json::to_string(&session).unwrap();
        let deserialized: AuthSession = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.sub, "user-123");
        assert_eq!(deserialized.email, Some("user@example.com".to_string()));
        assert_eq!(deserialized.groups.len(), 2);
        assert!(!deserialized.is_expired());
    }

    #[test]
    fn test_session_expired() {
        let session = AuthSession {
            sub: "user-123".to_string(),
            email: None,
            name: None,
            preferred_username: None,
            groups: vec![],
            expires_at: chrono::Utc::now().timestamp() - 100,
        };

        assert!(session.is_expired());
    }

    #[test]
    fn test_pending_auth_serialize() {
        let pending = PendingAuth {
            csrf_token: "csrf-abc".to_string(),
            pkce_verifier: "pkce-xyz".to_string(),
            return_to: "/vulnerabilities".to_string(),
        };

        let json = serde_json::to_string(&pending).unwrap();
        let deserialized: PendingAuth = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.csrf_token, "csrf-abc");
        assert_eq!(deserialized.return_to, "/vulnerabilities");
    }
}
