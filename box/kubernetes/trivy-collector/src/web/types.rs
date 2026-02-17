//! Request and response types for API endpoints

use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

use crate::storage::QueryParams;

/// Query parameters for list endpoints
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct ListQuery {
    /// Filter by cluster name
    #[param(example = "prod-cluster")]
    pub cluster: Option<String>,
    /// Filter by namespace
    #[param(example = "default")]
    pub namespace: Option<String>,
    /// Filter by application name
    #[param(example = "nginx")]
    pub app: Option<String>,
    /// Filter by severity (comma-separated: "critical,high")
    #[param(example = "critical,high")]
    pub severity: Option<String>,
    /// Filter by image (partial match)
    #[param(example = "nginx")]
    pub image: Option<String>,
    /// Filter by CVE ID
    #[param(example = "CVE-2024-1234")]
    pub cve: Option<String>,
    /// Limit results (default: 1000)
    #[param(example = 100)]
    pub limit: Option<i64>,
    /// Pagination offset
    #[param(example = 0)]
    pub offset: Option<i64>,
}

impl ListQuery {
    pub fn to_query_params(&self) -> QueryParams {
        QueryParams {
            cluster: self.cluster.clone(),
            namespace: self.namespace.clone(),
            app: self.app.clone(),
            severity: self
                .severity
                .as_ref()
                .map(|s| s.split(',').map(|x| x.trim().to_string()).collect()),
            image: self.image.clone(),
            cve: self.cve.clone(),
            limit: self.limit,
            offset: self.offset,
        }
    }
}

/// Response wrapper for list endpoints
#[derive(Serialize, ToSchema)]
pub struct ListResponse<T: ToSchema> {
    /// List of items
    pub items: Vec<T>,
    /// Total count
    pub total: usize,
}

/// Error response
#[derive(Serialize, ToSchema)]
pub struct ErrorResponse {
    /// Error message
    pub error: String,
}

/// Health response with memory info for monitoring
#[derive(Serialize, ToSchema)]
pub struct HealthResponse {
    /// Health status
    #[schema(example = "ok")]
    pub status: String,
    /// Memory usage in MB (Linux only, reads from /proc/self/statm)
    #[schema(example = 128)]
    pub memory_mb: Option<u64>,
}

/// Update notes request
#[derive(Deserialize, ToSchema)]
pub struct UpdateNotesRequest {
    /// Notes content
    #[schema(example = "Reviewed, patch scheduled")]
    pub notes: String,
}

/// Watcher status response
#[derive(Serialize, ToSchema)]
pub struct WatcherStatusResponse {
    /// Vulnerability watcher status
    pub vuln_watcher: WatcherInfo,
    /// SBOM watcher status
    pub sbom_watcher: WatcherInfo,
}

/// Individual watcher info
#[derive(Serialize, ToSchema)]
pub struct WatcherInfo {
    /// Whether watcher is running
    pub running: bool,
    /// Whether initial sync is completed
    pub initial_sync_done: bool,
}

/// Version info response (build-time information)
#[derive(Serialize, ToSchema)]
pub struct VersionResponse {
    /// Application version
    #[schema(example = "0.1.0")]
    pub version: String,
    /// Git commit hash
    #[schema(example = "abc1234")]
    pub commit: String,
    /// Build date
    #[schema(example = "2025-01-11T00:00:00Z")]
    pub build_date: String,
    /// Rust version
    #[schema(example = "1.92.0")]
    pub rust_version: String,
    /// Rust channel (stable, beta, nightly)
    #[schema(example = "stable")]
    pub rust_channel: String,
    /// Target platform
    #[schema(example = "aarch64-apple-darwin")]
    pub platform: String,
    /// LLVM version
    #[schema(example = "19.1")]
    pub llvm_version: String,
}

/// Server status response (runtime information)
#[derive(Serialize, ToSchema)]
pub struct StatusResponse {
    /// Server hostname
    #[schema(example = "trivy-collector-abc123")]
    pub hostname: String,
    /// Server uptime
    #[schema(example = "2h 30m 15s")]
    pub uptime: String,
    /// Number of connected collectors (clusters)
    #[schema(example = 3)]
    pub collectors: i64,
}

/// Configuration item with env var name
#[derive(Serialize, ToSchema)]
pub struct ConfigItem {
    /// Environment variable name
    #[schema(example = "MODE")]
    pub env: String,
    /// Current value (as string, masked if sensitive)
    #[schema(example = "server")]
    pub value: String,
    /// Whether this is a sensitive value (masked in UI)
    #[schema(example = false)]
    pub sensitive: bool,
}

impl ConfigItem {
    /// Create a public (non-sensitive) config item
    pub fn public(env: &str, value: impl ToString) -> Self {
        Self {
            env: env.to_string(),
            value: value.to_string(),
            sensitive: false,
        }
    }

    /// Create a sensitive config item (value will be masked)
    pub fn sensitive(env: &str, value: impl ToString) -> Self {
        Self {
            env: env.to_string(),
            value: Self::mask_value(&value.to_string()),
            sensitive: true,
        }
    }

    /// Mask sensitive value
    fn mask_value(value: &str) -> String {
        if value.is_empty() {
            "(empty)".to_string()
        } else if value.len() <= 4 {
            "****".to_string()
        } else {
            format!("{}****", &value[..2])
        }
    }
}

/// Configuration info response
#[derive(Serialize, ToSchema)]
pub struct ConfigResponse {
    /// List of configuration items
    pub items: Vec<ConfigItem>,
}

/// Query parameters for dashboard trend endpoint
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct TrendQuery {
    /// Time range: "1d", "2d", "7d", "30d", or "YYYY-MM-DD:YYYY-MM-DD"
    #[param(example = "30d")]
    pub range: Option<String>,
    /// Filter by cluster name
    #[param(example = "prod-cluster")]
    pub cluster: Option<String>,
    /// Aggregation granularity: "daily" or "weekly"
    #[param(example = "daily")]
    pub granularity: Option<String>,
}

impl TrendQuery {
    /// Parse range string to (start_date, end_date)
    pub fn parse_range(&self) -> (String, String) {
        let today = chrono::Utc::now().date_naive();
        let range = self.range.as_deref().unwrap_or("30d");

        if range.contains(':') {
            // Custom range: "YYYY-MM-DD:YYYY-MM-DD"
            let parts: Vec<&str> = range.split(':').collect();
            if parts.len() == 2 {
                return (parts[0].to_string(), parts[1].to_string());
            }
        }

        // Relative range: 1d, 2d, 7d, 30d
        let days: i64 = match range {
            "1d" => 1,
            "2d" => 2,
            "7d" => 7,
            "30d" => 30,
            _ => 30, // default
        };

        let start = today - chrono::Duration::days(days);
        (start.to_string(), today.to_string())
    }

    /// Get granularity with default (auto-detect hourly for 1d range)
    pub fn get_granularity(&self) -> &str {
        if let Some(ref g) = self.granularity {
            return g.as_str();
        }
        // Auto-detect: use hourly for 1d range
        match self.range.as_deref() {
            Some("1d") => "hourly",
            _ => "daily",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_query_to_query_params_empty() {
        let query = ListQuery {
            cluster: None,
            namespace: None,
            app: None,
            severity: None,
            image: None,
            cve: None,
            limit: None,
            offset: None,
        };

        let params = query.to_query_params();
        assert!(params.cluster.is_none());
        assert!(params.namespace.is_none());
        assert!(params.app.is_none());
        assert!(params.severity.is_none());
        assert!(params.image.is_none());
        assert!(params.cve.is_none());
        assert!(params.limit.is_none());
        assert!(params.offset.is_none());
    }

    #[test]
    fn test_list_query_to_query_params_full() {
        let query = ListQuery {
            cluster: Some("prod".to_string()),
            namespace: Some("default".to_string()),
            app: Some("nginx".to_string()),
            severity: Some("critical,high".to_string()),
            image: Some("nginx:1.25".to_string()),
            cve: Some("CVE-2024-1234".to_string()),
            limit: Some(100),
            offset: Some(50),
        };

        let params = query.to_query_params();
        assert_eq!(params.cluster, Some("prod".to_string()));
        assert_eq!(params.namespace, Some("default".to_string()));
        assert_eq!(params.app, Some("nginx".to_string()));
        assert_eq!(params.image, Some("nginx:1.25".to_string()));
        assert_eq!(params.cve, Some("CVE-2024-1234".to_string()));
        assert_eq!(params.limit, Some(100));
        assert_eq!(params.offset, Some(50));
    }

    #[test]
    fn test_list_query_severity_parsing() {
        let query = ListQuery {
            cluster: None,
            namespace: None,
            app: None,
            severity: Some("critical, high, medium".to_string()),
            image: None,
            cve: None,
            limit: None,
            offset: None,
        };

        let params = query.to_query_params();
        let severities = params.severity.unwrap();
        assert_eq!(severities.len(), 3);
        assert_eq!(severities[0], "critical");
        assert_eq!(severities[1], "high");
        assert_eq!(severities[2], "medium");
    }

    #[test]
    fn test_list_query_severity_single() {
        let query = ListQuery {
            cluster: None,
            namespace: None,
            app: None,
            severity: Some("critical".to_string()),
            image: None,
            cve: None,
            limit: None,
            offset: None,
        };

        let params = query.to_query_params();
        let severities = params.severity.unwrap();
        assert_eq!(severities.len(), 1);
        assert_eq!(severities[0], "critical");
    }
}
