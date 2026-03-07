//! Authentication configuration constants and validation

/// Environment variable names for auth configuration
pub mod env {
    pub const AUTH_MODE: &str = "AUTH_MODE";
    pub const OIDC_ISSUER_URL: &str = "OIDC_ISSUER_URL";
    pub const OIDC_CLIENT_ID: &str = "OIDC_CLIENT_ID";
    pub const OIDC_CLIENT_SECRET: &str = "OIDC_CLIENT_SECRET";
    pub const OIDC_REDIRECT_URL: &str = "OIDC_REDIRECT_URL";
    pub const OIDC_SCOPES: &str = "OIDC_SCOPES";
}

/// Default OIDC scopes
pub const DEFAULT_OIDC_SCOPES: &str = "openid profile email groups";

/// Validate that all required OIDC fields are present when auth_mode is "keycloak"
pub fn validate_keycloak_config(
    oidc_issuer_url: &Option<String>,
    oidc_client_id: &Option<String>,
    oidc_client_secret: &Option<String>,
    oidc_redirect_url: &Option<String>,
) -> Result<(), String> {
    let mut missing = Vec::new();

    if oidc_issuer_url.as_ref().is_none_or(|s| s.is_empty()) {
        missing.push(env::OIDC_ISSUER_URL);
    }
    if oidc_client_id.as_ref().is_none_or(|s| s.is_empty()) {
        missing.push(env::OIDC_CLIENT_ID);
    }
    if oidc_client_secret.as_ref().is_none_or(|s| s.is_empty()) {
        missing.push(env::OIDC_CLIENT_SECRET);
    }
    if oidc_redirect_url.as_ref().is_none_or(|s| s.is_empty()) {
        missing.push(env::OIDC_REDIRECT_URL);
    }

    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "AUTH_MODE=keycloak requires: {}",
            missing.join(", ")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_keycloak_all_present() {
        let result = validate_keycloak_config(
            &Some("https://keycloak.example.com/realms/test".to_string()),
            &Some("client-id".to_string()),
            &Some("client-secret".to_string()),
            &Some("http://localhost:3000/auth/callback".to_string()),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_validate_keycloak_missing_all() {
        let result = validate_keycloak_config(&None, &None, &None, &None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("OIDC_ISSUER_URL"));
        assert!(err.contains("OIDC_CLIENT_ID"));
        assert!(err.contains("OIDC_CLIENT_SECRET"));
        assert!(err.contains("OIDC_REDIRECT_URL"));
    }

    #[test]
    fn test_validate_keycloak_missing_partial() {
        let result = validate_keycloak_config(
            &Some("https://keycloak.example.com/realms/test".to_string()),
            &None,
            &Some("secret".to_string()),
            &None,
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(!err.contains("OIDC_ISSUER_URL"));
        assert!(err.contains("OIDC_CLIENT_ID"));
        assert!(err.contains("OIDC_REDIRECT_URL"));
    }

    #[test]
    fn test_validate_keycloak_empty_strings() {
        let result = validate_keycloak_config(
            &Some("".to_string()),
            &Some("client-id".to_string()),
            &Some("".to_string()),
            &Some("http://localhost:3000/auth/callback".to_string()),
        );
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.contains("OIDC_ISSUER_URL"));
        assert!(err.contains("OIDC_CLIENT_SECRET"));
    }
}
