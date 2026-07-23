//! `EKSUpgrade` controller - reconcile dispatch and error policy.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use kube::Api;
use kube::api::{Patch, PatchParams};
use kube::runtime::controller::Action;
use tracing::{error, info, warn};

use crate::aws::AwsClients;
use crate::crd::{EKSUpgrade, EKSUpgradeStatus, UpgradePhase};
use crate::notify::{self, SlackNotifier};
use crate::phases;
use crate::status;
use crate::telemetry::metrics::{Metrics, PhaseLabels, ReconcileLabels, UpgradeLabels};

/// Shared context for the controller.
pub struct Context {
    pub kube_client: kube::Client,
    pub metrics: Arc<Metrics>,
    /// Slack notifier. `None` when `SLACK_WEBHOOK_URL` is not set.
    pub slack: Option<Arc<SlackNotifier>>,
}

/// Reconcile an `EKSUpgrade` resource.
///
/// Phase-based state machine: reads current phase, executes one step, patches status.
#[allow(clippy::too_many_lines)]
pub async fn reconcile(obj: Arc<EKSUpgrade>, ctx: Arc<Context>) -> Result<Action, kube::Error> {
    let name = obj.metadata.name.as_deref().unwrap_or("unknown");

    let api: Api<EKSUpgrade> = Api::all(ctx.kube_client.clone());

    let spec = &obj.spec;
    let current_status = obj.status.clone().unwrap_or_default();
    let phase = current_status
        .phase
        .clone()
        .unwrap_or(UpgradePhase::Pending);

    // Check generation for spec change detection
    let generation = obj.metadata.generation.unwrap_or(0);

    // Terminal phases are normally idle. If the spec changed (generation
    // bumped), restart the reconcile from Pending. This is how a rollback is
    // triggered on an already-completed resource: edit the same EKSUpgrade
    // (e.g. set `upgradeMode: Rollback` and `targetVersion` to N-1) and the
    // operator re-plans and executes against the new spec.
    if phase == UpgradePhase::Completed || phase == UpgradePhase::Failed {
        if current_status.observed_generation < generation {
            info!(
                "Spec changed for {} (phase {}); restarting reconcile from Pending",
                name, phase
            );
            // Explicit null-emitting merge patch: fields with
            // `skip_serializing_if` (message, completedAt, empty vecs, etc.)
            // would otherwise survive a merge patch and leave stale run state.
            let patch = reset_status_patch(&current_status, generation);
            if let Err(e) = api
                .patch_status(name, &PatchParams::apply("kuo"), &Patch::Merge(&patch))
                .await
            {
                warn!("Failed to reset status for {}: {}", name, e);
                return Ok(Action::requeue(Duration::from_secs(5)));
            }
            return Ok(Action::requeue(Duration::from_millis(100)));
        }
        return Ok(Action::await_change());
    }
    let has_active_update = current_status
        .phases
        .control_plane
        .as_ref()
        .and_then(|cp| cp.update_id.as_ref())
        .is_some()
        || current_status
            .phases
            .nodegroups
            .iter()
            .any(|ng| ng.update_id.is_some());
    if current_status.observed_generation >= generation
        && phase != UpgradePhase::Pending
        && !has_active_update
    {
        // Only skip if not in a polling state
        if !matches!(
            phase,
            UpgradePhase::Planning
                | UpgradePhase::PreflightChecking
                | UpgradePhase::UpgradingControlPlane
                | UpgradePhase::UpgradingAddons
                | UpgradePhase::UpgradingNodeGroups
                | UpgradePhase::RollingBackNodeGroups
                | UpgradePhase::RollingBackAddons
                | UpgradePhase::RollingBackControlPlane
        ) {
            return Ok(Action::await_change());
        }
    }

    info!("Reconciling {} (phase: {})", name, phase);

    // Pre-initialize metric label combinations for this cluster (once per cluster)
    ctx.metrics
        .init_for_cluster(&spec.cluster_name, &spec.region);

    let reconcile_start = Instant::now();
    let upgrade_labels = UpgradeLabels {
        cluster_name: spec.cluster_name.clone(),
        region: spec.region.clone(),
    };
    let old_phase = phase.clone();

    // Ensure phase start time is tracked (idempotent across reconcile loops,
    // also handles operator restart where in-memory state is lost)
    ctx.metrics
        .ensure_phase_start(&spec.cluster_name, &spec.region);

    let recorder = status::EventRecorder::new(ctx.kube_client.clone(), &obj);

    // Create AWS clients for the target region (with optional cross-account AssumeRole)
    let aws = match AwsClients::new(&spec.region, spec.assume_role_arn.as_deref()).await {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to create AWS clients for {}: {}", spec.region, e);
            let mut new_status = current_status.clone();
            status::set_failed(&mut new_status, format!("AWS client error: {e}"));
            status::set_condition(
                &mut new_status,
                "AWSAuthenticated",
                "False",
                "AuthenticationFailed",
                Some(e.to_string()),
            );
            new_status.observed_generation = generation;
            let _ = status::patch_status(&api, name, &new_status).await;
            return Ok(Action::requeue(Duration::from_mins(1)));
        }
    };

    // Verify AWS identity and record it in status (only once per generation)
    if current_status.identity.is_none() {
        let mut new_status = current_status.clone();
        match aws.verify_identity().await {
            Ok(identity) => {
                info!(
                    "AWS identity verified for {}: account={}, arn={}",
                    name, identity.account_id, identity.arn
                );
                status::set_condition(
                    &mut new_status,
                    "AWSAuthenticated",
                    "True",
                    "IdentityVerified",
                    Some(format!("account={}", identity.account_id)),
                );
                new_status.identity = Some(identity);
                new_status.observed_generation = generation;
                let _ = status::patch_status(&api, name, &new_status).await;
            }
            Err(e) => {
                error!("AWS identity verification failed for {}: {}", name, e);
                status::set_failed(&mut new_status, format!("AWS authentication failed: {e}"));
                status::set_condition(
                    &mut new_status,
                    "AWSAuthenticated",
                    "False",
                    "IdentityVerificationFailed",
                    Some(e.to_string()),
                );
                new_status.observed_generation = generation;
                let _ = status::patch_status(&api, name, &new_status).await;
                return Ok(Action::requeue(Duration::from_mins(1)));
            }
        }
    }

    // Dispatch to phase handler
    let result = match phase {
        UpgradePhase::Pending => {
            recorder
                .publish(
                    "UpgradeStarted",
                    &format!(
                        "Starting upgrade of {} to {}",
                        spec.cluster_name, spec.target_version
                    ),
                )
                .await;
            let mut new_status = current_status.clone();
            new_status.started_at = Some(chrono::Utc::now());
            status::set_phase(&mut new_status, UpgradePhase::Planning);
            Ok((new_status, Some(Duration::from_secs(0))))
        }
        UpgradePhase::Planning => {
            match phases::planning::execute(spec, &current_status, &aws).await {
                Ok(s) => Ok((s, Some(Duration::from_secs(0)))),
                Err(e) => Err(e),
            }
        }
        UpgradePhase::PreflightChecking => {
            match phases::preflight::execute(spec, &current_status, &aws).await {
                Ok(s) => Ok((s, Some(Duration::from_secs(0)))),
                Err(e) => Err(e),
            }
        }
        // Rollback phases reuse the same handlers; the AWS operations
        // (UpdateClusterVersion / UpdateNodegroupVersion / UpdateAddon to a
        // lower version) are identical. Only the phase ordering differs, which
        // is decided by `phases::transition` based on `spec.upgradeMode`.
        UpgradePhase::UpgradingControlPlane | UpgradePhase::RollingBackControlPlane => {
            phases::control_plane::execute(spec, &current_status, &aws).await
        }
        UpgradePhase::UpgradingAddons | UpgradePhase::RollingBackAddons => {
            phases::addons::execute(spec, &current_status, &aws).await
        }
        UpgradePhase::UpgradingNodeGroups | UpgradePhase::RollingBackNodeGroups => {
            phases::nodegroups::execute(spec, &current_status, &aws).await
        }
        // Karpenter NodePool replacement is forward-only (no rollback variant).
        UpgradePhase::UpgradingKarpenterNodePools => {
            phases::karpenter::execute(spec, &current_status, &aws).await
        }
        UpgradePhase::Completed | UpgradePhase::Failed => {
            return Ok(Action::await_change());
        }
    };

    match result {
        Ok((mut new_status, requeue)) => {
            new_status.observed_generation = generation;

            // Refresh the completed/total progress shown in the PROGRESS column.
            new_status.progress = status::compute_progress(&new_status);

            // On reaching Completed, record the transition so a subsequent
            // rollback can be checked against it. This survives the spec-change
            // reset (see `reset_status_patch`) and is the only signal for
            // rejecting a consecutive rollback.
            if new_status.phase == Some(UpgradePhase::Completed) {
                new_status.last_transition = Some(crate::crd::TransitionRecord {
                    mode: spec.upgrade_mode.clone(),
                    to_version: spec.target_version.clone(),
                    completed_at: chrono::Utc::now(),
                });
            }

            if let Err(e) = status::patch_status(&api, name, &new_status).await {
                warn!("Failed to patch status for {}: {}", name, e);
                return Ok(Action::requeue(Duration::from_secs(5)));
            }

            // Emit an event per Karpenter NodeClaim replacement transition so
            // each replaced node is identifiable in the EKSUpgrade event stream.
            for ev in phases::karpenter::replacement_events(
                current_status.phases.karpenter_node_pools.as_ref(),
                new_status.phases.karpenter_node_pools.as_ref(),
            ) {
                recorder.publish(ev.reason, &ev.message).await;
            }

            // Record metrics
            let elapsed = reconcile_start.elapsed().as_secs_f64();
            ctx.metrics
                .reconcile_duration_seconds
                .get_or_create(&upgrade_labels)
                .observe(elapsed);

            let new_phase = new_status.phase.clone().unwrap_or(UpgradePhase::Pending);

            // Detect phase transition
            if new_phase != old_phase {
                // Observe duration of the completed phase
                ctx.metrics.observe_phase_duration(
                    &spec.cluster_name,
                    &spec.region,
                    &old_phase.to_string(),
                );

                // Deactivate old phase gauge
                ctx.metrics
                    .upgrade_phase_info
                    .get_or_create(&PhaseLabels {
                        cluster_name: spec.cluster_name.clone(),
                        region: spec.region.clone(),
                        phase: old_phase.to_string(),
                    })
                    .set(0);

                // Activate new phase gauge
                ctx.metrics
                    .upgrade_phase_info
                    .get_or_create(&PhaseLabels {
                        cluster_name: spec.cluster_name.clone(),
                        region: spec.region.clone(),
                        phase: new_phase.to_string(),
                    })
                    .set(1);

                // Record phase transition
                ctx.metrics
                    .phase_transition_total
                    .get_or_create(&PhaseLabels {
                        cluster_name: spec.cluster_name.clone(),
                        region: spec.region.clone(),
                        phase: new_phase.to_string(),
                    })
                    .inc();

                // Start tracking the new phase duration
                ctx.metrics
                    .record_phase_start(&spec.cluster_name, &spec.region);

                // Slack: send Started notification when Planning → PreflightChecking
                if old_phase == UpgradePhase::Planning
                    && new_phase == UpgradePhase::PreflightChecking
                    && let Some(ref notifier) = ctx.slack
                    && notify::should_notify(spec)
                {
                    let msg = notify::build_started_message(name, spec, &new_status);
                    notifier.send(name, &msg).await;
                }
            }

            // Determine result label for reconcile counter
            let result_label = if requeue.is_some() {
                "requeue"
            } else {
                "success"
            };
            ctx.metrics
                .reconcile_total
                .get_or_create(&ReconcileLabels {
                    cluster_name: spec.cluster_name.clone(),
                    region: spec.region.clone(),
                    result: result_label.to_string(),
                })
                .inc();

            // Emit event and record terminal metrics
            match new_status.phase {
                Some(UpgradePhase::Completed) => {
                    ctx.metrics
                        .upgrade_completed_total
                        .get_or_create(&upgrade_labels)
                        .inc();
                    let msg = new_status
                        .message
                        .as_deref()
                        .unwrap_or("Upgrade completed successfully");
                    recorder.publish("UpgradeCompleted", msg).await;

                    // Slack: send Completed notification
                    if let Some(ref notifier) = ctx.slack
                        && notify::should_notify(spec)
                    {
                        let slack_msg = notify::build_completed_message(name, spec, &new_status);
                        notifier.send(name, &slack_msg).await;
                    }
                }
                Some(UpgradePhase::Failed) => {
                    ctx.metrics
                        .upgrade_failed_total
                        .get_or_create(&upgrade_labels)
                        .inc();
                    let msg = new_status.message.as_deref().unwrap_or("Upgrade failed");
                    recorder.publish_warning("UpgradeFailed", msg).await;

                    // Slack: send Failed notification
                    if let Some(ref notifier) = ctx.slack
                        && notify::should_notify(spec)
                    {
                        let slack_msg = notify::build_failed_message(name, spec, &new_status, msg);
                        notifier.send(name, &slack_msg).await;
                    }
                }
                _ => {}
            }

            match requeue {
                Some(d) if d.is_zero() => Ok(Action::requeue(Duration::from_millis(100))),
                Some(d) => Ok(Action::requeue(d)),
                None => Ok(Action::await_change()),
            }
        }
        Err(e) => {
            error!("Reconcile error for {}: {}", name, e);

            // Record error metric
            let elapsed = reconcile_start.elapsed().as_secs_f64();
            ctx.metrics
                .reconcile_duration_seconds
                .get_or_create(&upgrade_labels)
                .observe(elapsed);
            ctx.metrics
                .reconcile_total
                .get_or_create(&ReconcileLabels {
                    cluster_name: spec.cluster_name.clone(),
                    region: spec.region.clone(),
                    result: "error".to_string(),
                })
                .inc();

            let mut new_status = current_status.clone();
            new_status.observed_generation = generation;

            // Determine if error is transient
            if let Some(kuo_err) = e.downcast_ref::<crate::error::KuoError>()
                && kuo_err.is_transient()
            {
                warn!("Transient error for {}, will retry: {}", name, e);
                status::set_condition(
                    &mut new_status,
                    "Ready",
                    "False",
                    "TransientError",
                    Some(e.to_string()),
                );
                let _ = status::patch_status(&api, name, &new_status).await;
                return Ok(Action::requeue(Duration::from_secs(10)));
            }

            // Permanent error → Failed
            status::set_failed(&mut new_status, e.to_string());
            ctx.metrics
                .upgrade_failed_total
                .get_or_create(&upgrade_labels)
                .inc();
            let _ = status::patch_status(&api, name, &new_status).await;
            recorder
                .publish_warning("UpgradeFailed", &e.to_string())
                .await;

            // Slack: send Failed notification (permanent error)
            if let Some(ref notifier) = ctx.slack
                && notify::should_notify(spec)
            {
                let slack_msg =
                    notify::build_failed_message(name, spec, &new_status, &e.to_string());
                notifier.send(name, &slack_msg).await;
            }

            Ok(Action::await_change())
        }
    }
}

/// Build a JSON Merge Patch that restarts a terminal `EKSUpgrade` after a spec
/// change. Resets the phase to `Pending` and explicitly nulls prior run state
/// so the planning phase re-reads the live cluster version. Fields declared
/// with `skip_serializing_if` (message, completedAt, empty collections) must be
/// set to `null`/`[]` here; a struct-based merge patch would omit them and let
/// stale values survive. The verified AWS identity is left untouched (absent
/// from the patch) to avoid a redundant STS call, and only its condition is
/// retained. `lastTransition` is likewise deliberately absent so it survives
/// the reset: the consecutive-rollback guardrail depends on it persisting
/// across spec changes. Do NOT add it to this patch.
fn reset_status_patch(current: &EKSUpgradeStatus, generation: i64) -> serde_json::Value {
    let conditions: Vec<_> = current
        .conditions
        .iter()
        .filter(|c| c.r#type == "AWSAuthenticated")
        .cloned()
        .collect();

    serde_json::json!({
        "status": {
            "phase": UpgradePhase::Pending,
            "currentVersion": null,
            "message": null,
            "startedAt": null,
            "completedAt": null,
            "lifecycle": null,
            "observedGeneration": generation,
            "conditions": conditions,
            "phases": {
                "planning": null,
                "preflight": null,
                "controlPlane": null,
                "addons": [],
                "nodegroups": [],
            },
        }
    })
}

/// Error policy for the controller.
#[allow(clippy::needless_pass_by_value)]
pub fn error_policy(obj: Arc<EKSUpgrade>, err: &kube::Error, _ctx: Arc<Context>) -> Action {
    let name = obj.metadata.name.as_deref().unwrap_or("unknown");
    error!("Controller error for {}: {}", name, err);
    Action::requeue(Duration::from_secs(30))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::{ControlPlaneStatus, UpgradeCondition};

    #[test]
    fn test_reset_status_patch() {
        let mut current = EKSUpgradeStatus {
            phase: Some(UpgradePhase::Completed),
            current_version: Some("1.34".to_string()),
            observed_generation: 3,
            message: Some("done".to_string()),
            completed_at: Some(chrono::Utc::now()),
            ..Default::default()
        };
        current.phases.control_plane = Some(ControlPlaneStatus {
            current_step: 1,
            total_steps: 1,
            ..Default::default()
        });
        current.conditions = vec![
            UpgradeCondition {
                r#type: "Ready".to_string(),
                status: "True".to_string(),
                reason: "UpgradeCompleted".to_string(),
                message: None,
                last_transition_time: chrono::Utc::now(),
            },
            UpgradeCondition {
                r#type: "AWSAuthenticated".to_string(),
                status: "True".to_string(),
                reason: "IdentityVerified".to_string(),
                message: None,
                last_transition_time: chrono::Utc::now(),
            },
        ];

        let patch = reset_status_patch(&current, 4);
        let status = &patch["status"];

        // Restarts from Pending with the new generation stamped.
        assert_eq!(status["phase"], "Pending");
        assert_eq!(status["observedGeneration"], 4);

        // Stale run state is explicitly nulled so a merge patch clears it.
        assert!(status["currentVersion"].is_null());
        assert!(status["message"].is_null());
        assert!(status["completedAt"].is_null());
        assert!(status["phases"]["controlPlane"].is_null());
        assert!(status["phases"]["planning"].is_null());
        assert_eq!(status["phases"]["addons"], serde_json::json!([]));
        assert_eq!(status["phases"]["nodegroups"], serde_json::json!([]));

        // Only the AWS auth condition is retained.
        assert_eq!(status["conditions"].as_array().unwrap().len(), 1);
        assert_eq!(status["conditions"][0]["type"], "AWSAuthenticated");

        // lastTransition must be absent from the patch so it survives the
        // merge: the consecutive-rollback guardrail depends on it persisting.
        assert!(status.get("lastTransition").is_none());
    }
}
