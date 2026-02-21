//! Notification module for upgrade lifecycle events.

pub mod slack;

pub use slack::SlackNotifier;

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
pub fn build_started_message(spec: &EKSUpgradeSpec, status: &EKSUpgradeStatus) -> String {
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

    format!(
        "*[KUO] EKS Upgrade Started*\n\
         *Cluster*: {cluster}\n\
         *Region*: {region}\n\
         *Target*: {target}\n\
         *Mode*: {mode}\n\
         *Upgrade Path*: {path}\n\
         *Phases*: Planning → Preflight → ControlPlane → Addons → NodeGroups",
        cluster = spec.cluster_name,
        region = spec.region,
        target = spec.target_version,
        mode = mode,
        path = path_display,
    )
}

/// Build the "Completed" notification message.
pub fn build_completed_message(spec: &EKSUpgradeSpec, status: &EKSUpgradeStatus) -> String {
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

    format!(
        "*[KUO] EKS Upgrade Completed*\n\
         *Cluster*: {cluster} ({region})\n\
         *Mode*: {mode}\n\
         *Upgrade Path*: {path}\n\
         *Duration*: {duration}",
        cluster = spec.cluster_name,
        region = spec.region,
        mode = mode,
        path = path_display,
        duration = duration,
    )
}

/// Build the "Failed" notification message.
pub fn build_failed_message(
    spec: &EKSUpgradeSpec,
    status: &EKSUpgradeStatus,
    error: &str,
) -> String {
    let phase = status
        .phase
        .as_ref()
        .map_or_else(|| "Unknown".to_string(), std::string::ToString::to_string);

    let mode = if spec.dry_run {
        "Dry Run"
    } else {
        "Live Upgrade"
    };

    format!(
        "*[KUO] EKS Upgrade Failed*\n\
         *Cluster*: {cluster} ({region})\n\
         *Mode*: {mode}\n\
         *Phase*: {phase}\n\
         *Error*: {error}",
        cluster = spec.cluster_name,
        region = spec.region,
        mode = mode,
        phase = phase,
        error = error,
    )
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
        let msg = build_started_message(&spec, &status);
        assert!(msg.contains("*[KUO] EKS Upgrade Started*"));
        assert!(msg.contains("my-cluster"));
        assert!(msg.contains("ap-northeast-2"));
        assert!(msg.contains("1.33"));
        assert!(msg.contains("Live Upgrade"));
        assert!(msg.contains("1.31 → 1.32"));
    }

    #[test]
    fn test_build_started_message_dry_run() {
        let spec = make_spec(None, true);
        let status = EKSUpgradeStatus::default();
        let msg = build_started_message(&spec, &status);
        assert!(msg.contains("Dry Run"));
    }

    #[test]
    fn test_build_completed_message() {
        let spec = make_spec(None, false);
        let now = chrono::Utc::now();
        let mut status = make_status_with_path(vec!["1.31".into(), "1.32".into()]);
        status.started_at = Some(now - chrono::Duration::seconds(2730));
        status.completed_at = Some(now);
        let msg = build_completed_message(&spec, &status);
        assert!(msg.contains("*[KUO] EKS Upgrade Completed*"));
        assert!(msg.contains("Live Upgrade"));
        assert!(msg.contains("45m 30s"));
    }

    #[test]
    fn test_build_completed_message_dry_run() {
        let spec = make_spec(None, true);
        let status = make_status_with_path(vec!["1.31".into()]);
        let msg = build_completed_message(&spec, &status);
        assert!(msg.contains("Dry Run"));
    }

    #[test]
    fn test_build_failed_message() {
        let spec = make_spec(None, false);
        let mut status = EKSUpgradeStatus::default();
        status.phase = Some(UpgradePhase::UpgradingControlPlane);
        let msg = build_failed_message(&spec, &status, "Control plane upgrade timed out");
        assert!(msg.contains("*[KUO] EKS Upgrade Failed*"));
        assert!(msg.contains("Live Upgrade"));
        assert!(msg.contains("UpgradingControlPlane"));
        assert!(msg.contains("Control plane upgrade timed out"));
    }

    #[test]
    fn test_build_failed_message_dry_run() {
        let spec = make_spec(None, true);
        let mut status = EKSUpgradeStatus::default();
        status.phase = Some(UpgradePhase::PreflightChecking);
        let msg = build_failed_message(&spec, &status, "preflight check failed");
        assert!(msg.contains("Dry Run"));
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
