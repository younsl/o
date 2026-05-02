use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::Resource;
use kube::api::TypeMeta;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// VulnerabilityReport CRD from Trivy Operator
/// API Group: aquasecurity.github.io/v1alpha1
/// Note: Trivy uses `report` field instead of standard `spec`
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VulnerabilityReport {
    #[serde(flatten)]
    pub types: Option<TypeMeta>,
    pub metadata: ObjectMeta,
    #[serde(default)]
    pub report: VulnerabilityReportData,
}

impl Resource for VulnerabilityReport {
    type DynamicType = ();
    type Scope = k8s_openapi::NamespaceResourceScope;

    fn kind(&(): &Self::DynamicType) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("VulnerabilityReport")
    }

    fn group(&(): &Self::DynamicType) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("aquasecurity.github.io")
    }

    fn version(&(): &Self::DynamicType) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("v1alpha1")
    }

    fn plural(&(): &Self::DynamicType) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("vulnerabilityreports")
    }

    fn meta(&self) -> &ObjectMeta {
        &self.metadata
    }

    fn meta_mut(&mut self) -> &mut ObjectMeta {
        &mut self.metadata
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VulnerabilityReportData {
    #[serde(default)]
    pub artifact: Artifact,
    #[serde(default)]
    pub registry: Registry,
    #[serde(default)]
    pub scanner: Scanner,
    #[serde(default)]
    pub summary: VulnerabilitySummary,
    #[serde(default)]
    pub vulnerabilities: Vec<Vulnerability>,
    #[serde(default)]
    pub os: Option<OsInfo>,
    #[serde(default)]
    pub update_timestamp: Option<String>,
}

/// SbomReport CRD from Trivy Operator
/// API Group: aquasecurity.github.io/v1alpha1
/// Note: Trivy uses `report` field instead of standard `spec`
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SbomReport {
    #[serde(flatten)]
    pub types: Option<TypeMeta>,
    pub metadata: ObjectMeta,
    #[serde(default)]
    pub report: SbomReportData,
}

impl Resource for SbomReport {
    type DynamicType = ();
    type Scope = k8s_openapi::NamespaceResourceScope;

    fn kind(&(): &Self::DynamicType) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("SbomReport")
    }

    fn group(&(): &Self::DynamicType) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("aquasecurity.github.io")
    }

    fn version(&(): &Self::DynamicType) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("v1alpha1")
    }

    fn plural(&(): &Self::DynamicType) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("sbomreports")
    }

    fn meta(&self) -> &ObjectMeta {
        &self.metadata
    }

    fn meta_mut(&mut self) -> &mut ObjectMeta {
        &mut self.metadata
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SbomReportData {
    #[serde(default)]
    pub artifact: Artifact,
    #[serde(default)]
    pub registry: Registry,
    #[serde(default)]
    pub scanner: Scanner,
    #[serde(default)]
    pub summary: SbomSummary,
    #[serde(default)]
    pub components: SbomComponents,
    #[serde(default)]
    pub update_timestamp: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    #[serde(default)]
    pub repository: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub digest: String,
    #[serde(default)]
    pub mime_type: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    #[serde(default)]
    pub server: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Scanner {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub vendor: String,
    #[serde(default)]
    pub version: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VulnerabilitySummary {
    #[serde(default)]
    pub critical_count: i64,
    #[serde(default)]
    pub high_count: i64,
    #[serde(default)]
    pub medium_count: i64,
    #[serde(default)]
    pub low_count: i64,
    #[serde(default)]
    pub unknown_count: i64,
    #[serde(default)]
    pub none_count: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Vulnerability {
    #[serde(default, rename = "vulnerabilityID")]
    pub vulnerability_id: String,
    #[serde(default)]
    pub resource: String,
    #[serde(default)]
    pub installed_version: String,
    #[serde(default)]
    pub fixed_version: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub primary_link: String,
    #[serde(default)]
    pub links: Vec<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub target: String,
    #[serde(default, rename = "class")]
    pub vulnerability_class: String,
    #[serde(default)]
    pub pkg_type: String,
    #[serde(default, rename = "pkgID")]
    pub pkg_id: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub eosl: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SbomSummary {
    #[serde(default)]
    pub components_count: i64,
    #[serde(default)]
    pub dependencies_count: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SbomComponents {
    #[serde(default)]
    pub bom_format: String,
    #[serde(default)]
    pub spec_version: String,
    #[serde(default)]
    pub serial_number: String,
    #[serde(default)]
    pub version: i32,
    #[serde(default)]
    pub components: Vec<SbomComponent>,
    #[serde(default)]
    pub dependencies: Vec<SbomDependency>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SbomDependency {
    #[serde(default, rename = "ref")]
    pub dependency_ref: String,
    #[serde(default, rename = "dependsOn")]
    pub depends_on: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SbomComponent {
    #[serde(default, rename = "type")]
    pub component_type: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub purl: String,
    #[serde(default, rename = "bom-ref")]
    pub bom_ref: String,
    #[serde(default)]
    pub supplier: Option<SbomSupplier>,
    #[serde(default)]
    pub licenses: Vec<SbomLicense>,
    #[serde(default)]
    pub properties: Vec<SbomProperty>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SbomSupplier {
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SbomLicense {
    #[serde(default)]
    pub license: SbomLicenseInfo,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SbomLicenseInfo {
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SbomProperty {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub value: String,
}

/// Payload sent from collector to server
#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ReportPayload {
    /// Cluster name
    #[schema(example = "prod-cluster")]
    pub cluster: String,
    /// Report type (vulnerabilityreport or sbomreport)
    #[schema(example = "vulnerabilityreport")]
    pub report_type: String,
    /// Kubernetes namespace
    #[schema(example = "default")]
    pub namespace: String,
    /// Report name
    pub name: String,
    /// Full report data as raw JSON string (avoids double parsing overhead)
    pub data_json: String,
    /// Received timestamp
    pub received_at: chrono::DateTime<chrono::Utc>,
}

/// Report event type
#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub enum ReportEventType {
    /// Apply (create or update) report
    Apply,
    /// Delete report
    Delete,
}

/// Report event sent from collector to server
#[derive(Clone, Debug, Serialize, Deserialize, utoipa::ToSchema)]
pub struct ReportEvent {
    /// Event type (Apply or Delete)
    pub event_type: ReportEventType,
    /// Report payload
    pub payload: ReportPayload,
}

/// Helper to extract app name from labels
pub fn extract_app_name(metadata: &ObjectMeta) -> String {
    metadata
        .labels
        .as_ref()
        .and_then(|labels| {
            labels
                .get("trivy-operator.resource.name")
                .or_else(|| labels.get("app.kubernetes.io/name"))
                .or_else(|| labels.get("app"))
        })
        .cloned()
        .unwrap_or_else(|| "unknown".to_string())
}

/// Helper to extract container name from labels
pub fn extract_container_name(metadata: &ObjectMeta) -> String {
    metadata
        .labels
        .as_ref()
        .and_then(|labels| labels.get("trivy-operator.container.name"))
        .cloned()
        .unwrap_or_else(|| "unknown".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn create_metadata_with_labels(labels: BTreeMap<String, String>) -> ObjectMeta {
        ObjectMeta {
            labels: Some(labels),
            ..Default::default()
        }
    }

    #[test]
    fn test_extract_app_name_trivy_operator_label() {
        let mut labels = BTreeMap::new();
        labels.insert(
            "trivy-operator.resource.name".to_string(),
            "nginx-deployment".to_string(),
        );
        let metadata = create_metadata_with_labels(labels);

        assert_eq!(extract_app_name(&metadata), "nginx-deployment");
    }

    #[test]
    fn test_extract_app_name_kubernetes_label() {
        let mut labels = BTreeMap::new();
        labels.insert("app.kubernetes.io/name".to_string(), "my-app".to_string());
        let metadata = create_metadata_with_labels(labels);

        assert_eq!(extract_app_name(&metadata), "my-app");
    }

    #[test]
    fn test_extract_app_name_app_label() {
        let mut labels = BTreeMap::new();
        labels.insert("app".to_string(), "legacy-app".to_string());
        let metadata = create_metadata_with_labels(labels);

        assert_eq!(extract_app_name(&metadata), "legacy-app");
    }

    #[test]
    fn test_extract_app_name_priority() {
        // trivy-operator.resource.name should take precedence
        let mut labels = BTreeMap::new();
        labels.insert(
            "trivy-operator.resource.name".to_string(),
            "trivy-name".to_string(),
        );
        labels.insert("app.kubernetes.io/name".to_string(), "k8s-name".to_string());
        labels.insert("app".to_string(), "app-name".to_string());
        let metadata = create_metadata_with_labels(labels);

        assert_eq!(extract_app_name(&metadata), "trivy-name");
    }

    #[test]
    fn test_extract_app_name_no_labels() {
        let metadata = ObjectMeta::default();
        assert_eq!(extract_app_name(&metadata), "unknown");
    }

    #[test]
    fn test_extract_app_name_empty_labels() {
        let metadata = create_metadata_with_labels(BTreeMap::new());
        assert_eq!(extract_app_name(&metadata), "unknown");
    }

    #[test]
    fn test_extract_container_name_present() {
        let mut labels = BTreeMap::new();
        labels.insert(
            "trivy-operator.container.name".to_string(),
            "nginx".to_string(),
        );
        let metadata = create_metadata_with_labels(labels);

        assert_eq!(extract_container_name(&metadata), "nginx");
    }

    #[test]
    fn test_extract_container_name_missing() {
        let metadata = ObjectMeta::default();
        assert_eq!(extract_container_name(&metadata), "unknown");
    }

    #[test]
    fn test_report_event_serialization() {
        let event = ReportEvent {
            event_type: ReportEventType::Apply,
            payload: ReportPayload {
                cluster: "test-cluster".to_string(),
                report_type: "vulnerabilityreport".to_string(),
                namespace: "default".to_string(),
                name: "test-report".to_string(),
                data_json: "{}".to_string(),
                received_at: chrono::Utc::now(),
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("test-cluster"));
        assert!(json.contains("Apply"));

        // Deserialize back
        let deserialized: ReportEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.payload.cluster, "test-cluster");
    }

    #[test]
    fn test_report_event_type_delete() {
        let event = ReportEvent {
            event_type: ReportEventType::Delete,
            payload: ReportPayload {
                cluster: "c".to_string(),
                report_type: "sbomreport".to_string(),
                namespace: "ns".to_string(),
                name: "n".to_string(),
                data_json: "{}".to_string(),
                received_at: chrono::Utc::now(),
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains("Delete"));
    }

    #[test]
    fn test_vulnerability_report_resource_trait() {
        assert_eq!(VulnerabilityReport::kind(&()), "VulnerabilityReport");
        assert_eq!(VulnerabilityReport::group(&()), "aquasecurity.github.io");
        assert_eq!(VulnerabilityReport::version(&()), "v1alpha1");
        assert_eq!(VulnerabilityReport::plural(&()), "vulnerabilityreports");
    }

    #[test]
    fn test_sbom_report_resource_trait() {
        assert_eq!(SbomReport::kind(&()), "SbomReport");
        assert_eq!(SbomReport::group(&()), "aquasecurity.github.io");
        assert_eq!(SbomReport::version(&()), "v1alpha1");
        assert_eq!(SbomReport::plural(&()), "sbomreports");
    }

    #[test]
    fn test_vulnerability_summary_default() {
        let summary = VulnerabilitySummary::default();
        assert_eq!(summary.critical_count, 0);
        assert_eq!(summary.high_count, 0);
        assert_eq!(summary.medium_count, 0);
    }

    #[test]
    fn test_sbom_summary_default() {
        let summary = SbomSummary::default();
        assert_eq!(summary.components_count, 0);
    }

    #[test]
    fn test_artifact_default() {
        let artifact = Artifact::default();
        assert!(artifact.repository.is_empty());
        assert!(artifact.tag.is_empty());
    }

    #[test]
    fn test_vulnerability_report_data_default() {
        let data = VulnerabilityReportData::default();
        assert!(data.vulnerabilities.is_empty());
    }

    #[test]
    fn test_sbom_report_data_default() {
        let data = SbomReportData::default();
        assert!(data.artifact.repository.is_empty());
    }

    #[test]
    fn test_report_payload_display() {
        let payload = ReportPayload {
            cluster: "prod".to_string(),
            report_type: "vulnerabilityreport".to_string(),
            namespace: "app".to_string(),
            name: "scan-1".to_string(),
            data_json: r#"{"report":{}}"#.to_string(),
            received_at: chrono::Utc::now(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["cluster"], "prod");
        assert_eq!(json["report_type"], "vulnerabilityreport");
    }
}
