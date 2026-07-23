//! Notification module for upgrade lifecycle events.

pub mod slack;

pub use slack::{SlackMessage, SlackNotifier};

use crate::crd::{EKSUpgradeSpec, EKSUpgradeStatus};

/// Format the upgrade path for display, e.g. `1.34 → 1.35 → 1.36`.
///
/// The start of the path is the planning-time `source_version`, which is
/// immutable across the upgrade. The top-level `current_version` is NOT used
/// as the start: it advances to each step's target during the control plane
/// phase, so by completion it equals the final version and would render a
/// nonsensical path like `1.36 → 1.35 → 1.36`.
fn format_upgrade_path(spec: &EKSUpgradeSpec, status: &EKSUpgradeStatus) -> String {
    let planning = status.phases.planning.as_ref();

    let source = planning
        .and_then(|p| p.source_version.as_deref())
        .or(status.current_version.as_deref())
        .unwrap_or("unknown");

    let upgrade_path = planning
        .map(|p| p.upgrade_path.join(" → "))
        .unwrap_or_default();

    if upgrade_path.is_empty() {
        format!("{} → {}", source, spec.target_version)
    } else {
        format!("{source} → {upgrade_path}")
    }
}

/// Determine whether a notification should be sent for this spec.
pub const fn should_notify(spec: &EKSUpgradeSpec) -> bool {
    match &spec.notification {
        None => false,
        Some(config) => {
            if spec.dry_run {
                config.on_dry_run
            } else {
                config.on_upgrade
            }
        }
    }
}

/// Build the "Started" notification message.
///
/// Called after Planning completes so the upgrade path is available.
pub fn build_started_message(
    resource_name: &str,
    spec: &EKSUpgradeSpec,
    status: &EKSUpgradeStatus,
) -> SlackMessage {
    let mode = if spec.dry_run {
        "Dry Run"
    } else {
        "Live Upgrade"
    };

    let path_display = format_upgrade_path(spec, status);

    let karpenter_enabled = spec
        .karpenter_node_pools
        .as_ref()
        .is_some_and(|k| k.enabled);

    let phases = if karpenter_enabled {
        "Planning → Preflight → ControlPlane → Addons → NodeGroups → KarpenterNodePools"
    } else {
        "Planning → Preflight → ControlPlane → Addons → NodeGroups"
    };

    let mut fields = vec![
        ("Cluster".to_string(), spec.cluster_name.clone()),
        ("Region".to_string(), spec.region.clone()),
        ("Target Version".to_string(), spec.target_version.clone()),
        ("Mode".to_string(), mode.to_string()),
        ("Upgrade Path".to_string(), path_display),
        ("Phases".to_string(), phases.to_string()),
    ];

    if let Some(kp) = spec.karpenter_node_pools.as_ref().filter(|k| k.enabled) {
        let pools = if kp.selects_all() {
            "all".to_string()
        } else {
            kp.node_pools.join(", ")
        };
        fields.push(("Karpenter NodePools".to_string(), pools));
        fields.push(("Karpenter Strategy".to_string(), kp.strategy.to_string()));
        fields.push((
            "Karpenter Concurrency".to_string(),
            format!("maxUnavailable {}", kp.max_unavailable),
        ));
    }

    SlackMessage {
        header: "EKS Upgrade Started".to_string(),
        fields,
        context: format!("Sent by kuo via EKSUpgrade/{resource_name}"),
    }
}

/// Build the "Completed" notification message.
pub fn build_completed_message(
    resource_name: &str,
    spec: &EKSUpgradeSpec,
    status: &EKSUpgradeStatus,
) -> SlackMessage {
    let path_display = format_upgrade_path(spec, status);

    let duration = match (status.started_at, status.completed_at) {
        (Some(start), Some(end)) => {
            let secs = (end - start).num_seconds().unsigned_abs();
            let mins = secs / 60;
            let remaining_secs = secs % 60;
            format!("{mins}m {remaining_secs}s")
        }
        _ => "unknown".to_string(),
    };

    let mode = if spec.dry_run {
        "Dry Run"
    } else {
        "Live Upgrade"
    };

    SlackMessage {
        header: "EKS Upgrade Completed".to_string(),
        fields: vec![
            ("Cluster".to_string(), spec.cluster_name.clone()),
            ("Mode".to_string(), mode.to_string()),
            ("Upgrade Path".to_string(), path_display),
            ("Duration".to_string(), duration),
        ],
        context: format!("Sent by kuo via EKSUpgrade/{resource_name}"),
    }
}

/// Build the "Failed" notification message.
pub fn build_failed_message(
    resource_name: &str,
    spec: &EKSUpgradeSpec,
    status: &EKSUpgradeStatus,
    error: &str,
) -> SlackMessage {
    let phase = status
        .phase
        .as_ref()
        .map_or_else(|| "Unknown".to_string(), std::string::ToString::to_string);

    let mode = if spec.dry_run {
        "Dry Run"
    } else {
        "Live Upgrade"
    };

    let duration = match (status.started_at, status.completed_at) {
        (Some(start), Some(end)) => {
            let secs = (end - start).num_seconds().unsigned_abs();
            let mins = secs / 60;
            let remaining_secs = secs % 60;
            format!("{mins}m {remaining_secs}s")
        }
        _ => "unknown".to_string(),
    };

    SlackMessage {
        header: "EKS Upgrade Failed".to_string(),
        fields: vec![
            ("Cluster".to_string(), spec.cluster_name.clone()),
            ("Mode".to_string(), mode.to_string()),
            ("Failed Phase".to_string(), phase),
            ("Duration".to_string(), duration),
            ("Error".to_string(), error.to_string()),
        ],
        context: format!("Sent by kuo via EKSUpgrade/{resource_name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{NotificationConfig, PlanningStatus, UpgradePhase};

    #[test]
    fn test_should_notify_none() {
        let spec = make_spec(None, false);
        assert!(!should_notify(&spec));
    }

    #[test]
    fn test_should_notify_dry_run_enabled() {
        let spec = make_spec(
            Some(NotificationConfig {
                on_upgrade: false,
                on_dry_run: true,
            }),
            true,
        );
        assert!(should_notify(&spec));
    }

    #[test]
    fn test_should_notify_dry_run_disabled() {
        let spec = make_spec(
            Some(NotificationConfig {
                on_upgrade: true,
                on_dry_run: false,
            }),
            true,
        );
        assert!(!should_notify(&spec));
    }

    #[test]
    fn test_should_notify_live_enabled() {
        let spec = make_spec(
            Some(NotificationConfig {
                on_upgrade: true,
                on_dry_run: false,
            }),
            false,
        );
        assert!(should_notify(&spec));
    }

    #[test]
    fn test_should_notify_live_disabled() {
        let spec = make_spec(
            Some(NotificationConfig {
                on_upgrade: false,
                on_dry_run: true,
            }),
            false,
        );
        assert!(!should_notify(&spec));
    }

    #[test]
    fn test_build_started_message() {
        let spec = make_spec(None, false);
        let status = make_status_with_path(vec!["1.31".into(), "1.32".into()]);
        let msg = build_started_message("staging-upgrade", &spec, &status);
        assert!(msg.header.contains("EKS Upgrade Started"));
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Cluster" && v == "my-cluster")
        );
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Region" && v == "ap-northeast-2")
        );
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Target Version" && v == "1.33")
        );
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Mode" && v == "Live Upgrade")
        );
        assert!(msg.fields.iter().any(|(k, _)| k == "Upgrade Path"));
        assert!(msg.context.contains("EKSUpgrade/staging-upgrade"));
    }

    #[test]
    fn test_build_started_message_with_karpenter() {
        let mut spec = make_spec(None, false);
        spec.karpenter_node_pools = Some(crate::crd::KarpenterNodePoolsConfig {
            enabled: true,
            node_pools: vec!["default".to_string(), "spot".to_string()],
            strategy: crate::crd::KarpenterStrategy::Replace,
            max_unavailable: "1".to_string(),
            node_drain_timeout_minutes: 15,
            controller_stable_timeout_minutes: 10,
        });
        let status = make_status_with_path(vec!["1.33".into()]);
        let msg = build_started_message("kp", &spec, &status);

        let phases = msg
            .fields
            .iter()
            .find(|(k, _)| k == "Phases")
            .map(|(_, v)| v.as_str())
            .unwrap();
        assert!(phases.contains("KarpenterNodePools"));
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Karpenter NodePools" && v == "default, spot")
        );
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Karpenter Strategy" && v == "Replace")
        );
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Karpenter Concurrency" && v.contains("maxUnavailable 1"))
        );
    }

    #[test]
    fn test_build_started_message_karpenter_disabled_omits_fields() {
        let spec = make_spec(None, false);
        let status = make_status_with_path(vec!["1.33".into()]);
        let msg = build_started_message("kp", &spec, &status);
        let phases = msg
            .fields
            .iter()
            .find(|(k, _)| k == "Phases")
            .map(|(_, v)| v.as_str())
            .unwrap();
        assert!(!phases.contains("KarpenterNodePools"));
        assert!(!msg.fields.iter().any(|(k, _)| k.starts_with("Karpenter")));
    }

    #[test]
    fn test_build_started_message_dry_run() {
        let spec = make_spec(None, true);
        let status = EKSUpgradeStatus::default();
        let msg = build_started_message("test", &spec, &status);
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Mode" && v == "Dry Run")
        );
    }

    #[test]
    fn test_build_completed_message() {
        let spec = make_spec(None, false);
        let now = chrono::Utc::now();
        let mut status = make_status_with_path(vec!["1.31".into(), "1.32".into()]);
        status.started_at = Some(now - chrono::Duration::seconds(2730));
        status.completed_at = Some(now);
        let msg = build_completed_message("staging-upgrade", &spec, &status);
        assert!(msg.header.contains("EKS Upgrade Completed"));
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Mode" && v == "Live Upgrade")
        );
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Duration" && v == "45m 30s")
        );
        assert!(msg.context.contains("EKSUpgrade/staging-upgrade"));
    }

    #[test]
    fn test_build_completed_message_dry_run() {
        let spec = make_spec(None, true);
        let status = make_status_with_path(vec!["1.31".into()]);
        let msg = build_completed_message("test", &spec, &status);
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Mode" && v == "Dry Run")
        );
    }

    #[test]
    fn test_build_failed_message() {
        let spec = make_spec(None, false);
        let status = EKSUpgradeStatus {
            phase: Some(UpgradePhase::UpgradingControlPlane),
            ..Default::default()
        };
        let msg = build_failed_message(
            "staging-upgrade",
            &spec,
            &status,
            "Control plane upgrade timed out",
        );
        assert!(msg.header.contains("EKS Upgrade Failed"));
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Mode" && v == "Live Upgrade")
        );
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Failed Phase" && v == "UpgradingControlPlane")
        );
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Error" && v == "Control plane upgrade timed out")
        );
        assert!(msg.context.contains("EKSUpgrade/staging-upgrade"));
    }

    #[test]
    fn test_build_failed_message_dry_run() {
        let spec = make_spec(None, true);
        let status = EKSUpgradeStatus {
            phase: Some(UpgradePhase::PreflightChecking),
            ..Default::default()
        };
        let msg = build_failed_message("test", &spec, &status, "preflight check failed");
        assert!(
            msg.fields
                .iter()
                .any(|(k, v)| k == "Mode" && v == "Dry Run")
        );
    }

    fn make_spec(notification: Option<NotificationConfig>, dry_run: bool) -> EKSUpgradeSpec {
        EKSUpgradeSpec {
            cluster_name: "my-cluster".to_string(),
            target_version: "1.33".to_string(),
            region: "ap-northeast-2".to_string(),
            upgrade_mode: crate::crd::UpgradeMode::Forward,
            assume_role_arn: None,
            addon_versions: None,
            dry_run,
            timeouts: None,
            notification,
            karpenter_node_pools: None,
        }
    }

    fn make_status_with_path(path: Vec<String>) -> EKSUpgradeStatus {
        // Simulate a completed upgrade: the control plane phase advances the
        // top-level current_version to the final step (see control_plane.rs),
        // while planning.source_version stays at the original "1.30".
        let current = path.last().cloned().or_else(|| Some("1.30".to_string()));
        EKSUpgradeStatus {
            current_version: current,
            phases: crate::crd::PhaseStatuses {
                planning: Some(PlanningStatus {
                    source_version: Some("1.30".to_string()),
                    upgrade_path: path,
                }),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn test_upgrade_path_uses_source_not_mutated_current() {
        // Regression: 1.30 → 1.31 → 1.32 upgrade. After completion the
        // top-level current_version is "1.32", but the path must still start
        // at the source "1.30", not render "1.32 → 1.31 → 1.32".
        let spec = make_spec(None, false);
        let status = make_status_with_path(vec!["1.31".into(), "1.32".into()]);
        assert_eq!(status.current_version.as_deref(), Some("1.32"));

        let path = format_upgrade_path(&spec, &status);
        assert_eq!(path, "1.30 → 1.31 → 1.32");
    }

    #[test]
    fn test_completed_message_1_34_to_1_36_path() {
        // Real-world scenario: 1.34 → 1.35 → 1.36. After completion the
        // control plane has advanced currentVersion to "1.36"; the Completed
        // notification must still show "1.34 → 1.35 → 1.36", not
        // "1.36 → 1.35 → 1.36".
        let mut spec = make_spec(None, false);
        spec.target_version = "1.36".to_string();

        let mut status = EKSUpgradeStatus {
            current_version: Some("1.36".to_string()), // mutated by control plane
            phases: crate::crd::PhaseStatuses {
                planning: Some(PlanningStatus {
                    source_version: Some("1.34".to_string()),
                    upgrade_path: vec!["1.35".into(), "1.36".into()],
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        let now = chrono::Utc::now();
        status.started_at = Some(now - chrono::Duration::seconds(1839));
        status.completed_at = Some(now);

        let msg = build_completed_message("test-cluster", &spec, &status);
        let path = msg
            .fields
            .iter()
            .find(|(k, _)| k == "Upgrade Path")
            .map(|(_, v)| v.as_str())
            .unwrap();
        assert_eq!(path, "1.34 → 1.35 → 1.36");

        // Started notification renders the same path.
        let started = build_started_message("test-cluster", &spec, &status);
        let started_path = started
            .fields
            .iter()
            .find(|(k, _)| k == "Upgrade Path")
            .map(|(_, v)| v.as_str())
            .unwrap();
        assert_eq!(started_path, "1.34 → 1.35 → 1.36");
    }

    #[test]
    fn test_upgrade_path_falls_back_to_current_when_no_source() {
        // Backward compat: a CR planned before source_version existed has no
        // planning.source_version; fall back to current_version.
        let spec = make_spec(None, false);
        let status = EKSUpgradeStatus {
            current_version: Some("1.30".to_string()),
            phases: crate::crd::PhaseStatuses {
                planning: Some(PlanningStatus {
                    source_version: None,
                    upgrade_path: vec!["1.31".into()],
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(format_upgrade_path(&spec, &status), "1.30 → 1.31");
    }
}
