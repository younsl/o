//! EKSUpgrade CRD type definition.

use chrono::{DateTime, Utc};
use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// EKSUpgrade spec defines the desired state of an EKS cluster upgrade.
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

fn default_cp_timeout() -> u64 {
    30
}
fn default_ng_timeout() -> u64 {
    60
}

/// Phase of the upgrade process.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub enum UpgradePhase {
    Pending,
    Planning,
    PreflightChecking,
    UpgradingControlPlane,
    UpgradingAddons,
    UpgradingNodeGroups,
    Completed,
    Failed,
}

impl std::fmt::Display for UpgradePhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            UpgradePhase::Pending => write!(f, "Pending"),
            UpgradePhase::Planning => write!(f, "Planning"),
            UpgradePhase::PreflightChecking => write!(f, "PreflightChecking"),
            UpgradePhase::UpgradingControlPlane => write!(f, "UpgradingControlPlane"),
            UpgradePhase::UpgradingAddons => write!(f, "UpgradingAddons"),
            UpgradePhase::UpgradingNodeGroups => write!(f, "UpgradingNodeGroups"),
            UpgradePhase::Completed => write!(f, "Completed"),
            UpgradePhase::Failed => write!(f, "Failed"),
        }
    }
}

/// Status of a component upgrade.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub enum ComponentStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Skipped,
}

// ============================================================================
// Phase-specific status structs
// ============================================================================

/// Planning phase status.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanningStatus {
    /// Planned upgrade path (e.g., ["1.33", "1.34"]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub upgrade_path: Vec<String>,
}

/// Result of a single preflight check.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreflightCheckStatus {
    /// Name of the preflight check.
    pub name: String,
    /// Result: Pass, Fail, or Skip.
    pub status: String,
    /// Human-readable summary of the check result.
    pub message: String,
}

/// Preflight checking phase status.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PreflightStatus {
    /// Results of preflight checks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<PreflightCheckStatus>,
}

/// Control plane upgrade phase status.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ControlPlaneStatus {
    /// Current step number (1-based) in the upgrade path.
    #[serde(default)]
    pub current_step: u32,

    /// Total number of upgrade steps.
    #[serde(default)]
    pub total_steps: u32,

    /// Target version of the current upgrade step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,

    /// Active AWS update ID for crash recovery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_id: Option<String>,

    /// Timestamp when the current upgrade step was initiated. Used for timeout enforcement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,

    /// Timestamp when all control plane upgrade steps completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

/// Status of an individual addon upgrade.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AddonStatus {
    pub name: String,
    pub current_version: String,
    pub target_version: String,
    pub status: ComponentStatus,
    /// Timestamp when this add-on upgrade was initiated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    /// Timestamp when this add-on upgrade completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

/// Status of an individual node group upgrade.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodegroupStatus {
    pub name: String,
    pub current_version: String,
    pub target_version: String,
    pub status: ComponentStatus,
    /// Active AWS update ID for this node group (for crash recovery).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_id: Option<String>,
    /// Timestamp when this node group upgrade was initiated. Used for timeout enforcement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,

    /// Timestamp when this node group upgrade completed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,
}

/// Per-phase status container.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PhaseStatuses {
    /// Planning phase details.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<PlanningStatus>,

    /// Preflight checking phase details.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preflight: Option<PreflightStatus>,

    /// Control plane upgrade phase details.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_plane: Option<ControlPlaneStatus>,

    /// Addon upgrade statuses.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub addons: Vec<AddonStatus>,

    /// Node group upgrade statuses.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodegroups: Vec<NodegroupStatus>,
}

// ============================================================================
// Top-level status
// ============================================================================

/// Condition on the EKSUpgrade resource.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeCondition {
    pub r#type: String,
    pub status: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub last_transition_time: DateTime<Utc>,
}

/// AWS caller identity resolved via STS GetCallerIdentity.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AwsIdentity {
    /// AWS account ID.
    pub account_id: String,
    /// IAM ARN used for API calls.
    pub arn: String,
}

/// EKSUpgrade status defines the observed state of the upgrade.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EKSUpgradeStatus {
    /// Current phase of the upgrade process.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<UpgradePhase>,

    /// Current Kubernetes version of the cluster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,

    /// Per-phase status details.
    #[serde(default)]
    pub phases: PhaseStatuses,

    /// Conditions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditions: Vec<UpgradeCondition>,

    /// Timestamp when the upgrade started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,

    /// Last observed generation of the spec.
    #[serde(default)]
    pub observed_generation: i64,

    /// Error message if the upgrade failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,

    /// Timestamp when the upgrade completed (Completed or Failed).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<DateTime<Utc>>,

    /// AWS caller identity used for API calls (from STS GetCallerIdentity).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<AwsIdentity>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_upgrade_phase_display() {
        assert_eq!(UpgradePhase::Pending.to_string(), "Pending");
        assert_eq!(
            UpgradePhase::UpgradingControlPlane.to_string(),
            "UpgradingControlPlane"
        );
        assert_eq!(UpgradePhase::Completed.to_string(), "Completed");
        assert_eq!(UpgradePhase::Failed.to_string(), "Failed");
    }

    #[test]
    fn test_default_timeouts() {
        assert_eq!(default_cp_timeout(), 30);
        assert_eq!(default_ng_timeout(), 60);
    }

    #[test]
    fn test_status_default() {
        let status = EKSUpgradeStatus::default();
        assert!(status.phase.is_none());
        assert!(status.current_version.is_none());
        assert!(status.phases.planning.is_none());
        assert!(status.phases.preflight.is_none());
        assert!(status.phases.control_plane.is_none());
        assert!(status.phases.addons.is_empty());
        assert!(status.phases.nodegroups.is_empty());
        assert!(status.conditions.is_empty());
    }

    #[test]
    fn test_component_status_equality() {
        assert_eq!(ComponentStatus::Pending, ComponentStatus::Pending);
        assert_eq!(ComponentStatus::InProgress, ComponentStatus::InProgress);
        assert_eq!(ComponentStatus::Completed, ComponentStatus::Completed);
        assert_eq!(ComponentStatus::Failed, ComponentStatus::Failed);
        assert_eq!(ComponentStatus::Skipped, ComponentStatus::Skipped);
        assert_ne!(ComponentStatus::Pending, ComponentStatus::Completed);
    }

    #[test]
    fn test_component_status_all_variants() {
        let variants = [
            ComponentStatus::Pending,
            ComponentStatus::InProgress,
            ComponentStatus::Completed,
            ComponentStatus::Failed,
            ComponentStatus::Skipped,
        ];
        assert_eq!(variants.len(), 5);
    }

    #[test]
    fn test_phase_statuses_default() {
        let ps = PhaseStatuses::default();
        assert!(ps.planning.is_none());
        assert!(ps.preflight.is_none());
        assert!(ps.control_plane.is_none());
        assert!(ps.addons.is_empty());
        assert!(ps.nodegroups.is_empty());
    }

    #[test]
    fn test_upgrade_condition_fields() {
        let now = chrono::Utc::now();
        let cond = UpgradeCondition {
            r#type: "Ready".to_string(),
            status: "True".to_string(),
            reason: "UpgradeCompleted".to_string(),
            message: Some("All good".to_string()),
            last_transition_time: now,
        };
        assert_eq!(cond.r#type, "Ready");
        assert_eq!(cond.status, "True");
        assert_eq!(cond.reason, "UpgradeCompleted");
        assert_eq!(cond.message.as_deref(), Some("All good"));
        assert_eq!(cond.last_transition_time, now);
    }

    #[test]
    fn test_aws_identity_fields() {
        let identity = AwsIdentity {
            account_id: "123456789012".to_string(),
            arn: "arn:aws:iam::123456789012:role/kuo-role".to_string(),
        };
        assert_eq!(identity.account_id, "123456789012");
        assert!(identity.arn.contains("kuo-role"));
    }

    #[test]
    fn test_timeout_config_serde_defaults() {
        let json = r#"{}"#;
        let config: TimeoutConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.control_plane_minutes, 30);
        assert_eq!(config.nodegroup_minutes, 60);
    }

    #[test]
    fn test_status_serialization_roundtrip() {
        let status = EKSUpgradeStatus {
            phase: Some(UpgradePhase::Planning),
            current_version: Some("1.32".to_string()),
            ..Default::default()
        };
        let json = serde_json::to_string(&status).unwrap();
        let deserialized: EKSUpgradeStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.phase, Some(UpgradePhase::Planning));
        assert_eq!(deserialized.current_version.as_deref(), Some("1.32"));
    }

    #[test]
    fn test_upgrade_phase_all_variants() {
        let variants = [
            UpgradePhase::Pending,
            UpgradePhase::Planning,
            UpgradePhase::PreflightChecking,
            UpgradePhase::UpgradingControlPlane,
            UpgradePhase::UpgradingAddons,
            UpgradePhase::UpgradingNodeGroups,
            UpgradePhase::Completed,
            UpgradePhase::Failed,
        ];
        let displays: Vec<String> = variants.iter().map(|v| v.to_string()).collect();
        assert_eq!(displays.len(), 8);
        assert!(displays.contains(&"Pending".to_string()));
        assert!(displays.contains(&"Planning".to_string()));
        assert!(displays.contains(&"PreflightChecking".to_string()));
        assert!(displays.contains(&"UpgradingControlPlane".to_string()));
        assert!(displays.contains(&"UpgradingAddons".to_string()));
        assert!(displays.contains(&"UpgradingNodeGroups".to_string()));
        assert!(displays.contains(&"Completed".to_string()));
        assert!(displays.contains(&"Failed".to_string()));
    }
}
