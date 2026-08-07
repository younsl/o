//! Shared display formatting for upgrade state.
//!
//! Both observation sinks (Slack notifications and Grafana annotations) render
//! the same handful of things from a spec/status pair: the upgrade path, the run
//! mode, and elapsed time. The formatting lives here so the two sinks cannot
//! drift apart in how they describe the same upgrade.

use chrono::{DateTime, Utc};

use crate::crd::{EKSUpgradeSpec, EKSUpgradeStatus};

/// Format the upgrade path for display, e.g. `1.34 → 1.35 → 1.36`.
///
/// The start of the path is the planning-time `source_version`, which is
/// immutable across the upgrade. The top-level `current_version` is NOT used
/// as the start: it advances to each step's target during the control plane
/// phase, so by completion it equals the final version and would render a
/// nonsensical path like `1.36 → 1.35 → 1.36`.
pub fn upgrade_path(spec: &EKSUpgradeSpec, status: &EKSUpgradeStatus) -> String {
    let planning = status.phases.planning.as_ref();

    let source = planning
        .and_then(|p| p.source_version.as_deref())
        .or(status.current_version.as_deref())
        .unwrap_or("unknown");

    let path = planning
        .map(|p| p.upgrade_path.join(" → "))
        .unwrap_or_default();

    if path.is_empty() {
        format!("{} → {}", source, spec.target_version)
    } else {
        format!("{source} → {path}")
    }
}

/// Human label for the run mode.
#[must_use]
pub const fn mode(spec: &EKSUpgradeSpec) -> &'static str {
    if spec.dry_run {
        "Dry Run"
    } else {
        "Live Upgrade"
    }
}

/// Format the span between two instants as `45m 30s`.
///
/// The magnitude is taken absolutely, so a clock skew that puts `end` before
/// `start` still renders a sane figure rather than an underflowed one.
#[must_use]
pub fn duration(start: DateTime<Utc>, end: DateTime<Utc>) -> String {
    let secs = (end - start).num_seconds().unsigned_abs();
    format!("{}m {}s", secs / 60, secs % 60)
}

/// Format a run's duration from its status timestamps, or `unknown` when the
/// run has not recorded both ends yet.
#[must_use]
pub fn run_duration(status: &EKSUpgradeStatus) -> String {
    match (status.started_at, status.completed_at) {
        (Some(start), Some(end)) => duration(start, end),
        _ => "unknown".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{PhaseStatuses, PlanningStatus, UpgradeMode};

    fn make_spec(dry_run: bool) -> EKSUpgradeSpec {
        EKSUpgradeSpec {
            cluster_name: "my-cluster".to_string(),
            target_version: "1.33".to_string(),
            region: "ap-northeast-2".to_string(),
            upgrade_mode: UpgradeMode::Forward,
            assume_role_arn: None,
            addon_versions: None,
            dry_run,
            timeouts: None,
            notification: None,
            karpenter_node_pools: None,
        }
    }

    #[test]
    fn test_mode_labels() {
        assert_eq!(mode(&make_spec(false)), "Live Upgrade");
        assert_eq!(mode(&make_spec(true)), "Dry Run");
    }

    #[test]
    fn test_duration_formats_minutes_and_seconds() {
        let start = Utc::now();
        let end = start + chrono::Duration::seconds(2730);
        assert_eq!(duration(start, end), "45m 30s");
        assert_eq!(duration(start, start), "0m 0s");
        // Reversed order still renders the magnitude, never an underflow.
        assert_eq!(duration(end, start), "45m 30s");
    }

    #[test]
    fn test_run_duration_unknown_without_both_timestamps() {
        let mut status = EKSUpgradeStatus::default();
        assert_eq!(run_duration(&status), "unknown");
        status.started_at = Some(Utc::now());
        assert_eq!(run_duration(&status), "unknown");
        status.completed_at = Some(status.started_at.unwrap() + chrono::Duration::seconds(61));
        assert_eq!(run_duration(&status), "1m 1s");
    }

    #[test]
    fn test_upgrade_path_uses_source_not_mutated_current() {
        // Regression: 1.30 → 1.31 → 1.32 upgrade. After completion the
        // top-level current_version is "1.32", but the path must still start
        // at the source "1.30", not render "1.32 → 1.31 → 1.32".
        let spec = make_spec(false);
        let status = EKSUpgradeStatus {
            current_version: Some("1.32".to_string()),
            phases: PhaseStatuses {
                planning: Some(PlanningStatus {
                    source_version: Some("1.30".to_string()),
                    upgrade_path: vec!["1.31".into(), "1.32".into()],
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(upgrade_path(&spec, &status), "1.30 → 1.31 → 1.32");
    }

    #[test]
    fn test_upgrade_path_falls_back_to_current_when_no_source() {
        // Backward compat: a CR planned before source_version existed has no
        // planning.source_version; fall back to current_version.
        let spec = make_spec(false);
        let status = EKSUpgradeStatus {
            current_version: Some("1.30".to_string()),
            phases: PhaseStatuses {
                planning: Some(PlanningStatus {
                    source_version: None,
                    upgrade_path: vec!["1.31".into()],
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        assert_eq!(upgrade_path(&spec, &status), "1.30 → 1.31");
    }

    #[test]
    fn test_upgrade_path_without_planning_uses_target() {
        let spec = make_spec(false);
        let status = EKSUpgradeStatus::default();
        assert_eq!(upgrade_path(&spec, &status), "unknown → 1.33");
    }
}
