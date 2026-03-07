//! Data models for the storage layer

use utoipa::ToSchema;

/// Query parameters for filtering reports
#[derive(Debug, Default, Clone)]
pub struct QueryParams {
    pub cluster: Option<String>,
    pub namespace: Option<String>,
    pub app: Option<String>,
    pub severity: Option<Vec<String>>,
    pub image: Option<String>,
    pub cve: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Summary of vulnerability counts
#[derive(Debug, Clone, serde::Serialize, ToSchema)]
pub struct VulnSummary {
    /// Critical severity count
    pub critical: i64,
    /// High severity count
    pub high: i64,
    /// Medium severity count
    pub medium: i64,
    /// Low severity count
    pub low: i64,
    /// Unknown severity count
    pub unknown: i64,
}

/// Report metadata for listing
#[derive(Debug, Clone, serde::Serialize, ToSchema)]
pub struct ReportMeta {
    /// Report ID
    pub id: i64,
    /// Cluster name
    #[schema(example = "prod-cluster")]
    pub cluster: String,
    /// Kubernetes namespace
    #[schema(example = "default")]
    pub namespace: String,
    /// Report name
    pub name: String,
    /// Application name
    #[schema(example = "nginx")]
    pub app: String,
    /// Container image
    #[schema(example = "nginx:1.25")]
    pub image: String,
    /// Report type (vulnerabilityreport or sbomreport)
    #[schema(example = "vulnerabilityreport")]
    pub report_type: String,
    /// Vulnerability summary (for vulnerability reports)
    pub summary: Option<VulnSummary>,
    /// Component count (for SBOM reports)
    pub components_count: Option<i64>,
    /// First received timestamp
    pub received_at: String,
    /// Last updated timestamp
    pub updated_at: String,
    /// User notes
    pub notes: String,
    /// Notes creation timestamp
    pub notes_created_at: Option<String>,
    /// Notes update timestamp
    pub notes_updated_at: Option<String>,
}

/// Full report with data (lazy loading)
/// Data is stored as raw JSON string and parsed only when serialized
#[derive(Debug, Clone, ToSchema)]
pub struct FullReport {
    /// Report metadata
    pub meta: ReportMeta,
    /// Full report data as raw JSON string (parsed lazily on serialization)
    #[schema(value_type = serde_json::Value)]
    pub data_json: String,
}

impl serde::Serialize for FullReport {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("FullReport", 2)?;
        state.serialize_field("meta", &self.meta)?;
        // Parse JSON string to Value only during serialization (lazy loading)
        let data: serde_json::Value =
            serde_json::from_str(&self.data_json).unwrap_or(serde_json::Value::Null);
        state.serialize_field("data", &data)?;
        state.end()
    }
}

/// Cluster info
#[derive(Debug, Clone, serde::Serialize, ToSchema)]
pub struct ClusterInfo {
    /// Cluster name
    #[schema(example = "prod-cluster")]
    pub name: String,
    /// Vulnerability report count
    pub vuln_report_count: i64,
    /// SBOM report count
    pub sbom_report_count: i64,
    /// Last seen timestamp
    pub last_seen: String,
}

/// Overall statistics
#[derive(Debug, Clone, serde::Serialize, ToSchema)]
pub struct Stats {
    /// Total cluster count
    pub total_clusters: i64,
    /// Total vulnerability reports
    pub total_vuln_reports: i64,
    /// Total SBOM reports
    pub total_sbom_reports: i64,
    /// Total critical vulnerabilities
    pub total_critical: i64,
    /// Total high vulnerabilities
    pub total_high: i64,
    /// Total medium vulnerabilities
    pub total_medium: i64,
    /// Total low vulnerabilities
    pub total_low: i64,
    /// Total unknown vulnerabilities
    pub total_unknown: i64,
    /// Database size in bytes
    pub db_size_bytes: u64,
    /// Human-readable database size
    #[schema(example = "1.5 MB")]
    pub db_size_human: String,
    /// SQLite version
    #[schema(example = "3.45.0")]
    pub sqlite_version: String,
}

/// API token info (without the hash)
#[derive(Debug, Clone, serde::Serialize)]
pub struct TokenInfo {
    /// Token ID
    pub id: i64,
    /// User-given name for the token
    pub name: String,
    /// User-given description for the token
    pub description: String,
    /// First 11 chars of the token (e.g. "tc_ab12cd34")
    pub token_prefix: String,
    /// Creation timestamp
    pub created_at: String,
    /// Expiration timestamp
    pub expires_at: String,
    /// Last time this token was used
    pub last_used_at: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_report_meta() -> ReportMeta {
        ReportMeta {
            id: 1,
            cluster: "prod".to_string(),
            namespace: "default".to_string(),
            name: "nginx-vuln".to_string(),
            app: "nginx".to_string(),
            image: "nginx:1.25".to_string(),
            report_type: "vulnerabilityreport".to_string(),
            summary: Some(VulnSummary {
                critical: 2,
                high: 5,
                medium: 10,
                low: 3,
                unknown: 1,
            }),
            components_count: None,
            received_at: "2025-01-01T00:00:00Z".to_string(),
            updated_at: "2025-01-01T00:00:00Z".to_string(),
            notes: String::new(),
            notes_created_at: None,
            notes_updated_at: None,
        }
    }

    #[test]
    fn test_full_report_serialize_valid_json() {
        let report = FullReport {
            meta: sample_report_meta(),
            data_json: r#"{"key": "value"}"#.to_string(),
        };

        let json = serde_json::to_value(&report).expect("Failed to serialize");
        assert_eq!(json["data"]["key"], "value");
        assert_eq!(json["meta"]["cluster"], "prod");
    }

    #[test]
    fn test_full_report_serialize_invalid_json() {
        let report = FullReport {
            meta: sample_report_meta(),
            data_json: "not valid json".to_string(),
        };

        // Should not panic — invalid JSON falls back to null
        let json = serde_json::to_value(&report).expect("Failed to serialize");
        assert!(json["data"].is_null());
    }

    #[test]
    fn test_full_report_serialize_empty_json() {
        let report = FullReport {
            meta: sample_report_meta(),
            data_json: String::new(),
        };

        let json = serde_json::to_value(&report).expect("Failed to serialize");
        assert!(json["data"].is_null());
    }

    #[test]
    fn test_vuln_summary_serialization() {
        let summary = VulnSummary {
            critical: 1,
            high: 2,
            medium: 3,
            low: 4,
            unknown: 5,
        };
        let json = serde_json::to_value(&summary).expect("Failed to serialize");
        assert_eq!(json["critical"], 1);
        assert_eq!(json["high"], 2);
        assert_eq!(json["medium"], 3);
        assert_eq!(json["low"], 4);
        assert_eq!(json["unknown"], 5);
    }
}
