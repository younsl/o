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

/// Full report with data
#[derive(Debug, Clone, serde::Serialize, ToSchema)]
pub struct FullReport {
    /// Report metadata
    pub meta: ReportMeta,
    /// Full report data (JSON)
    pub data: serde_json::Value,
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
