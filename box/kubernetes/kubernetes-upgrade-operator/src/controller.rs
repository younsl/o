//! EKSUpgrade controller - reconcile dispatch and error policy.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use kube::Api;
use kube::runtime::controller::Action;
use tracing::{error, info, warn};

use crate::aws::AwsClients;
use crate::crd::{EKSUpgrade, UpgradePhase};
use crate::phases;
use crate::status;

/// Shared context for the controller.
pub struct Context {
    pub kube_client: kube::Client,
}

/// Reconcile an EKSUpgrade resource.
///
/// Phase-based state machine: reads current phase, executes one step, patches status.
pub async fn reconcile(obj: Arc<EKSUpgrade>, ctx: Arc<Context>) -> Result<Action, kube::Error> {
    let name = obj.metadata.name.as_deref().unwrap_or("unknown");

    let api: Api<EKSUpgrade> = Api::all(ctx.kube_client.clone());

    let spec = &obj.spec;
    let current_status = obj.status.clone().unwrap_or_default();
    let phase = current_status
        .phase
        .clone()
        .unwrap_or(UpgradePhase::Pending);

    // Skip terminal phases
    if phase == UpgradePhase::Completed || phase == UpgradePhase::Failed {
        return Ok(Action::await_change());
    }

    // Check generation to avoid re-processing
    let generation = obj.metadata.generation.unwrap_or(0);
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
            UpgradePhase::UpgradingControlPlane
                | UpgradePhase::UpgradingAddons
                | UpgradePhase::UpgradingNodeGroups
        ) {
            return Ok(Action::await_change());
        }
    }

    info!("Reconciling {} (phase: {})", name, phase);

    let recorder = status::EventRecorder::new(ctx.kube_client.clone(), &obj);

    // Create AWS clients for the target region (with optional cross-account AssumeRole)
    let aws = match AwsClients::new(&spec.region, spec.assume_role_arn.as_deref()).await {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to create AWS clients for {}: {}", spec.region, e);
            let mut new_status = current_status.clone();
            status::set_failed(&mut new_status, format!("AWS client error: {}", e));
            status::set_condition(
                &mut new_status,
                "AWSAuthenticated",
                "False",
                "AuthenticationFailed",
                Some(e.to_string()),
            );
            new_status.observed_generation = generation;
            let _ = status::patch_status(&api, name, &new_status).await;
            return Ok(Action::requeue(Duration::from_secs(60)));
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
                status::set_failed(&mut new_status, format!("AWS authentication failed: {}", e));
                status::set_condition(
                    &mut new_status,
                    "AWSAuthenticated",
                    "False",
                    "IdentityVerificationFailed",
                    Some(e.to_string()),
                );
                new_status.observed_generation = generation;
                let _ = status::patch_status(&api, name, &new_status).await;
                return Ok(Action::requeue(Duration::from_secs(60)));
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
        UpgradePhase::UpgradingControlPlane => {
            phases::control_plane::execute(spec, &current_status, &aws).await
        }
        UpgradePhase::UpgradingAddons => phases::addons::execute(spec, &current_status, &aws).await,
        UpgradePhase::UpgradingNodeGroups => {
            phases::nodegroups::execute(spec, &current_status, &aws).await
        }
        UpgradePhase::Completed | UpgradePhase::Failed => {
            return Ok(Action::await_change());
        }
    };

    match result {
        Ok((mut new_status, requeue)) => {
            new_status.observed_generation = generation;

            if let Err(e) = status::patch_status(&api, name, &new_status).await {
                warn!("Failed to patch status for {}: {}", name, e);
                return Ok(Action::requeue(Duration::from_secs(5)));
            }

            // Emit event on terminal phase
            match new_status.phase {
                Some(UpgradePhase::Completed) => {
                    let msg = new_status
                        .message
                        .as_deref()
                        .unwrap_or("Upgrade completed successfully");
                    recorder.publish("UpgradeCompleted", msg).await;
                }
                Some(UpgradePhase::Failed) => {
                    let msg = new_status.message.as_deref().unwrap_or("Upgrade failed");
                    recorder.publish_warning("UpgradeFailed", msg).await;
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
            let _ = status::patch_status(&api, name, &new_status).await;
            recorder
                .publish_warning("UpgradeFailed", &e.to_string())
                .await;
            Ok(Action::await_change())
        }
    }
}

/// Error policy for the controller.
pub fn error_policy(obj: Arc<EKSUpgrade>, err: &kube::Error, _ctx: Arc<Context>) -> Action {
    let name = obj.metadata.name.as_deref().unwrap_or("unknown");
    error!("Controller error for {}: {}", name, err);
    Action::requeue(Duration::from_secs(30))
}
