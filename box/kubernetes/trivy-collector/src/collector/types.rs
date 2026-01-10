use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::api::TypeMeta;
use kube::Resource;
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
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReportPayload {
    pub cluster: String,
    pub report_type: String,
    pub namespace: String,
    pub name: String,
    pub data: serde_json::Value,
    pub received_at: chrono::DateTime<chrono::Utc>,
}

/// Report event type
#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum ReportEventType {
    Apply,
    Delete,
}

/// Report event sent from collector to server
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReportEvent {
    pub event_type: ReportEventType,
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
