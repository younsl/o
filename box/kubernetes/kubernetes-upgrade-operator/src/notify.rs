//! Notification module for upgrade lifecycle events.

pub mod slack;

pub use slack::{SlackMessage, SlackNotifier};

use crate::crd::{EKSUpgradeSpec, EKSUpgradeStatus};

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

    let upgrade_path = status
        .phases
        .planning
        .as_ref()
        .map(|p| p.upgrade_path.join(" → "))
        .unwrap_or_default();

    let current = status.current_version.as_deref().unwrap_or("unknown");

    let path_display = if upgrade_path.is_empty() {
        format!("{} → {}", current, spec.target_version)
    } else {
        format!("{current} → {upgrade_path}")
    };

    let phases = "Planning → Preflight → ControlPlane → Addons → NodeGroups";

    SlackMessage {
        header: "EKS Upgrade Started".to_string(),
        fields: vec![
            ("Cluster".to_string(), spec.cluster_name.clone()),
            ("Region".to_string(), spec.region.clone()),
            ("Target Version".to_string(), spec.target_version.clone()),
            ("Mode".to_string(), mode.to_string()),
            ("Upgrade Path".to_string(), path_display),
            ("Phases".to_string(), phases.to_string()),
        ],
        context: format!("Sent by kuo via EKSUpgrade/{resource_name}"),
    }
}

/// Build the "Completed" notification message.
pub fn build_completed_message(
    resource_name: &str,
    spec: &EKSUpgradeSpec,
    status: &EKSUpgradeStatus,
) -> SlackMessage {
    let upgrade_path = status
        .phases
        .planning
        .as_ref()
        .map(|p| p.upgrade_path.join(" → "))
        .unwrap_or_default();

    let current = status.current_version.as_deref().unwrap_or("unknown");

    let path_display = if upgrade_path.is_empty() {
        format!("{} → {}", current, spec.target_version)
    } else {
        format!("{current} → {upgrade_path}")
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
        let mut status = EKSUpgradeStatus::default();
        status.phase = Some(UpgradePhase::UpgradingControlPlane);
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
        let mut status = EKSUpgradeStatus::default();
        status.phase = Some(UpgradePhase::PreflightChecking);
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
            assume_role_arn: None,
            addon_versions: None,
            skip_pdb_check: false,
            dry_run,
            timeouts: None,
            notification,
        }
    }

    fn make_status_with_path(path: Vec<String>) -> EKSUpgradeStatus {
        EKSUpgradeStatus {
            current_version: Some("1.30".to_string()),
            phases: crate::crd::PhaseStatuses {
                planning: Some(PlanningStatus { upgrade_path: path }),
                ..Default::default()
            },
            ..Default::default()
        }
    }
}
