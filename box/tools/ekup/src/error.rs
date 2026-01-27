//! Custom error types for ekup.

use thiserror::Error;

/// Errors that can occur during EKS upgrade operations.
#[derive(Error, Debug)]
pub enum EkupError {
    #[error("AWS SDK error: {0}")]
    AwsSdk(String),

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

    #[error("Node group error: {0}")]
    NodeGroupError(String),
}

impl EkupError {
    /// Create an AWS SDK error from any error type.
    pub fn aws<E: std::fmt::Display>(err: E) -> Self {
        EkupError::AwsSdk(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display_cluster_not_found() {
        let err = EkupError::ClusterNotFound("my-cluster".to_string());
        assert_eq!(err.to_string(), "Cluster not found: my-cluster");
    }

    #[test]
    fn test_error_display_invalid_version() {
        let err = EkupError::InvalidVersion("invalid".to_string());
        assert_eq!(err.to_string(), "Invalid version format: invalid");
    }

    #[test]
    fn test_error_display_timeout() {
        let err = EkupError::Timeout {
            operation: "cluster update".to_string(),
            details: "exceeded 30 minutes".to_string(),
        };
        assert_eq!(
            err.to_string(),
            "Timeout waiting for cluster update: exceeded 30 minutes"
        );
    }

    #[test]
    fn test_error_aws_helper() {
        let err = EkupError::aws("connection failed");
        assert_eq!(err.to_string(), "AWS SDK error: connection failed");
    }

    #[test]
    fn test_error_display_user_cancelled() {
        let err = EkupError::UserCancelled;
        assert_eq!(err.to_string(), "Operation cancelled by user");
    }
}
