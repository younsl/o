//! `EKSUpgrade` status types.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::spec::UpgradeMode;
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

/// One `NodeClaim` currently being replaced within a `NodePool`.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CurrentBatchEntry {
    /// Name of the `NodeClaim` being replaced.
    pub node_claim: String,
    /// Name of the backing Node resource, if already registered. Recorded
    /// alongside the `NodeClaim` so operators can cross-reference `kubectl get
    /// nodes` without an extra lookup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_name: Option<String>,
    /// Provider ID (e.g. `aws:///<az>/<instance-id>`) for AWS-side correlation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Replacement stage: `Draining` or `WaitingControllerStable`.
    pub state: String,
    /// Timestamp when this `NodeClaim`'s replacement started. Used for timeout enforcement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    /// Owning controllers of the pods evicted from this node, captured before
    /// deletion, encoded as `kind|namespace|name`. Persisted so a restart
    /// mid-replacement can still wait for the right controllers to recover.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub controllers: Vec<String>,
}

/// A completed node replacement, mapping the removed `NodeClaim` to the one
/// Karpenter provisioned in its place.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NodeClaimReplacement {
    /// Name of the removed (old) `NodeClaim`.
    pub old_node_claim: String,
    /// Name of the newly provisioned `NodeClaim`, if it could be identified.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_node_claim: Option<String>,
    /// Name of the old backing Node, for cross-reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_name: Option<String>,
}

/// Replacement status of a single Karpenter `NodePool`.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KarpenterPoolStatus {
    /// `NodePool` name.
    pub name: String,
    /// Overall status of this `NodePool`'s replacement.
    pub status: ComponentStatus,
    /// Total stale nodes detected in this `NodePool` at planning time.
    #[serde(default)]
    pub total_nodes: u32,
    /// Nodes replaced so far in this `NodePool`.
    #[serde(default)]
    pub replaced_nodes: u32,
    /// `NodeClaims` already replaced (crash-recovery record). Most recent entries
    /// are retained; the list is not an unbounded history.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub completed_node_claims: Vec<String>,
    /// Completed replacements mapping each removed `NodeClaim` to the new one.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replacements: Vec<NodeClaimReplacement>,
    /// `NodeClaims` currently in flight this batch.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub current_batch: Vec<CurrentBatchEntry>,
}

/// Karpenter `NodePool` replacement phase status.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KarpenterNodePoolsStatus {
    /// Strategy in effect (e.g. `Replace`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub strategy: String,
    /// `NodePool` currently being processed.
    /// NOTE: No `skip_serializing_if` — None must serialize as `null` so that
    /// JSON Merge Patch (RFC 7396) clears the field when work moves on.
    #[serde(default)]
    pub active_pool: Option<String>,
    /// Total stale nodes across all target `NodePools`.
    #[serde(default)]
    pub total_nodes: u32,
    /// Nodes replaced so far across all target `NodePools`.
    #[serde(default)]
    pub replaced_nodes: u32,
    /// Per-NodePool replacement statuses.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pools: Vec<KarpenterPoolStatus>,
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

    /// Karpenter `NodePool` replacement status.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub karpenter_node_pools: Option<KarpenterNodePoolsStatus>,
}

// ============================================================================
// Lifecycle status (EKS version support dates)
// ============================================================================

/// Lifecycle information for a single EKS version.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VersionLifecycleInfo {
    /// Kubernetes version (e.g., "1.32").
    pub version: String,
    /// Version status (e.g., "standard-support", "extended-support").
    pub version_status: String,
    /// End of standard support date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_of_standard_support_date: Option<DateTime<Utc>>,
    /// End of extended support date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_of_extended_support_date: Option<DateTime<Utc>>,
}

/// Lifecycle status for current and target EKS versions.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleStatus {
    /// Timestamp when lifecycle info was last fetched from the `DescribeClusterVersions` API.
    pub last_checked_time: DateTime<Utc>,
    /// Lifecycle info for the current cluster version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_version: Option<VersionLifecycleInfo>,
    /// Lifecycle info for the target upgrade version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_version: Option<VersionLifecycleInfo>,
    /// Error message if lifecycle info could not be fetched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
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

    /// Overall progress as `completed/total` component units (control plane
    /// minor steps + add-ons + node groups), analogous to a Pod's Ready column.
    /// `None` until a plan exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<String>,

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

    /// EKS version lifecycle information (support end dates).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<LifecycleStatus>,

    /// The last transition (upgrade or rollback) that reached `Completed`.
    ///
    /// Recorded when the flow completes and deliberately preserved across
    /// spec-change resets (see `reset_status_patch`), because the live
    /// `current_version` alone cannot tell whether the cluster arrived at its
    /// current minor via a forward upgrade or a rollback. It is the only signal
    /// available to reject a consecutive rollback: EKS permits rolling back only
    /// to a version the cluster was recently upgraded from, so a second rollback
    /// in a row (e.g. 1.36 -> 1.35 then 1.35 -> 1.34) has no eligible target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_transition: Option<TransitionRecord>,
}

/// A record of the most recent completed upgrade or rollback.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransitionRecord {
    /// Direction of the completed transition.
    pub mode: UpgradeMode,

    /// Cluster version the transition settled on.
    pub to_version: String,

    /// Timestamp when the transition completed.
    pub completed_at: DateTime<Utc>,
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

    #[test]
    fn test_lifecycle_status_serialization() {
        let now = chrono::Utc::now();
        let lifecycle = LifecycleStatus {
            last_checked_time: now,
            current_version: Some(VersionLifecycleInfo {
                version: "1.32".to_string(),
                version_status: "standard-support".to_string(),
                end_of_standard_support_date: Some(
                    "2026-03-23T00:00:00Z".parse::<DateTime<Utc>>().unwrap(),
                ),
                end_of_extended_support_date: Some(
                    "2027-03-23T00:00:00Z".parse::<DateTime<Utc>>().unwrap(),
                ),
            }),
            target_version: Some(VersionLifecycleInfo {
                version: "1.34".to_string(),
                version_status: "standard-support".to_string(),
                end_of_standard_support_date: Some(
                    "2026-12-02T00:00:00Z".parse::<DateTime<Utc>>().unwrap(),
                ),
                end_of_extended_support_date: Some(
                    "2027-12-02T00:00:00Z".parse::<DateTime<Utc>>().unwrap(),
                ),
            }),
            error: None,
        };
        let json = serde_json::to_value(&lifecycle).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("lastCheckedTime"));
        assert!(obj.contains_key("currentVersion"));
        assert!(obj.contains_key("targetVersion"));
        assert!(
            !obj.contains_key("error"),
            "error should be skipped when None"
        );

        let current = &json["currentVersion"];
        assert_eq!(current["version"], "1.32");
        assert_eq!(current["versionStatus"], "standard-support");
    }

    #[test]
    fn test_lifecycle_status_error_only() {
        let now = chrono::Utc::now();
        let lifecycle = LifecycleStatus {
            last_checked_time: now,
            current_version: None,
            target_version: None,
            error: Some("AccessDeniedException".to_string()),
        };
        let json = serde_json::to_value(&lifecycle).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("lastCheckedTime"));
        assert!(!obj.contains_key("currentVersion"));
        assert!(!obj.contains_key("targetVersion"));
        assert_eq!(json["error"], "AccessDeniedException");
    }

    #[test]
    fn test_lifecycle_status_roundtrip() {
        let now = chrono::Utc::now();
        let lifecycle = LifecycleStatus {
            last_checked_time: now,
            current_version: Some(VersionLifecycleInfo {
                version: "1.32".to_string(),
                version_status: "standard-support".to_string(),
                end_of_standard_support_date: None,
                end_of_extended_support_date: None,
            }),
            target_version: None,
            error: None,
        };
        let json = serde_json::to_string(&lifecycle).unwrap();
        let deserialized: LifecycleStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.last_checked_time, now);
        assert!(deserialized.current_version.is_some());
        assert!(deserialized.target_version.is_none());
        assert!(deserialized.error.is_none());
    }

    #[test]
    fn test_status_with_lifecycle_field() {
        let now = chrono::Utc::now();
        let status = EKSUpgradeStatus {
            lifecycle: Some(LifecycleStatus {
                last_checked_time: now,
                current_version: None,
                target_version: None,
                error: Some("test error".to_string()),
            }),
            ..Default::default()
        };
        let json = serde_json::to_value(&status).unwrap();
        assert!(json["lifecycle"]["error"] == "test error");
        assert!(json["lifecycle"]["lastCheckedTime"].is_string());
    }

    /// Regression test: `ControlPlaneStatus` fields that are cleared to `None` during
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

    /// Regression test: `NodegroupStatus` fields cleared on completion must
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

    #[test]
    fn test_karpenter_status_default_and_field() {
        let ps = PhaseStatuses::default();
        assert!(ps.karpenter_node_pools.is_none());

        let kp = KarpenterNodePoolsStatus {
            strategy: "Replace".to_string(),
            active_pool: Some("spot".to_string()),
            total_nodes: 8,
            replaced_nodes: 3,
            pools: vec![KarpenterPoolStatus {
                name: "default".to_string(),
                status: ComponentStatus::Completed,
                total_nodes: 5,
                replaced_nodes: 5,
                completed_node_claims: vec!["default-abc".to_string()],
                replacements: vec![],
                current_batch: vec![],
            }],
        };
        let json = serde_json::to_value(&kp).unwrap();
        assert_eq!(json["strategy"], "Replace");
        assert_eq!(json["activePool"], "spot");
        assert_eq!(json["pools"][0]["name"], "default");
        assert_eq!(json["pools"][0]["completedNodeClaims"][0], "default-abc");
    }

    /// `active_pool` must serialize as null (not be omitted) when cleared, so a
    /// JSON Merge Patch removes the stale value once processing moves on.
    #[test]
    fn test_karpenter_active_pool_serializes_as_null() {
        let kp = KarpenterNodePoolsStatus {
            strategy: "Replace".to_string(),
            active_pool: None,
            total_nodes: 0,
            replaced_nodes: 0,
            pools: vec![],
        };
        let json = serde_json::to_value(&kp).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("activePool"), "activePool must be present");
        assert!(obj["activePool"].is_null(), "activePool must be null");
    }

    #[test]
    fn test_current_batch_entry_omits_optional_when_none() {
        let entry = CurrentBatchEntry {
            node_claim: "spot-ghi56".to_string(),
            node_name: None,
            provider_id: None,
            state: "Draining".to_string(),
            started_at: None,
            controllers: vec![],
        };
        let json = serde_json::to_value(&entry).unwrap();
        let obj = json.as_object().unwrap();
        assert_eq!(obj["nodeClaim"], "spot-ghi56");
        assert_eq!(obj["state"], "Draining");
        assert!(!obj.contains_key("nodeName"));
        assert!(!obj.contains_key("providerId"));
        assert!(!obj.contains_key("controllers"));
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
    /// After step 1/2 (1.32→1.33) completes, the operator sets `update_id` = `None`
    /// and `current_step` = 2. When this is applied as a JSON Merge Patch, the
    /// stale `update_id` MUST be removed. Otherwise, step 2/2 polls the old
    /// `update_id` (which returns "Successful" for the already-completed step 1),
    /// causing the operator to skip the actual 1.33→1.34 upgrade and jump
    /// directly to `UpgradingAddons`.
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
