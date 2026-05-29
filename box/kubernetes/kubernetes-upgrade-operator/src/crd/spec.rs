//! `EKSUpgrade` spec types.

use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::status::EKSUpgradeStatus;

/// `EKSUpgrade` spec defines the desired state of an EKS cluster upgrade.
#[derive(CustomResource, Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[kube(
    group = "kuo.io",
    version = "v1alpha1",
    kind = "EKSUpgrade",
    status = "EKSUpgradeStatus",
    printcolumn = r#"{"name":"CLUSTER","type":"string","jsonPath":".spec.clusterName"}"#,
    printcolumn = r#"{"name":"TARGET","type":"string","jsonPath":".spec.targetVersion"}"#,
    printcolumn = r#"{"name":"PHASE","type":"string","jsonPath":".status.phase"}"#,
    printcolumn = r#"{"name":"AUTH","type":"string","jsonPath":".status.conditions[?(@.type==\"AWSAuthenticated\")].reason"}"#,
    printcolumn = r#"{"name":"AGE","type":"date","jsonPath":".metadata.creationTimestamp"}"#
)]
#[serde(rename_all = "camelCase")]
pub struct EKSUpgradeSpec {
    /// Name of the EKS cluster to upgrade.
    pub cluster_name: String,

    /// Target Kubernetes version (e.g., "1.34").
    pub target_version: String,

    /// AWS region where the cluster resides.
    pub region: String,

    /// IAM Role ARN to assume for cross-account access.
    /// Works with both IRSA and EKS Pod Identity as the base credential source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assume_role_arn: Option<String>,

    /// Optional add-on version overrides (addon name -> version).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addon_versions: Option<std::collections::HashMap<String, String>>,

    /// Skip PDB drain deadlock check before node group rolling updates.
    #[serde(default)]
    pub skip_pdb_check: bool,

    /// Plan only, do not execute.
    #[serde(default)]
    pub dry_run: bool,

    /// Timeout configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeouts: Option<TimeoutConfig>,

    /// Slack notification configuration for this upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification: Option<NotificationConfig>,
}

/// Slack notification configuration.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationConfig {
    /// Send Slack notifications for actual upgrades (dryRun: false).
    #[serde(default)]
    pub on_upgrade: bool,
    /// Send Slack notifications for dry-run executions (dryRun: true).
    #[serde(default)]
    pub on_dry_run: bool,
}

/// Timeout configuration for upgrade operations.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimeoutConfig {
    /// Control plane upgrade timeout in minutes (default: 30).
    #[serde(default = "default_cp_timeout")]
    pub control_plane_minutes: u64,

    /// Node group upgrade timeout in minutes (default: 60).
    #[serde(default = "default_ng_timeout")]
    pub nodegroup_minutes: u64,
}

const fn default_cp_timeout() -> u64 {
    30
}
const fn default_ng_timeout() -> u64 {
    60
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_timeouts() {
        assert_eq!(default_cp_timeout(), 30);
        assert_eq!(default_ng_timeout(), 60);
    }

    #[test]
    fn test_timeout_config_serde_defaults() {
        let json = r#"{}"#;
        let config: TimeoutConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.control_plane_minutes, 30);
        assert_eq!(config.nodegroup_minutes, 60);
    }
}
