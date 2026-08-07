//! Status patch helpers, condition builders, and event recording.

use anyhow::Result;
use chrono::Utc;
use k8s_openapi::api::core::v1::ObjectReference;
use kube::Api;
use kube::Resource;
use kube::api::{Patch, PatchParams};
use kube::runtime::events::{Event, EventType, Recorder, Reporter};
use tracing::debug;

use crate::crd::{ComponentStatus, EKSUpgrade, EKSUpgradeStatus, UpgradeCondition, UpgradePhase};

/// Patch the status subresource of an `EKSUpgrade`.
pub async fn patch_status(
    api: &Api<EKSUpgrade>,
    name: &str,
    status: &EKSUpgradeStatus,
) -> Result<EKSUpgrade> {
    debug!("Patching status for {}: phase={:?}", name, status.phase);

    let patch = serde_json::json!({ "status": status });
    let result = api
        .patch_status(name, &PatchParams::apply("kuo"), &Patch::Merge(&patch))
        .await?;
    Ok(result)
}

/// Set the phase on a status, preserving other fields.
pub fn set_phase(status: &mut EKSUpgradeStatus, phase: UpgradePhase) {
    if phase == UpgradePhase::Completed {
        status.completed_at = Some(Utc::now());
    }
    status.phase = Some(phase);
}

/// Compute overall upgrade progress as `completed/total` component units.
///
/// Units are control plane minor steps, planned add-ons, planned node groups,
/// and Karpenter `NodePools`, mirroring a Pod's `Ready` column. Add-ons, node
/// groups, and Karpenter `NodePools` count as done once `Completed` or
/// `Skipped`; control plane counts completed minor steps (`current_step - 1`
/// while running, all steps once `completedAt` is set).
/// Returns `None` when no plan exists yet, and forces `total/total` once the
/// upgrade has reached `Completed`.
pub fn compute_progress(status: &EKSUpgradeStatus) -> Option<String> {
    let cp = status.phases.control_plane.as_ref();
    let cp_total = cp.map_or(0, |c| c.total_steps);
    let addons = &status.phases.addons;
    let nodegroups = &status.phases.nodegroups;
    let karpenter = status.phases.karpenter_node_pools.as_ref();
    // Karpenter counts one unit per NodePool, matching how each node group
    // counts as one regardless of node count. Per-node progress lives in the
    // dedicated karpenterNodePools substatus, not this top-level ratio.
    let kp_total = karpenter.map_or(0, |k| k.pools.len());

    let total = cp_total as usize + addons.len() + nodegroups.len() + kp_total;
    if total == 0 {
        return None;
    }

    if status.phase == Some(UpgradePhase::Completed) {
        return Some(format!("{total}/{total}"));
    }

    let cp_done = cp.map_or(0, |c| {
        if c.completed_at.is_some() {
            c.total_steps
        } else {
            c.current_step.saturating_sub(1)
        }
    }) as usize;

    let is_done =
        |s: &ComponentStatus| matches!(s, ComponentStatus::Completed | ComponentStatus::Skipped);
    let addons_done = addons.iter().filter(|a| is_done(&a.status)).count();
    let ng_done = nodegroups.iter().filter(|n| is_done(&n.status)).count();
    let kp_done = karpenter.map_or(0, |k| k.pools.iter().filter(|p| is_done(&p.status)).count());

    let done = cp_done + addons_done + ng_done + kp_done;
    Some(format!("{done}/{total}"))
}

/// Set the phase to Failed with a message.
pub fn set_failed(status: &mut EKSUpgradeStatus, message: impl Into<String>) {
    status.phase = Some(UpgradePhase::Failed);
    status.completed_at = Some(Utc::now());
    status.message = Some(message.into());
    set_condition(
        status,
        "Ready",
        "False",
        "UpgradeFailed",
        status.message.clone(),
    );
}

/// Set a condition on the status.
pub fn set_condition(
    status: &mut EKSUpgradeStatus,
    condition_type: &str,
    condition_status: &str,
    reason: &str,
    message: Option<String>,
) {
    let now = Utc::now();

    // Remove existing condition of same type
    status.conditions.retain(|c| c.r#type != condition_type);

    status.conditions.push(UpgradeCondition {
        r#type: condition_type.to_string(),
        status: condition_status.to_string(),
        reason: reason.to_string(),
        message,
        last_transition_time: now,
    });
}

/// Event recorder bundled with its target `ObjectReference`.
pub struct EventRecorder {
    recorder: Recorder,
    obj_ref: ObjectReference,
}

impl EventRecorder {
    /// Create an event recorder for the given `EKSUpgrade` resource.
    pub fn new(client: kube::Client, obj: &EKSUpgrade) -> Self {
        let reporter = Reporter {
            controller: "kuo".into(),
            instance: None,
        };
        Self {
            recorder: Recorder::new(client, reporter),
            obj_ref: obj.object_ref(&()),
        }
    }

    /// Publish a Normal event.
    pub async fn publish(&self, reason: &str, message: &str) {
        self.recorder
            .publish(
                &Event {
                    type_: EventType::Normal,
                    reason: reason.into(),
                    note: Some(message.into()),
                    action: reason.into(),
                    secondary: None,
                },
                &self.obj_ref,
            )
            .await
            .unwrap_or_else(|e| tracing::warn!("Failed to publish event: {}", e));
    }

    /// Publish a Warning event.
    pub async fn publish_warning(&self, reason: &str, message: &str) {
        self.recorder
            .publish(
                &Event {
                    type_: EventType::Warning,
                    reason: reason.into(),
                    note: Some(message.into()),
                    action: reason.into(),
                    secondary: None,
                },
                &self.obj_ref,
            )
            .await
            .unwrap_or_else(|e| tracing::warn!("Failed to publish warning event: {}", e));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::EKSUpgradeStatus;

    use crate::crd::{
        AddonStatus, ControlPlaneStatus, KarpenterNodePoolsStatus, KarpenterPoolStatus,
        NodegroupStatus,
    };

    fn karpenter_pool(status: ComponentStatus) -> KarpenterPoolStatus {
        KarpenterPoolStatus {
            name: "default".to_string(),
            status,
            total_nodes: 3,
            replaced_nodes: 0,
            completed_node_claims: vec![],
            replacements: vec![],
            current_batch: vec![],
        }
    }

    fn addon(status: ComponentStatus) -> AddonStatus {
        AddonStatus {
            name: "coredns".to_string(),
            current_version: "v1.11.3".to_string(),
            target_version: "v1.11.1".to_string(),
            status,
            started_at: None,
            completed_at: None,
        }
    }

    fn nodegroup(status: ComponentStatus) -> NodegroupStatus {
        NodegroupStatus {
            name: "ng-1".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.32".to_string(),
            status,
            update_id: None,
            started_at: None,
            completed_at: None,
        }
    }

    #[test]
    fn test_compute_progress_none_without_plan() {
        assert_eq!(compute_progress(&EKSUpgradeStatus::default()), None);
    }

    #[test]
    fn test_compute_progress_mixed() {
        // 2 CP steps + 2 addons + 1 nodegroup = 5 units.
        let mut s = EKSUpgradeStatus::default();
        s.phases.control_plane = Some(ControlPlaneStatus {
            current_step: 2, // step 1 done, step 2 in progress -> 1 done
            total_steps: 2,
            ..Default::default()
        });
        s.phases.addons = vec![
            addon(ComponentStatus::Completed),
            addon(ComponentStatus::Pending),
        ];
        s.phases.nodegroups = vec![nodegroup(ComponentStatus::Skipped)];
        // cp_done 1 + addon 1 + ng 1 = 3 of 5
        assert_eq!(compute_progress(&s), Some("3/5".to_string()));
    }

    #[test]
    fn test_compute_progress_counts_karpenter_pools_per_pool() {
        // 1 CP step (in progress, 0 done) + 2 Karpenter NodePools = 3 units.
        let mut s = EKSUpgradeStatus::default();
        s.phases.control_plane = Some(ControlPlaneStatus {
            current_step: 1,
            total_steps: 1,
            ..Default::default()
        });
        s.phases.karpenter_node_pools = Some(KarpenterNodePoolsStatus {
            strategy: "Replace".to_string(),
            active_pool: Some("spot".to_string()),
            total_nodes: 8,
            replaced_nodes: 5,
            pools: vec![
                karpenter_pool(ComponentStatus::Completed),
                karpenter_pool(ComponentStatus::InProgress),
            ],
        });
        // cp_done 0 + kp_done 1 (one Completed pool) of total 3.
        // Mid-replacement node counts (5/8) do NOT affect the top-level ratio.
        assert_eq!(compute_progress(&s), Some("1/3".to_string()));
    }

    #[test]
    fn test_compute_progress_control_plane_completed() {
        let mut s = EKSUpgradeStatus::default();
        s.phases.control_plane = Some(ControlPlaneStatus {
            current_step: 2,
            total_steps: 2,
            completed_at: Some(Utc::now()),
            ..Default::default()
        });
        // completedAt set -> all 2 CP steps done, no other units
        assert_eq!(compute_progress(&s), Some("2/2".to_string()));
    }

    #[test]
    fn test_compute_progress_forces_full_on_completed() {
        let s = EKSUpgradeStatus {
            phase: Some(UpgradePhase::Completed),
            ..Default::default()
        };
        let mut s = s;
        s.phases.control_plane = Some(ControlPlaneStatus {
            current_step: 1,
            total_steps: 3,
            ..Default::default()
        });
        s.phases.addons = vec![addon(ComponentStatus::Pending)];
        // total = 3 + 1 = 4, forced to 4/4 at Completed
        assert_eq!(compute_progress(&s), Some("4/4".to_string()));
    }

    #[test]
    fn test_set_phase_completed() {
        let mut status = EKSUpgradeStatus::default();
        set_phase(&mut status, UpgradePhase::Completed);
        assert_eq!(status.phase, Some(UpgradePhase::Completed));
        assert!(status.completed_at.is_some());
    }

    #[test]
    fn test_set_phase_non_terminal() {
        let mut status = EKSUpgradeStatus::default();
        set_phase(&mut status, UpgradePhase::UpgradingControlPlane);
        assert_eq!(status.phase, Some(UpgradePhase::UpgradingControlPlane));
        assert!(status.completed_at.is_none());
    }

    #[test]
    fn test_set_failed() {
        let mut status = EKSUpgradeStatus::default();
        set_failed(&mut status, "something broke");
        assert_eq!(status.phase, Some(UpgradePhase::Failed));
        assert!(status.completed_at.is_some());
        assert_eq!(status.message.as_deref(), Some("something broke"));
    }

    #[test]
    fn test_set_failed_message_in_condition() {
        let mut status = EKSUpgradeStatus::default();
        set_failed(&mut status, "timeout exceeded");
        let cond = status
            .conditions
            .iter()
            .find(|c| c.r#type == "Ready")
            .unwrap();
        assert_eq!(cond.message.as_deref(), Some("timeout exceeded"));
        assert_eq!(cond.status, "False");
        assert_eq!(cond.reason, "UpgradeFailed");
    }

    #[test]
    fn test_set_condition_adds_new() {
        let mut status = EKSUpgradeStatus::default();
        assert!(status.conditions.is_empty());
        set_condition(&mut status, "Ready", "True", "AllGood", None);
        assert_eq!(status.conditions.len(), 1);
        assert_eq!(status.conditions[0].r#type, "Ready");
    }

    #[test]
    fn test_set_condition_replaces_existing() {
        let mut status = EKSUpgradeStatus::default();
        set_condition(&mut status, "Ready", "False", "NotReady", None);
        set_condition(
            &mut status,
            "Ready",
            "True",
            "NowReady",
            Some("ok".to_string()),
        );
        assert_eq!(status.conditions.len(), 1);
        assert_eq!(status.conditions[0].status, "True");
        assert_eq!(status.conditions[0].reason, "NowReady");
    }

    #[test]
    fn test_set_condition_preserves_other_types() {
        let mut status = EKSUpgradeStatus::default();
        set_condition(&mut status, "AWSAuthenticated", "True", "Auth", None);
        set_condition(&mut status, "Ready", "True", "Ok", None);
        assert_eq!(status.conditions.len(), 2);
        assert!(
            status
                .conditions
                .iter()
                .any(|c| c.r#type == "AWSAuthenticated")
        );
        assert!(status.conditions.iter().any(|c| c.r#type == "Ready"));
    }

    #[test]
    fn test_set_failed_then_set_condition_overwrites() {
        let mut status = EKSUpgradeStatus::default();
        set_failed(&mut status, "first error");
        assert_eq!(status.conditions.len(), 1);
        set_condition(&mut status, "Ready", "True", "Fixed", None);
        assert_eq!(status.conditions.len(), 1);
        assert_eq!(status.conditions[0].status, "True");
    }

    #[test]
    fn test_set_phase_planning() {
        let mut status = EKSUpgradeStatus::default();
        set_phase(&mut status, UpgradePhase::Planning);
        assert_eq!(status.phase, Some(UpgradePhase::Planning));
        assert!(status.completed_at.is_none());
    }

    #[test]
    fn test_set_phase_failed_does_not_set_completed_at() {
        let mut status = EKSUpgradeStatus::default();
        set_phase(&mut status, UpgradePhase::Failed);
        // set_phase only sets completed_at for Completed, not Failed
        assert!(status.completed_at.is_none());
        assert_eq!(status.phase, Some(UpgradePhase::Failed));
    }

    #[test]
    fn test_set_condition_fields() {
        let mut status = EKSUpgradeStatus::default();
        set_condition(
            &mut status,
            "Ready",
            "True",
            "Complete",
            Some("done".to_string()),
        );
        let cond = &status.conditions[0];
        assert_eq!(cond.r#type, "Ready");
        assert_eq!(cond.status, "True");
        assert_eq!(cond.reason, "Complete");
        assert_eq!(cond.message.as_deref(), Some("done"));
        // last_transition_time should be recent (within last second)
        let elapsed = Utc::now().signed_duration_since(cond.last_transition_time);
        assert!(elapsed.num_seconds() < 2);
    }
}
