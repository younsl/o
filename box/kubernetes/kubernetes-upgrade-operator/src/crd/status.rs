//! `EKSUpgrade` status types.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::types::{ComponentStatus, UpgradePhase};

// ============================================================================
// Phase-specific status structs
// ============================================================================

/// Planning phase status.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PlanningStatus {
    /// Planned upgrade path (e.g., `["1.33", "1.34"]`).
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
    /// NOTE: No `skip_serializing_if` — None must serialize as `null` so that
    /// JSON Merge Patch (RFC 7396) removes the field from the CRD status.
    #[serde(default)]
    pub target: Option<String>,

    /// Active AWS update ID for crash recovery.
    /// NOTE: No `skip_serializing_if` — same reason as `target`.
    #[serde(default)]
    pub update_id: Option<String>,

    /// Timestamp when the current upgrade step was initiated. Used for timeout enforcement.
    /// NOTE: No `skip_serializing_if` — same reason as `target`.
    #[serde(default)]
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
    /// NOTE: No `skip_serializing_if` — None must serialize as `null` so that
    /// JSON Merge Patch (RFC 7396) removes the field from the CRD status.
    #[serde(default)]
    pub update_id: Option<String>,
    /// Timestamp when this node group upgrade was initiated. Used for timeout enforcement.
    /// NOTE: No `skip_serializing_if` — same reason as `update_id`.
    #[serde(default)]
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

/// Condition on the `EKSUpgrade` resource.
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

/// AWS caller identity resolved via STS `GetCallerIdentity`.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AwsIdentity {
    /// AWS account ID.
    pub account_id: String,
    /// IAM ARN used for API calls.
    pub arn: String,
}

/// `EKSUpgrade` status defines the observed state of the upgrade.
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

    /// AWS caller identity used for API calls (from STS `GetCallerIdentity`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<AwsIdentity>,
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Regression test: ControlPlaneStatus fields that are cleared to None during
    /// step transitions MUST serialize as JSON `null` (not be omitted) so that
    /// JSON Merge Patch (RFC 7396) removes them from the CRD status.
    /// Without this, a stale `update_id` persists and causes the operator to
    /// skip control plane upgrade steps.
    #[test]
    fn test_control_plane_none_fields_serialize_as_null() {
        let cp = ControlPlaneStatus {
            current_step: 2,
            total_steps: 2,
            target: None,
            update_id: None,
            started_at: None,
            completed_at: None,
        };
        let json = serde_json::to_value(&cp).unwrap();
        let obj = json.as_object().unwrap();

        // These fields MUST be present as null, not omitted.
        assert!(obj.contains_key("updateId"), "updateId must be present");
        assert!(obj["updateId"].is_null(), "updateId must be null");

        assert!(obj.contains_key("target"), "target must be present");
        assert!(obj["target"].is_null(), "target must be null");

        assert!(obj.contains_key("startedAt"), "startedAt must be present");
        assert!(obj["startedAt"].is_null(), "startedAt must be null");
    }

    /// Regression test: NodegroupStatus fields cleared on completion must
    /// serialize as null for the same Merge Patch reason.
    #[test]
    fn test_nodegroup_none_fields_serialize_as_null() {
        let ng = NodegroupStatus {
            name: "ng-system".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.34".to_string(),
            status: ComponentStatus::Completed,
            update_id: None,
            started_at: None,
            completed_at: None,
        };
        let json = serde_json::to_value(&ng).unwrap();
        let obj = json.as_object().unwrap();

        assert!(obj.contains_key("updateId"), "updateId must be present");
        assert!(obj["updateId"].is_null(), "updateId must be null");

        assert!(obj.contains_key("startedAt"), "startedAt must be present");
        assert!(obj["startedAt"].is_null(), "startedAt must be null");
    }

    /// Minimal RFC 7396 JSON Merge Patch implementation for testing.
    fn json_merge_patch(target: &mut serde_json::Value, patch: &serde_json::Value) {
        if let (Some(target_obj), Some(patch_obj)) = (target.as_object_mut(), patch.as_object()) {
            for (key, value) in patch_obj {
                if value.is_null() {
                    target_obj.remove(key);
                } else if value.is_object() {
                    let entry = target_obj
                        .entry(key.clone())
                        .or_insert(serde_json::json!({}));
                    json_merge_patch(entry, value);
                } else {
                    target_obj.insert(key.clone(), value.clone());
                }
            }
        }
    }

    /// Regression test for the two-step control plane upgrade bug.
    ///
    /// Simulates the exact scenario: upgrading from 1.32 → 1.34 (two steps).
    /// After step 1/2 (1.32→1.33) completes, the operator sets update_id = None
    /// and current_step = 2. When this is applied as a JSON Merge Patch, the
    /// stale update_id MUST be removed. Otherwise, step 2/2 polls the old
    /// update_id (which returns "Successful" for the already-completed step 1),
    /// causing the operator to skip the actual 1.33→1.34 upgrade and jump
    /// directly to UpgradingAddons.
    #[test]
    fn test_two_step_cp_upgrade_merge_patch_clears_stale_update_id() {
        // === State BEFORE step 1/2 completes ===
        // CRD status in Kubernetes has update_id from step 1.
        let mut crd_status = serde_json::json!({
            "phases": {
                "controlPlane": {
                    "currentStep": 1,
                    "totalSteps": 2,
                    "target": "1.33",
                    "updateId": "6a86aea3-7708-3eea-a4e1-c22d0c8f0a9d",
                    "startedAt": "2026-02-23T04:59:14Z"
                }
            }
        });

        // === Operator detects step 1/2 "Successful" ===
        // Builds new status: current_step = 2, clears update_id/target/started_at.
        let after_step1 = ControlPlaneStatus {
            current_step: 2,
            total_steps: 2,
            target: None,
            update_id: None,
            started_at: None,
            completed_at: None,
        };

        // Serialize exactly as patch_status() does.
        let patch = serde_json::json!({
            "phases": {
                "controlPlane": serde_json::to_value(&after_step1).unwrap()
            }
        });

        // Apply JSON Merge Patch (RFC 7396), same as Patch::Merge in kube-rs.
        json_merge_patch(&mut crd_status, &patch);

        // === Verify: stale update_id MUST be removed ===
        let cp = &crd_status["phases"]["controlPlane"];

        assert_eq!(cp["currentStep"], 2, "currentStep must advance to 2");
        assert_eq!(cp["totalSteps"], 2);

        // The critical assertions: these fields must NOT retain stale values.
        assert!(
            !cp.as_object().unwrap().contains_key("updateId"),
            "updateId must be removed by merge patch (null removes the key)"
        );
        assert!(
            !cp.as_object().unwrap().contains_key("target"),
            "target must be removed by merge patch"
        );
        assert!(
            !cp.as_object().unwrap().contains_key("startedAt"),
            "startedAt must be removed by merge patch"
        );
    }
}
