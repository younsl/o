//! Custom error types for ec2-scheduler.

use thiserror::Error;

/// Errors that can occur during EC2 schedule operations.
#[derive(Error, Debug)]
pub enum SchedulerError {
    #[error("[{0}] {1}")]
    AwsSdk(String, String),

    #[error("[{0}] AWS credentials error: {1}")]
    AwsCredentials(String, String),

    #[error("[{0}] AWS region not configured: {1}")]
    AwsRegion(String, String),

    #[error("Invalid cron expression: {0}")]
    InvalidCron(String),

    #[error("Invalid timezone: {0}")]
    InvalidTimezone(String),

    #[error("No instances found: {0}")]
    #[allow(dead_code)]
    NoInstances(String),

    #[error("Kubernetes API error: {0}")]
    #[allow(dead_code)]
    KubernetesApi(String),
}

impl SchedulerError {
    /// Create an AWS SDK error from any error type.
    /// Analyzes the error message to provide more specific error types.
    pub fn aws<E: std::fmt::Debug + std::fmt::Display>(component: &str, err: E) -> Self {
        let err_debug = format!("{err:?}");
        let err_display = err.to_string();
        let component = component.to_string();

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
    fn extract_error_details(debug_str: &str, display_str: &str) -> String {
        if let Some(pos) = debug_str.find("message: Some(\"") {
            let start = pos + "message: Some(\"".len();
            let rest = &debug_str[start..];
            if let Some(end) = rest.find('"') {
                return rest[..end].to_string();
            }
        }

        if !display_str.to_lowercase().contains("service error") {
            return display_str.to_string();
        }

        "AWS API request failed".to_string()
    }

    /// Returns true if this error is transient and should be retried.
    #[allow(dead_code)]
    pub const fn is_transient(&self) -> bool {
        matches!(self, Self::AwsSdk(_, _) | Self::KubernetesApi(_))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display_invalid_cron() {
        let err = SchedulerError::InvalidCron("bad expression".to_string());
        assert_eq!(err.to_string(), "Invalid cron expression: bad expression");
    }

    #[test]
    fn test_error_display_invalid_timezone() {
        let err = SchedulerError::InvalidTimezone("Bad/Zone".to_string());
        assert_eq!(err.to_string(), "Invalid timezone: Bad/Zone");
    }

    #[test]
    fn test_error_display_no_instances() {
        let err = SchedulerError::NoInstances("no matching tags".to_string());
        assert_eq!(err.to_string(), "No instances found: no matching tags");
    }

    #[test]
    fn test_error_aws_helper_generic() {
        let err = SchedulerError::aws("ec2::client", "connection failed");
        assert!(err.to_string().contains("[ec2::client]"));
        assert!(err.to_string().contains("connection failed"));
    }

    #[test]
    fn test_error_aws_credentials_no_credentials() {
        let err = SchedulerError::aws("ec2::client", "No credentials in the property bag");
        assert!(matches!(err, SchedulerError::AwsCredentials(_, _)));
        assert!(err.to_string().contains("AWS credentials error"));
    }

    #[test]
    fn test_error_aws_credentials_expired() {
        let err = SchedulerError::aws(
            "ec2::client",
            "The security token included in the request is expired",
        );
        assert!(matches!(err, SchedulerError::AwsCredentials(_, _)));
    }

    #[test]
    fn test_error_aws_region_missing() {
        let err = SchedulerError::aws("ec2::client", "No region was found");
        assert!(matches!(err, SchedulerError::AwsRegion(_, _)));
        assert!(err.to_string().contains("AWS region not configured"));
    }

    #[test]
    fn test_error_display_kubernetes_api() {
        let err = SchedulerError::KubernetesApi("Failed to patch status".to_string());
        assert_eq!(
            err.to_string(),
            "Kubernetes API error: Failed to patch status"
        );
    }

    #[test]
    fn test_is_transient() {
        assert!(SchedulerError::AwsSdk("x".into(), "y".into()).is_transient());
        assert!(SchedulerError::KubernetesApi("z".into()).is_transient());
        assert!(!SchedulerError::InvalidCron("x".into()).is_transient());
        assert!(!SchedulerError::InvalidTimezone("x".into()).is_transient());
        assert!(!SchedulerError::NoInstances("x".into()).is_transient());
    }

    #[test]
    fn test_extract_details_with_message_pattern() {
        let debug_str = r#"ServiceError { source: SomeError { message: Some("Instance not found"), code: Some("InvalidInstanceID") } }"#;
        let display_str = "service error";
        let details = SchedulerError::extract_error_details(debug_str, display_str);
        assert_eq!(details, "Instance not found");
    }

    #[test]
    fn test_extract_details_fallback_display() {
        let debug_str = "Error { kind: Other }";
        let display_str = "connection timed out";
        let details = SchedulerError::extract_error_details(debug_str, display_str);
        assert_eq!(details, "connection timed out");
    }

    #[test]
    fn test_extract_details_last_resort() {
        let debug_str = "Error { kind: Other }";
        let display_str = "service error occurred";
        let details = SchedulerError::extract_error_details(debug_str, display_str);
        assert_eq!(details, "AWS API request failed");
    }

    #[test]
    fn test_error_aws_credentials_access_denied() {
        let err = SchedulerError::aws("ec2::stop", "Access Denied");
        assert!(matches!(err, SchedulerError::AwsCredentials(_, _)));
    }

    #[test]
    fn test_error_aws_sdk_display() {
        let err = SchedulerError::AwsSdk("ec2::client".to_string(), "throttled".to_string());
        assert_eq!(err.to_string(), "[ec2::client] throttled");
    }

    #[test]
    fn test_is_transient_credentials_not_transient() {
        assert!(!SchedulerError::AwsCredentials("x".into(), "y".into()).is_transient());
    }

    #[test]
    fn test_is_transient_region_not_transient() {
        assert!(!SchedulerError::AwsRegion("x".into(), "y".into()).is_transient());
    }
}
