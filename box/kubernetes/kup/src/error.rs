//! Custom error types for kup.

use thiserror::Error;

/// Errors that can occur during EKS upgrade operations.
#[derive(Error, Debug)]
pub enum KupError {
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

    #[error("Operation cancelled by user")]
    UserCancelled,

    #[error("Timeout waiting for {operation}: {details}")]
    Timeout { operation: String, details: String },

    #[error("No clusters found in region")]
    NoClustersFound,

    #[error("Add-on error: {0}")]
    AddonError(String),

    #[error("Managed node group error: {0}")]
    NodeGroupError(String),

    #[error("Kubernetes API error: {0}")]
    KubernetesApi(String),
}

impl KupError {
    /// Create an AWS SDK error from any error type.
    /// Analyzes the error message to provide more specific error types.
    pub fn aws<E: std::fmt::Debug + std::fmt::Display>(component: &str, err: E) -> Self {
        // Use Debug format to get more detailed error information
        let err_debug = format!("{:?}", err);
        let err_display = err.to_string();
        let component = component.to_string();

        // Combine both for analysis
        let combined = format!("{} {}", err_display, err_debug);
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
            return KupError::AwsCredentials(
                component,
                Self::extract_error_details(&err_debug, &err_display),
            );
        }

        // Check for region-related errors
        if combined_lower.contains("no region")
            || combined_lower.contains("region not found")
            || combined_lower.contains("missing region")
        {
            return KupError::AwsRegion(
                component,
                Self::extract_error_details(&err_debug, &err_display),
            );
        }

        KupError::AwsSdk(
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display_cluster_not_found() {
        let err = KupError::ClusterNotFound("my-cluster".to_string());
        assert_eq!(err.to_string(), "Cluster not found: my-cluster");
    }

    #[test]
    fn test_error_display_invalid_version() {
        let err = KupError::InvalidVersion("invalid".to_string());
        assert_eq!(err.to_string(), "Invalid version format: invalid");
    }

    #[test]
    fn test_error_display_timeout() {
        let err = KupError::Timeout {
            operation: "cluster update".to_string(),
            details: "exceeded 30 minutes".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "Timeout waiting for cluster update: exceeded 30 minutes"
        );
    }

    #[test]
    fn test_error_aws_helper_generic() {
        let err = KupError::aws("eks::client", "connection failed");
        assert!(err.to_string().contains("[eks::client]"));
        assert!(err.to_string().contains("connection failed"));
    }

    #[test]
    fn test_error_aws_credentials_no_credentials() {
        let err = KupError::aws("eks::client", "No credentials in the property bag");
        assert!(matches!(err, KupError::AwsCredentials(_, _)));
        assert!(err.to_string().contains("[eks::client]"));
        assert!(err.to_string().contains("AWS credentials error"));
    }

    #[test]
    fn test_error_aws_credentials_expired() {
        let err = KupError::aws(
            "eks::addon",
            "The security token included in the request is expired",
        );
        assert!(matches!(err, KupError::AwsCredentials(_, _)));
        assert!(err.to_string().contains("[eks::addon]"));
    }

    #[test]
    fn test_error_aws_credentials_access_denied() {
        let err = KupError::aws("eks::nodegroup", "Access Denied");
        assert!(matches!(err, KupError::AwsCredentials(_, _)));
        assert!(err.to_string().contains("[eks::nodegroup]"));
    }

    #[test]
    fn test_error_aws_region_missing() {
        let err = KupError::aws("eks::insights", "No region was found");
        assert!(matches!(err, KupError::AwsRegion(_, _)));
        assert!(err.to_string().contains("[eks::insights]"));
        assert!(err.to_string().contains("AWS region not configured"));
    }

    #[test]
    fn test_error_display_user_cancelled() {
        let err = KupError::UserCancelled;
        assert_eq!(err.to_string(), "Operation cancelled by user");
    }
}
