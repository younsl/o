//! Central phase-transition routing.
//!
//! The concrete work each phase handler performs is identical for forward
//! upgrades and rollbacks (the same AWS APIs are called). Only the order in
//! which phases run differs:
//!
//! ```text
//! Forward:  ControlPlane -> Addons -> NodeGroups -> Completed
//! Rollback: NodeGroups   -> Addons -> ControlPlane -> Completed
//! ```
//!
//! These pure functions decide the next phase from the current status and the
//! upgrade mode, keeping the routing logic in one testable place.

use crate::crd::{EKSUpgradeStatus, TransitionRecord, UpgradeMode, UpgradePhase};
use crate::status;

/// Whether starting `mode` now would be a rollback immediately following an
/// already-completed rollback.
///
/// EKS only permits rolling back to a version the cluster was recently upgraded
/// from. Once a rollback has completed (e.g. 1.36 -> 1.35), the cluster's most
/// recent upgrade no longer targets the current minor, so a further rollback
/// (1.35 -> 1.34) has no eligible target and must be rejected. A forward
/// upgrade in between clears this state and re-enables rollback.
pub const fn is_consecutive_rollback(mode: &UpgradeMode, last: Option<&TransitionRecord>) -> bool {
    matches!(mode, UpgradeMode::Rollback)
        && matches!(last, Some(t) if matches!(t.mode, UpgradeMode::Rollback))
}

const fn has_cp_steps(status: &EKSUpgradeStatus) -> bool {
    match &status.phases.planning {
        Some(p) => !p.upgrade_path.is_empty(),
        None => false,
    }
}

const fn has_addons(status: &EKSUpgradeStatus) -> bool {
    !status.phases.addons.is_empty()
}

const fn has_nodegroups(status: &EKSUpgradeStatus) -> bool {
    !status.phases.nodegroups.is_empty()
}

/// Whether Karpenter `NodePool` replacement has planned work. Populated by the
/// planning phase only when `spec.karpenterNodePools.enabled` and stale nodes
/// exist, so an empty or absent value means the phase is skipped.
const fn has_karpenter(status: &EKSUpgradeStatus) -> bool {
    match &status.phases.karpenter_node_pools {
        Some(k) => !k.pools.is_empty(),
        None => false,
    }
}

/// Next phase after preflight checks pass.
pub const fn after_preflight(status: &EKSUpgradeStatus, mode: &UpgradeMode) -> UpgradePhase {
    match mode {
        UpgradeMode::Forward => {
            if has_cp_steps(status) {
                UpgradePhase::UpgradingControlPlane
            } else if has_addons(status) {
                UpgradePhase::UpgradingAddons
            } else if has_nodegroups(status) {
                UpgradePhase::UpgradingNodeGroups
            } else if has_karpenter(status) {
                UpgradePhase::UpgradingKarpenterNodePools
            } else {
                UpgradePhase::Completed
            }
        }
        UpgradeMode::Rollback => {
            if has_nodegroups(status) {
                UpgradePhase::RollingBackNodeGroups
            } else if has_addons(status) {
                UpgradePhase::RollingBackAddons
            } else if has_cp_steps(status) {
                UpgradePhase::RollingBackControlPlane
            } else {
                UpgradePhase::Completed
            }
        }
    }
}

/// Next phase after the control plane phase completes.
pub const fn after_control_plane(status: &EKSUpgradeStatus, mode: &UpgradeMode) -> UpgradePhase {
    match mode {
        UpgradeMode::Forward => {
            if has_addons(status) {
                UpgradePhase::UpgradingAddons
            } else if has_nodegroups(status) {
                UpgradePhase::UpgradingNodeGroups
            } else if has_karpenter(status) {
                UpgradePhase::UpgradingKarpenterNodePools
            } else {
                UpgradePhase::Completed
            }
        }
        // In rollback the control plane runs last.
        UpgradeMode::Rollback => UpgradePhase::Completed,
    }
}

/// Next phase after the add-ons phase completes.
pub const fn after_addons(status: &EKSUpgradeStatus, mode: &UpgradeMode) -> UpgradePhase {
    match mode {
        UpgradeMode::Forward => {
            if has_nodegroups(status) {
                UpgradePhase::UpgradingNodeGroups
            } else if has_karpenter(status) {
                UpgradePhase::UpgradingKarpenterNodePools
            } else {
                UpgradePhase::Completed
            }
        }
        UpgradeMode::Rollback => {
            if has_cp_steps(status) {
                UpgradePhase::RollingBackControlPlane
            } else {
                UpgradePhase::Completed
            }
        }
    }
}

/// Next phase after the node groups phase completes.
pub const fn after_nodegroups(status: &EKSUpgradeStatus, mode: &UpgradeMode) -> UpgradePhase {
    match mode {
        // In forward, node groups are followed by Karpenter NodePool
        // replacement (when planned), then the flow completes.
        UpgradeMode::Forward => {
            if has_karpenter(status) {
                UpgradePhase::UpgradingKarpenterNodePools
            } else {
                UpgradePhase::Completed
            }
        }
        UpgradeMode::Rollback => {
            if has_addons(status) {
                UpgradePhase::RollingBackAddons
            } else if has_cp_steps(status) {
                UpgradePhase::RollingBackControlPlane
            } else {
                UpgradePhase::Completed
            }
        }
    }
}

/// Next phase after the Karpenter `NodePool` replacement phase completes.
///
/// Karpenter replacement is forward-only and runs last, so this always
/// completes the flow. Rollback never reaches this phase.
pub const fn after_karpenter(_status: &EKSUpgradeStatus, _mode: &UpgradeMode) -> UpgradePhase {
    UpgradePhase::Completed
}

/// Apply the selected next phase to the status, setting the terminal `Ready`
/// condition when the flow completes.
pub fn transition_to(status: &mut EKSUpgradeStatus, next: UpgradePhase) {
    let completed = next == UpgradePhase::Completed;
    status::set_phase(status, next);
    if completed {
        status::set_condition(status, "Ready", "True", "UpgradeCompleted", None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{AddonStatus, ComponentStatus, NodegroupStatus, PlanningStatus};

    fn status(cp: bool, addons: bool, ngs: bool) -> EKSUpgradeStatus {
        let mut s = EKSUpgradeStatus::default();
        s.phases.planning = Some(PlanningStatus {
            source_version: None,
            upgrade_path: if cp { vec!["1.32".to_string()] } else { vec![] },
        });
        if addons {
            s.phases.addons.push(AddonStatus {
                name: "coredns".to_string(),
                current_version: "v1.11.3".to_string(),
                target_version: "v1.11.1".to_string(),
                status: ComponentStatus::Pending,
                started_at: None,
                completed_at: None,
            });
        }
        if ngs {
            s.phases.nodegroups.push(NodegroupStatus {
                name: "ng-1".to_string(),
                current_version: "1.33".to_string(),
                target_version: "1.32".to_string(),
                status: ComponentStatus::Pending,
                update_id: None,
                started_at: None,
                completed_at: None,
            });
        }
        s
    }

    #[test]
    fn test_forward_after_preflight_cp_priority() {
        let s = status(true, true, true);
        assert_eq!(
            after_preflight(&s, &UpgradeMode::Forward),
            UpgradePhase::UpgradingControlPlane
        );
    }

    #[test]
    fn test_forward_after_control_plane() {
        assert_eq!(
            after_control_plane(&status(true, true, true), &UpgradeMode::Forward),
            UpgradePhase::UpgradingAddons
        );
        assert_eq!(
            after_control_plane(&status(true, false, true), &UpgradeMode::Forward),
            UpgradePhase::UpgradingNodeGroups
        );
        assert_eq!(
            after_control_plane(&status(true, false, false), &UpgradeMode::Forward),
            UpgradePhase::Completed
        );
    }

    #[test]
    fn test_forward_after_addons_and_nodegroups() {
        assert_eq!(
            after_addons(&status(true, true, true), &UpgradeMode::Forward),
            UpgradePhase::UpgradingNodeGroups
        );
        assert_eq!(
            after_addons(&status(true, true, false), &UpgradeMode::Forward),
            UpgradePhase::Completed
        );
        assert_eq!(
            after_nodegroups(&status(true, true, true), &UpgradeMode::Forward),
            UpgradePhase::Completed
        );
    }

    fn with_karpenter(mut s: EKSUpgradeStatus) -> EKSUpgradeStatus {
        use crate::crd::{KarpenterNodePoolsStatus, KarpenterPoolStatus};
        s.phases.karpenter_node_pools = Some(KarpenterNodePoolsStatus {
            strategy: "Replace".to_string(),
            active_pool: None,
            total_nodes: 3,
            replaced_nodes: 0,
            pools: vec![KarpenterPoolStatus {
                name: "default".to_string(),
                status: ComponentStatus::Pending,
                total_nodes: 3,
                replaced_nodes: 0,
                completed_node_claims: vec![],
                replacements: vec![],
                current_batch: vec![],
            }],
        });
        s
    }

    #[test]
    fn test_forward_nodegroups_to_karpenter_when_present() {
        let s = with_karpenter(status(true, true, true));
        assert_eq!(
            after_nodegroups(&s, &UpgradeMode::Forward),
            UpgradePhase::UpgradingKarpenterNodePools
        );
    }

    #[test]
    fn test_forward_addons_skips_to_karpenter_without_nodegroups() {
        let s = with_karpenter(status(true, true, false));
        assert_eq!(
            after_addons(&s, &UpgradeMode::Forward),
            UpgradePhase::UpgradingKarpenterNodePools
        );
    }

    #[test]
    fn test_after_karpenter_completes() {
        let s = with_karpenter(status(true, true, true));
        assert_eq!(
            after_karpenter(&s, &UpgradeMode::Forward),
            UpgradePhase::Completed
        );
    }

    #[test]
    fn test_rollback_ignores_karpenter() {
        // Karpenter is forward-only: a rollback with karpenter status present
        // still routes through the rollback chain, never to the Karpenter phase.
        let s = with_karpenter(status(false, false, true));
        assert_eq!(
            after_nodegroups(&s, &UpgradeMode::Rollback),
            UpgradePhase::Completed
        );
    }

    #[test]
    fn test_rollback_after_preflight_nodegroups_first() {
        let s = status(true, true, true);
        assert_eq!(
            after_preflight(&s, &UpgradeMode::Rollback),
            UpgradePhase::RollingBackNodeGroups
        );
    }

    #[test]
    fn test_rollback_after_preflight_no_nodegroups() {
        assert_eq!(
            after_preflight(&status(true, true, false), &UpgradeMode::Rollback),
            UpgradePhase::RollingBackAddons
        );
        assert_eq!(
            after_preflight(&status(true, false, false), &UpgradeMode::Rollback),
            UpgradePhase::RollingBackControlPlane
        );
        assert_eq!(
            after_preflight(&status(false, false, false), &UpgradeMode::Rollback),
            UpgradePhase::Completed
        );
    }

    #[test]
    fn test_rollback_after_nodegroups() {
        assert_eq!(
            after_nodegroups(&status(true, true, true), &UpgradeMode::Rollback),
            UpgradePhase::RollingBackAddons
        );
        assert_eq!(
            after_nodegroups(&status(true, false, true), &UpgradeMode::Rollback),
            UpgradePhase::RollingBackControlPlane
        );
        assert_eq!(
            after_nodegroups(&status(false, false, true), &UpgradeMode::Rollback),
            UpgradePhase::Completed
        );
    }

    #[test]
    fn test_rollback_after_addons_then_cp() {
        assert_eq!(
            after_addons(&status(true, true, false), &UpgradeMode::Rollback),
            UpgradePhase::RollingBackControlPlane
        );
        assert_eq!(
            after_addons(&status(false, true, false), &UpgradeMode::Rollback),
            UpgradePhase::Completed
        );
    }

    #[test]
    fn test_rollback_after_control_plane_completes() {
        assert_eq!(
            after_control_plane(&status(true, true, true), &UpgradeMode::Rollback),
            UpgradePhase::Completed
        );
    }

    #[test]
    fn test_transition_to_sets_ready_on_completed() {
        let mut s = EKSUpgradeStatus::default();
        transition_to(&mut s, UpgradePhase::Completed);
        assert_eq!(s.phase, Some(UpgradePhase::Completed));
        let ready = s.conditions.iter().find(|c| c.r#type == "Ready").unwrap();
        assert_eq!(ready.status, "True");
        assert_eq!(ready.reason, "UpgradeCompleted");
    }

    fn record(mode: UpgradeMode) -> TransitionRecord {
        TransitionRecord {
            mode,
            to_version: "1.35".to_string(),
            completed_at: chrono::DateTime::from_timestamp(0, 0).unwrap(),
        }
    }

    #[test]
    fn test_consecutive_rollback_blocked_after_rollback() {
        assert!(is_consecutive_rollback(
            &UpgradeMode::Rollback,
            Some(&record(UpgradeMode::Rollback))
        ));
    }

    #[test]
    fn test_rollback_allowed_after_forward() {
        assert!(!is_consecutive_rollback(
            &UpgradeMode::Rollback,
            Some(&record(UpgradeMode::Forward))
        ));
    }

    #[test]
    fn test_first_rollback_allowed_without_history() {
        assert!(!is_consecutive_rollback(&UpgradeMode::Rollback, None));
    }

    #[test]
    fn test_forward_never_blocked() {
        assert!(!is_consecutive_rollback(
            &UpgradeMode::Forward,
            Some(&record(UpgradeMode::Rollback))
        ));
        assert!(!is_consecutive_rollback(&UpgradeMode::Forward, None));
    }

    #[test]
    fn test_transition_to_no_ready_on_intermediate() {
        let mut s = EKSUpgradeStatus::default();
        transition_to(&mut s, UpgradePhase::RollingBackAddons);
        assert_eq!(s.phase, Some(UpgradePhase::RollingBackAddons));
        assert!(s.conditions.iter().all(|c| c.r#type != "Ready"));
    }
}
