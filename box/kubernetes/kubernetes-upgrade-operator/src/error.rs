//! Custom error types for kuo.

use thiserror::Error;

/// Errors that can occur during EKS upgrade operations.
#[derive(Error, Debug)]
pub enum KuoError {
    #[error("[{0}] {1}")]
    AwsSdk(String, String),

    #[error("[{0}] AWS credentials error: {1}")]
    AwsCredentials(String, String),

    #[error("[{0}] AWS region not configured: {1}")]
    AwsRegion(String, String),

    #[error("Cluster not found: {0}")]
    ClusterNotFound(String),

    #[error("Invalid version format: {0}")]
    InvalidVersion(String),

    #[error("Upgrade not possible: {0}")]
    UpgradeNotPossible(String),

    #[error("Kubernetes API error: {0}")]
    KubernetesApi(String),
}

impl KuoError {
    /// Create an AWS SDK error from any error type.
    /// Analyzes the error message to provide more specific error types.
    pub fn aws<E: std::fmt::Debug + std::fmt::Display>(component: &str, err: E) -> Self {
        // Use Debug format to get more detailed error information
        let err_debug = format!("{err:?}");
        let err_display = err.to_string();
        let component = component.to_string();

        // Combine both for analysis
        let combined = format!("{err_display} {err_debug}");
        let combined_lower = combined.to_lowercase();

        // Check for credentials-related errors
        if combined_lower.contains("no credentials")
            || combined_lower.contains("credentials not found")
            || combined_lower.contains("invalid credentials")
            || combined_lower.contains("expired token")
            || combined_lower.contains("expiredtoken")
            || combined_lower.contains("the security token included in the request is invalid")
            || combined_lower.contains("the security token included in the request is expired")
            || combined_lower.contains("unrecognized client")
            || combined_lower.contains("invalidclienttokenid")
            || combined_lower.contains("signaturedoesnotmatch")
            || combined_lower.contains("access denied")
            || combined_lower.contains("not authorized")
            || combined_lower.contains("accessdenied")
        {
            return Self::AwsCredentials(
                component,
                Self::extract_error_details(&err_debug, &err_display),
            );
        }

        // Check for region-related errors
        if combined_lower.contains("no region")
            || combined_lower.contains("region not found")
            || combined_lower.contains("missing region")
        {
            return Self::AwsRegion(
                component,
                Self::extract_error_details(&err_debug, &err_display),
            );
        }

        Self::AwsSdk(
            component,
            Self::extract_error_details(&err_debug, &err_display),
        )
    }

    /// Extract meaningful error details from AWS SDK error.
    /// Returns a single-line error message.
    fn extract_error_details(debug_str: &str, display_str: &str) -> String {
        // Try to extract the "message" field from AWS SDK error
        // Pattern: message: Some("actual error message")
        if let Some(pos) = debug_str.find("message: Some(\"") {
            let start = pos + "message: Some(\"".len();
            let rest = &debug_str[start..];
            if let Some(end) = rest.find('"') {
                return rest[..end].to_string();
            }
        }

        // Fallback: use display string if it's informative
        if !display_str.to_lowercase().contains("service error") {
            return display_str.to_string();
        }

        // Last resort: generic message
        "AWS API request failed".to_string()
    }

    /// Returns true if this error is transient and should be retried.
    pub const fn is_transient(&self) -> bool {
        matches!(self, Self::AwsSdk(_, _) | Self::KubernetesApi(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display_cluster_not_found() {
        let err = KuoError::ClusterNotFound("my-cluster".to_string());
        assert_eq!(err.to_string(), "Cluster not found: my-cluster");
    }

    #[test]
    fn test_error_display_invalid_version() {
        let err = KuoError::InvalidVersion("invalid".to_string());
        assert_eq!(err.to_string(), "Invalid version format: invalid");
    }

    #[test]
    fn test_error_aws_helper_generic() {
        let err = KuoError::aws("eks::client", "connection failed");
        assert!(err.to_string().contains("[eks::client]"));
        assert!(err.to_string().contains("connection failed"));
    }

    #[test]
    fn test_error_aws_credentials_no_credentials() {
        let err = KuoError::aws("eks::client", "No credentials in the property bag");
        assert!(matches!(err, KuoError::AwsCredentials(_, _)));
        assert!(err.to_string().contains("[eks::client]"));
        assert!(err.to_string().contains("AWS credentials error"));
    }

    #[test]
    fn test_error_aws_credentials_expired() {
        let err = KuoError::aws(
            "eks::addon",
            "The security token included in the request is expired",
        );
        assert!(matches!(err, KuoError::AwsCredentials(_, _)));
        assert!(err.to_string().contains("[eks::addon]"));
    }

    #[test]
    fn test_error_aws_credentials_access_denied() {
        let err = KuoError::aws("eks::nodegroup", "Access Denied");
        assert!(matches!(err, KuoError::AwsCredentials(_, _)));
        assert!(err.to_string().contains("[eks::nodegroup]"));
    }

    #[test]
    fn test_error_aws_region_missing() {
        let err = KuoError::aws("eks::insights", "No region was found");
        assert!(matches!(err, KuoError::AwsRegion(_, _)));
        assert!(err.to_string().contains("[eks::insights]"));
        assert!(err.to_string().contains("AWS region not configured"));
    }

    #[test]
    fn test_error_display_kubernetes_api() {
        let err = KuoError::KubernetesApi("Failed to list PDBs".to_string());
        assert_eq!(err.to_string(), "Kubernetes API error: Failed to list PDBs");
    }

    #[test]
    fn test_error_display_upgrade_not_possible() {
        let err = KuoError::UpgradeNotPossible("target version lower than current".to_string());
        assert_eq!(
            err.to_string(),
            "Upgrade not possible: target version lower than current"
        );
    }

    #[test]
    fn test_error_aws_sdk_display() {
        let err = KuoError::AwsSdk("eks::client".to_string(), "throttled".to_string());
        assert_eq!(err.to_string(), "[eks::client] throttled");
    }

    #[test]
    fn test_error_extract_details_with_message_pattern() {
        let debug_str = r#"ServiceError { source: SomeError { message: Some("The cluster was not found"), code: Some("ResourceNotFoundException") } }"#;
        let display_str = "service error";
        let details = KuoError::extract_error_details(debug_str, display_str);
        assert_eq!(details, "The cluster was not found");
    }

    #[test]
    fn test_error_extract_details_fallback_display() {
        let debug_str = "Error { kind: Other }";
        let display_str = "connection timed out";
        let details = KuoError::extract_error_details(debug_str, display_str);
        assert_eq!(details, "connection timed out");
    }

    #[test]
    fn test_error_extract_details_last_resort() {
        let debug_str = "Error { kind: Other }";
        let display_str = "service error occurred";
        let details = KuoError::extract_error_details(debug_str, display_str);
        assert_eq!(details, "AWS API request failed");
    }

    #[test]
    fn test_is_transient() {
        assert!(KuoError::AwsSdk("x".into(), "y".into()).is_transient());
        assert!(KuoError::KubernetesApi("z".into()).is_transient());
        assert!(!KuoError::ClusterNotFound("x".into()).is_transient());
    }
}
