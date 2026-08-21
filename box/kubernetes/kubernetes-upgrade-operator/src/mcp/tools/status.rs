//! Status-backed read tools: everything answerable from the `EKSUpgrade`
//! resources alone, no AWS or target-cluster round trip.

use serde_json::json;

use crate::crd::{EKSUpgrade, UpgradeMode, UpgradePhase};
use crate::mcp::result::{LIST_CAP, ToolResult, Verdict};
use crate::render;

/// `list_upgrades`: one row per resource.
pub fn list_upgrades(items: &[EKSUpgrade]) -> ToolResult {
    let truncated = items.len() > LIST_CAP;
    let rows: Vec<serde_json::Value> = items
        .iter()
        .take(LIST_CAP)
        .map(|cr| {
            let status = cr.status.clone().unwrap_or_default();
            json!({
                "name": cr.metadata.name,
                "namespace": cr.metadata.namespace,
                "cluster": cr.spec.cluster_name,
                "region": cr.spec.region,
                "mode": mode_label(&cr.spec.upgrade_mode),
                "dryRun": cr.spec.dry_run,
                "currentVersion": status.current_version,
                "targetVersion": cr.spec.target_version,
                "phase": status.phase.as_ref().map(ToString::to_string),
                "progress": status.progress,
            })
        })
        .collect();

    let mut result = ToolResult::new(
        format!("{} EKSUpgrade resource(s)", items.len()),
        Verdict::Ok,
        json!({ "upgrades": rows }),
    );
    result.truncated = truncated;
    result
}

/// `get_upgrade_status`: the full picture of one resource.
pub fn get_upgrade_status(cr: &EKSUpgrade) -> ToolResult {
    let status = cr.status.clone().unwrap_or_default();
    let phase = status.phase.clone();
    let verdict = phase_verdict(phase.as_ref());
    let phase_label = phase
        .as_ref()
        .map_or_else(|| "NotStarted".to_string(), ToString::to_string);

    let mut result = ToolResult::new(
        format!(
            "{} is {} ({})",
            cr.spec.cluster_name,
            phase_label,
            render::upgrade_path(&cr.spec, &status)
        ),
        verdict,
        json!({
            "phase": phase_label,
            "progress": status.progress,
            "upgradePath": render::upgrade_path(&cr.spec, &status),
            "runDuration": render::run_duration(&status),
            "mode": mode_label(&cr.spec.upgrade_mode),
            "dryRun": cr.spec.dry_run,
            "message": status.message,
            "identity": status.identity.as_ref().map(|i| json!({
                "accountId": i.account_id,
                "arn": i.arn,
            })),
            "conditions": status.conditions.iter().map(|c| json!({
                "type": c.r#type,
                "status": c.status,
                "reason": c.reason,
                "message": c.message,
            })).collect::<Vec<_>>(),
            "lastTransition": status.last_transition.as_ref().map(|t| json!({
                "mode": mode_label(&t.mode),
                "toVersion": t.to_version,
                "completedAt": t.completed_at.to_rfc3339(),
            })),
        }),
    );
    result.cluster = Some(cr.spec.cluster_name.clone());
    result
}

/// `get_preflight_report`: each check with its blocking flag.
///
/// Every check kuo currently runs is mandatory (`CheckCategory` has no other
/// variant), so `mandatory` is true on each row; the field is part of the
/// wire contract and stays explicit so an advisory category can land later
/// without changing the shape agents parse.
pub fn get_preflight_report(cr: &EKSUpgrade) -> ToolResult {
    let status = cr.status.clone().unwrap_or_default();
    let Some(preflight) = status.phases.preflight else {
        let mut result = ToolResult::new(
            format!(
                "{} has no preflight results yet (phase {})",
                cr.spec.cluster_name,
                status
                    .phase
                    .as_ref()
                    .map_or_else(|| "NotStarted".to_string(), ToString::to_string)
            ),
            Verdict::Unknown,
            json!({ "hint": "preflight runs after Planning; check again once the run reaches PreflightChecking" }),
        );
        result.cluster = Some(cr.spec.cluster_name.clone());
        return result;
    };

    let checks: Vec<serde_json::Value> = preflight
        .checks
        .iter()
        .map(|c| {
            json!({
                "name": c.name,
                "passed": c.status == "Pass",
                "mandatory": true,
                "reason": c.message,
                "resources": c.resources,
            })
        })
        .collect();
    let blocking: Vec<&str> = preflight
        .checks
        .iter()
        .filter(|c| c.status == "Fail")
        .map(|c| c.name.as_str())
        .collect();

    let (summary, verdict) = if blocking.is_empty() {
        (
            format!(
                "{}: all {} preflight checks passed",
                cr.spec.cluster_name,
                preflight.checks.len()
            ),
            Verdict::Ok,
        )
    } else {
        (
            format!(
                "{} is blocked: {} mandatory check(s) failed ({})",
                cr.spec.cluster_name,
                blocking.len(),
                blocking.join(", ")
            ),
            Verdict::Blocked,
        )
    };

    let mut result = ToolResult::new(
        summary,
        verdict,
        json!({ "checks": checks, "blocking": blocking }),
    );
    result.cluster = Some(cr.spec.cluster_name.clone());
    result
}

/// `get_controlplane_state`: step progress and the in-flight update.
pub fn get_controlplane_state(cr: &EKSUpgrade) -> ToolResult {
    let status = cr.status.clone().unwrap_or_default();
    let control_plane = status.phases.control_plane.as_ref();
    let current = status.current_version.as_deref().unwrap_or("unknown");

    let remaining = status
        .current_version
        .as_deref()
        .and_then(|version| match cr.spec.upgrade_mode {
            UpgradeMode::Forward => {
                crate::eks::version::calculate_upgrade_path(version, &cr.spec.target_version).ok()
            }
            UpgradeMode::Rollback => None,
        })
        .unwrap_or_default();

    let in_flight = control_plane.and_then(|cp| cp.update_id.as_deref());
    let summary = in_flight.map_or_else(
        || {
            format!(
                "{} control plane is at {} (target {})",
                cr.spec.cluster_name, current, cr.spec.target_version
            )
        },
        |id| {
            format!(
                "{} control plane update {} is in flight toward {}",
                cr.spec.cluster_name,
                id,
                control_plane
                    .and_then(|cp| cp.target.as_deref())
                    .unwrap_or(&cr.spec.target_version)
            )
        },
    );

    let mut result = ToolResult::new(
        summary,
        if in_flight.is_some() {
            Verdict::Warn
        } else {
            Verdict::Ok
        },
        json!({
            "currentVersion": current,
            "targetVersion": cr.spec.target_version,
            "step": control_plane.map(|cp| json!({
                "current": cp.current_step,
                "total": cp.total_steps,
                "target": cp.target,
                "updateId": cp.update_id,
                "startedAt": cp.started_at.map(|t| t.to_rfc3339()),
                "completedAt": cp.completed_at.map(|t| t.to_rfc3339()),
            })),
            "remainingMinors": remaining,
        }),
    );
    result.cluster = Some(cr.spec.cluster_name.clone());
    result
}

/// `get_version_lifecycle`: support-window answer from the recorded status.
pub fn get_version_lifecycle(cr: &EKSUpgrade, now: chrono::DateTime<chrono::Utc>) -> ToolResult {
    let status = cr.status.clone().unwrap_or_default();
    let Some(lifecycle) = status.lifecycle else {
        let mut result = ToolResult::new(
            format!(
                "{} has no lifecycle data yet, it is recorded during Planning",
                cr.spec.cluster_name
            ),
            Verdict::Unknown,
            json!({}),
        );
        result.cluster = Some(cr.spec.cluster_name.clone());
        return result;
    };

    let render_version = |info: &crate::crd::VersionLifecycleInfo| {
        json!({
            "version": info.version,
            "status": info.version_status,
            "endOfStandardSupport": info.end_of_standard_support_date.map(|t| t.to_rfc3339()),
            "endOfExtendedSupport": info.end_of_extended_support_date.map(|t| t.to_rfc3339()),
            "daysUntilStandardSupportEnds": info
                .end_of_standard_support_date
                .map(|t| (t - now).num_days()),
        })
    };

    let expired = lifecycle
        .current_version
        .as_ref()
        .and_then(|v| v.end_of_standard_support_date)
        .is_some_and(|t| t < now);
    let (summary, verdict) = if expired {
        (
            format!(
                "{} current version is past its standard support end",
                cr.spec.cluster_name
            ),
            Verdict::Warn,
        )
    } else {
        (
            format!("{} version support windows recorded", cr.spec.cluster_name),
            Verdict::Ok,
        )
    };

    let mut result = ToolResult::new(
        summary,
        verdict,
        json!({
            "lastChecked": lifecycle.last_checked_time.to_rfc3339(),
            "currentVersion": lifecycle.current_version.as_ref().map(render_version),
            "targetVersion": lifecycle.target_version.as_ref().map(render_version),
            "error": lifecycle.error,
        }),
    );
    result.cluster = Some(cr.spec.cluster_name.clone());
    result
}

/// `diagnose_upgrade`: the stuck-or-failed verdict with the next action.
///
/// Reads only the recorded status, never AWS, so a diagnosis on a cold cache
/// cannot stack round trips against kagent's request timeout.
///
/// One match arm per phase family keeps the whole diagnosis in one place;
/// splitting it would scatter the verdict logic the tool exists to state.
#[allow(clippy::too_many_lines)]
pub fn diagnose_upgrade(cr: &EKSUpgrade) -> ToolResult {
    let status = cr.status.clone().unwrap_or_default();
    let cluster = cr.spec.cluster_name.clone();
    let phase = status.phase.clone();

    // Rollback eligibility is decided by the recorded last transition: EKS
    // only rolls back toward a version the cluster was recently upgraded
    // from, so a second consecutive rollback has no eligible target.
    let rollback_note = if cr.spec.upgrade_mode == UpgradeMode::Rollback {
        Some(match status.last_transition.as_ref() {
            Some(t) if t.mode == UpgradeMode::Forward => json!({
                "eligible": true,
                "rollbackTarget": "the version before the last completed upgrade",
                "lastTransition": { "mode": "Forward", "toVersion": t.to_version },
            }),
            Some(t) => json!({
                "eligible": false,
                "reason": "the last completed transition was already a rollback, a second consecutive rollback has no eligible target",
                "lastTransition": { "mode": mode_label(&t.mode), "toVersion": t.to_version },
            }),
            None => json!({
                "eligible": false,
                "reason": "no completed transition is recorded, so there is no version to roll back to",
            }),
        })
    } else {
        None
    };

    let (summary, verdict, finding) = match phase.as_ref() {
        None | Some(UpgradePhase::Pending) => (
            format!("{cluster}: not started yet"),
            Verdict::Ok,
            json!({ "nextAction": "nothing; the controller picks it up on its next pass" }),
        ),
        Some(UpgradePhase::Completed) => (
            format!("{cluster}: completed"),
            Verdict::Ok,
            json!({ "nextAction": "nothing" }),
        ),
        Some(UpgradePhase::Failed) => {
            let failing = failing_components(&status);
            (
                format!(
                    "{cluster} failed: {}",
                    status.message.as_deref().unwrap_or("no message recorded")
                ),
                Verdict::Failed,
                json!({
                    "message": status.message,
                    "failingComponents": failing,
                    "nextAction": "fix the recorded cause, then bump the retry annotation or change the spec to start a new attempt",
                }),
            )
        }
        Some(UpgradePhase::PreflightChecking) => {
            let blocking: Vec<String> = status
                .phases
                .preflight
                .as_ref()
                .map(|p| {
                    p.checks
                        .iter()
                        .filter(|c| c.status == "Fail")
                        .map(|c| c.name.clone())
                        .collect()
                })
                .unwrap_or_default();
            if blocking.is_empty() {
                (
                    format!("{cluster}: preflight checks are running"),
                    Verdict::Ok,
                    json!({ "nextAction": "wait; get_preflight_report shows the results" }),
                )
            } else {
                (
                    format!(
                        "{cluster} is blocked in PreflightChecking: {} mandatory check(s) failed",
                        blocking.len()
                    ),
                    Verdict::Blocked,
                    json!({
                        "blocking": blocking,
                        "nextAction": "fix what the failing checks name; get_preflight_report carries the reasons",
                    }),
                )
            }
        }
        Some(in_progress) => (
            format!(
                "{cluster}: {in_progress} in progress ({})",
                status.progress.as_deref().unwrap_or("no progress recorded")
            ),
            Verdict::Ok,
            json!({
                "progress": status.progress,
                "nextAction": "wait; explain_phase describes what this phase waits on",
            }),
        ),
    };

    let mut details = match finding {
        serde_json::Value::Object(map) => map,
        other => {
            let mut map = serde_json::Map::new();
            map.insert("finding".to_string(), other);
            map
        }
    };
    details.insert(
        "phase".to_string(),
        json!(phase.as_ref().map(ToString::to_string)),
    );
    if let Some(note) = rollback_note {
        details.insert("rollbackEligibility".to_string(), note);
    }

    let mut result = ToolResult::new(summary, verdict, serde_json::Value::Object(details));
    result.cluster = Some(cluster);
    result
}

/// Components whose recorded status is Failed.
fn failing_components(status: &crate::crd::EKSUpgradeStatus) -> Vec<String> {
    use crate::crd::ComponentStatus;
    let mut failing = Vec::new();
    for addon in &status.phases.addons {
        if addon.status == ComponentStatus::Failed {
            failing.push(format!("addon/{}", addon.name));
        }
    }
    for nodegroup in &status.phases.nodegroups {
        if nodegroup.status == ComponentStatus::Failed {
            failing.push(format!("nodegroup/{}", nodegroup.name));
        }
    }
    if let Some(karpenter) = &status.phases.karpenter_node_pools {
        for pool in &karpenter.pools {
            if pool.status == ComponentStatus::Failed {
                failing.push(format!("karpenter-nodepool/{}", pool.name));
            }
        }
    }
    failing
}

/// Human label for a mode value.
const fn mode_label(mode: &UpgradeMode) -> &'static str {
    match mode {
        UpgradeMode::Forward => "Forward",
        UpgradeMode::Rollback => "Rollback",
    }
}

/// Map a phase to the status verdict.
const fn phase_verdict(phase: Option<&UpgradePhase>) -> Verdict {
    match phase {
        Some(UpgradePhase::Failed) => Verdict::Failed,
        _ => Verdict::Ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{
        EKSUpgradeSpec, EKSUpgradeStatus, PreflightCheckStatus, PreflightStatus, TransitionRecord,
    };
    use kube::api::ObjectMeta;

    fn upgrade(cluster: &str, phase: Option<UpgradePhase>) -> EKSUpgrade {
        let mut cr = EKSUpgrade::new(
            cluster,
            EKSUpgradeSpec {
                cluster_name: cluster.to_string(),
                target_version: "1.34".to_string(),
                region: "ap-northeast-2".to_string(),
                upgrade_mode: UpgradeMode::Forward,
                assume_role_arn: None,
                addon_versions: None,
                dry_run: true,
                timeouts: None,
                notification: None,
                karpenter_node_pools: None,
            },
        );
        cr.metadata = ObjectMeta {
            name: Some(cluster.to_string()),
            namespace: Some("kuo".to_string()),
            ..ObjectMeta::default()
        };
        cr.status = Some(EKSUpgradeStatus {
            phase,
            current_version: Some("1.32".to_string()),
            ..EKSUpgradeStatus::default()
        });
        cr
    }

    #[test]
    fn test_list_upgrades_rows() {
        let items = vec![
            upgrade("prod-a", Some(UpgradePhase::Completed)),
            upgrade("prod-b", None),
        ];
        let result = list_upgrades(&items);
        assert_eq!(result.verdict, Verdict::Ok);
        assert!(!result.truncated);
        let rows = result.details["upgrades"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["cluster"], "prod-a");
        assert_eq!(rows[0]["phase"], "Completed");
    }

    #[test]
    fn test_list_upgrades_caps() {
        let items: Vec<EKSUpgrade> = (0..(LIST_CAP + 5))
            .map(|i| upgrade(&format!("c{i}"), None))
            .collect();
        let result = list_upgrades(&items);
        assert!(result.truncated);
        assert_eq!(
            result.details["upgrades"].as_array().unwrap().len(),
            LIST_CAP
        );
    }

    #[test]
    fn test_get_upgrade_status_failed_verdict() {
        let cr = upgrade("prod", Some(UpgradePhase::Failed));
        let result = get_upgrade_status(&cr);
        assert_eq!(result.verdict, Verdict::Failed);
        assert_eq!(result.cluster.as_deref(), Some("prod"));
    }

    #[test]
    fn test_preflight_report_no_data() {
        let cr = upgrade("prod", Some(UpgradePhase::Planning));
        let result = get_preflight_report(&cr);
        assert_eq!(result.verdict, Verdict::Unknown);
    }

    #[test]
    fn test_preflight_report_blocking() {
        let mut cr = upgrade("prod", Some(UpgradePhase::PreflightChecking));
        cr.status.as_mut().unwrap().phases.preflight = Some(PreflightStatus {
            checks: vec![
                PreflightCheckStatus {
                    name: "EKS Deletion Protection".to_string(),
                    status: "Pass".to_string(),
                    message: "enabled".to_string(),
                    resources: vec![],
                },
                PreflightCheckStatus {
                    name: "EKS Cluster Insights".to_string(),
                    status: "Fail".to_string(),
                    message: "2 critical insights".to_string(),
                    resources: vec!["addon:vpc-cni".to_string()],
                },
            ],
        });
        let result = get_preflight_report(&cr);
        assert_eq!(result.verdict, Verdict::Blocked);
        assert_eq!(result.details["blocking"][0], "EKS Cluster Insights");
        let checks = result.details["checks"].as_array().unwrap();
        assert_eq!(checks[0]["passed"], true);
        assert_eq!(checks[1]["passed"], false);
        assert_eq!(checks[1]["mandatory"], true);
    }

    #[test]
    fn test_controlplane_state_remaining_path() {
        let cr = upgrade("prod", Some(UpgradePhase::UpgradingControlPlane));
        let result = get_controlplane_state(&cr);
        assert_eq!(result.verdict, Verdict::Ok);
        let remaining = result.details["remainingMinors"].as_array().unwrap();
        assert_eq!(remaining.len(), 2, "1.32 to 1.34 is two minors");
    }

    #[test]
    fn test_lifecycle_without_data() {
        let cr = upgrade("prod", None);
        let result = get_version_lifecycle(&cr, chrono::Utc::now());
        assert_eq!(result.verdict, Verdict::Unknown);
    }

    #[test]
    fn test_diagnose_failed() {
        let mut cr = upgrade("prod", Some(UpgradePhase::Failed));
        cr.status.as_mut().unwrap().message = Some("nodegroup update failed".to_string());
        let result = diagnose_upgrade(&cr);
        assert_eq!(result.verdict, Verdict::Failed);
        assert!(result.summary.contains("nodegroup update failed"));
    }

    #[test]
    fn test_diagnose_rollback_ineligible_after_rollback() {
        let mut cr = upgrade("prod", Some(UpgradePhase::Planning));
        cr.spec.upgrade_mode = UpgradeMode::Rollback;
        cr.status.as_mut().unwrap().last_transition = Some(TransitionRecord {
            mode: UpgradeMode::Rollback,
            to_version: "1.31".to_string(),
            completed_at: chrono::Utc::now(),
        });
        let result = diagnose_upgrade(&cr);
        assert_eq!(
            result.details["rollbackEligibility"]["eligible"], false,
            "consecutive rollback must be ineligible"
        );
    }

    #[test]
    fn test_diagnose_rollback_eligible_after_forward() {
        let mut cr = upgrade("prod", Some(UpgradePhase::Planning));
        cr.spec.upgrade_mode = UpgradeMode::Rollback;
        cr.status.as_mut().unwrap().last_transition = Some(TransitionRecord {
            mode: UpgradeMode::Forward,
            to_version: "1.33".to_string(),
            completed_at: chrono::Utc::now(),
        });
        let result = diagnose_upgrade(&cr);
        assert_eq!(result.details["rollbackEligibility"]["eligible"], true);
    }
}
