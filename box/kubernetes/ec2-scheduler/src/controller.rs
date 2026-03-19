//! `EC2Schedule` controller - reconcile dispatch and error policy.

use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::Utc;
use kube::Api;
use kube::runtime::controller::Action;
use tracing::{error, info, warn};

use crate::aws::AwsClients;
use crate::crd::{EC2Schedule, ScheduleAction, SchedulePhase};
use crate::notify::{self, SlackNotifier};
use crate::scheduler::{self, ActionToExecute};
use crate::status;
use crate::telemetry::metrics::{
    ActionLabels, InstanceLabels, Metrics, NextActionLabels, ReconcileDurationLabels,
    ReconcileLabels, ScheduleInfoLabels,
};

/// Shared context for the controller.
pub struct Context {
    pub kube_client: kube::Client,
    pub metrics: Arc<Metrics>,
    /// Slack notifier. `None` when `SLACK_WEBHOOK_URL` is not set.
    pub slack: Option<Arc<SlackNotifier>>,
}

/// Reconcile an `EC2Schedule` resource.
///
/// Evaluates cron schedules against the current time and executes start/stop
/// actions on matching EC2 instances. Requeues every 30 seconds.
#[allow(clippy::too_many_lines)]
pub async fn reconcile(obj: Arc<EC2Schedule>, ctx: Arc<Context>) -> Result<Action, kube::Error> {
    let name = obj.metadata.name.as_deref().unwrap_or("unknown");
    let namespace = obj.metadata.namespace.as_deref().unwrap_or("default");

    let api: Api<EC2Schedule> = Api::namespaced(ctx.kube_client.clone(), namespace);

    let spec = &obj.spec;
    let current_status = obj.status.clone().unwrap_or_default();
    let phase = current_status
        .phase
        .clone()
        .unwrap_or(SchedulePhase::Pending);

    let generation = obj.metadata.generation.unwrap_or(0);

    // Skip terminal phase (Failed)
    if phase == SchedulePhase::Failed {
        if current_status.observed_generation < generation {
            warn!(
                "Spec changed for {} but phase is Failed. Delete and recreate the EC2Schedule resource to retry.",
                name
            );
        }
        return Ok(Action::await_change());
    }

    info!("Reconciling {} (phase: {})", name, phase);

    // Pre-initialize metrics
    ctx.metrics.init_for_schedule(name);

    let reconcile_start = Instant::now();
    let recorder = status::EventRecorder::new(ctx.kube_client.clone(), &obj);

    // Validate: at least one of instanceIds or tags must be set in instanceSelector
    if spec.instance_selector.instance_ids.is_empty() && spec.instance_selector.tags.is_empty() {
        let msg = "instanceSelector must define at least one of instanceIds or tags";
        error!("Validation failed for {}: {}", name, msg);
        let mut new_status = current_status.clone();
        status::set_failed(&mut new_status, msg);
        new_status.observed_generation = generation;
        let _ = status::patch_status(&api, name, &new_status).await;
        recorder.publish_warning("ValidationFailed", msg).await;
        return Ok(Action::await_change());
    }

    // Validate schedules and timezone
    if let Err(e) = scheduler::validate_schedules(&spec.schedules, &spec.timezone) {
        error!("Validation failed for {}: {}", name, e);
        let mut new_status = current_status.clone();
        status::set_failed(&mut new_status, format!("Validation error: {e}"));
        new_status.observed_generation = generation;
        let _ = status::patch_status(&api, name, &new_status).await;
        recorder
            .publish_warning("ValidationFailed", &e.to_string())
            .await;
        return Ok(Action::await_change());
    }

    // Handle paused=true → Paused
    if spec.paused {
        if phase != SchedulePhase::Paused {
            info!("Schedule {} is paused", name);
            let mut new_status = current_status.clone();
            status::set_phase(&mut new_status, SchedulePhase::Paused);
            new_status.message = Some("Schedule is paused".to_string());
            new_status.observed_generation = generation;
            status::set_condition(
                &mut new_status,
                "Ready",
                "False",
                "SchedulePaused",
                Some("spec.paused is true".to_string()),
            );
            let _ = status::patch_status(&api, name, &new_status).await;
            recorder
                .publish("SchedulePaused", "Schedule paused by user")
                .await;
        }
        record_reconcile_metrics(&ctx.metrics, name, reconcile_start, "success");
        return Ok(Action::requeue(Duration::from_secs(60)));
    }

    // Create AWS clients
    let aws = match AwsClients::new(&spec.region, spec.assume_role_arn.as_deref()).await {
        Ok(c) => c,
        Err(e) => {
            error!("Failed to create AWS clients for {}: {}", name, e);
            let mut new_status = current_status.clone();
            status::set_failed(&mut new_status, format!("AWS client error: {e}"));
            new_status.observed_generation = generation;
            let _ = status::patch_status(&api, name, &new_status).await;
            record_reconcile_metrics(&ctx.metrics, name, reconcile_start, "error");
            return Ok(Action::requeue(Duration::from_secs(60)));
        }
    };

    // Resolve instance IDs (explicit IDs or tag-based selector)
    let instance_ids = match resolve_instances(spec, &aws).await {
        Ok(ids) => ids,
        Err(e) => {
            warn!("Failed to resolve instances for {}: {}", name, e);
            let mut new_status = current_status.clone();
            new_status.observed_generation = generation;
            status::set_condition(
                &mut new_status,
                "Ready",
                "False",
                "InstanceResolutionFailed",
                Some(e.to_string()),
            );
            new_status.message = Some(format!("Instance resolution failed: {e}"));
            let _ = status::patch_status(&api, name, &new_status).await;
            record_reconcile_metrics(&ctx.metrics, name, reconcile_start, "error");
            return Ok(Action::requeue(Duration::from_secs(30)));
        }
    };

    if instance_ids.is_empty() {
        warn!("No instances found for schedule {}", name);
        let mut new_status = current_status.clone();
        status::set_phase(&mut new_status, SchedulePhase::Active);
        new_status.message = Some("No matching instances found".to_string());
        new_status.observed_generation = generation;
        let _ = status::patch_status(&api, name, &new_status).await;
        record_reconcile_metrics(&ctx.metrics, name, reconcile_start, "success");
        return Ok(Action::requeue(Duration::from_secs(30)));
    }

    // Describe instances first to capture Name tags for event messages
    let described = aws
        .describe_instances(&instance_ids)
        .await
        .unwrap_or_default();

    // Build display string: "name/id" when Name tag exists, otherwise "id"
    let display_names: String = described
        .iter()
        .map(crate::crd::ManagedInstance::display_name)
        .collect::<Vec<_>>()
        .join(", ");

    // Determine if an action should execute now
    let window = chrono::Duration::seconds(45); // slightly larger than reconcile interval
    let action = scheduler::should_execute_now(
        &spec.schedules,
        &spec.timezone,
        current_status.last_action_time,
        window,
    );

    let mut new_status = current_status.clone();
    new_status.observed_generation = generation;
    status::set_phase(&mut new_status, SchedulePhase::Active);

    // Execute action if needed
    if let Some(action_to_exec) = action {
        let (action_name, action_type) = match &action_to_exec {
            ActionToExecute::Start(name) => (name.clone(), ScheduleAction::Start),
            ActionToExecute::Stop(name) => (name.clone(), ScheduleAction::Stop),
        };

        if spec.dry_run {
            info!(
                "[dry-run] Would {} instances {:?} for schedule {} (entry: {})",
                action_type, instance_ids, name, action_name
            );
            recorder
                .publish(
                    "DryRun",
                    &format!(
                        "Dry-run: would {action_type} {n} instance(s): {display_names}",
                        n = instance_ids.len(),
                    ),
                )
                .await;
        } else {
            let result = match &action_to_exec {
                ActionToExecute::Start(_) => aws.start_instances(&instance_ids).await,
                ActionToExecute::Stop(_) => aws.stop_instances(&instance_ids).await,
            };

            match result {
                Ok(()) => {
                    info!(
                        "{} {} instance(s) for schedule {} (entry: {})",
                        action_type,
                        instance_ids.len(),
                        name,
                        action_name
                    );
                    ctx.metrics
                        .actions_total
                        .get_or_create(&ActionLabels {
                            schedule: name.to_string(),
                            action: action_type.to_string(),
                            result: "success".to_string(),
                        })
                        .inc();
                    recorder
                        .publish(
                            &format!("Instances{action_type}ed"),
                            &format!(
                                "{action_type}ed {n} instance(s): {display_names}",
                                n = instance_ids.len(),
                            ),
                        )
                        .await;

                    // Slack notification
                    if let Some(ref notifier) = ctx.slack {
                        let msg = notify::build_action_message(
                            name,
                            &action_type,
                            &spec.region,
                            &described,
                        );
                        notifier.send(name, &msg).await;
                    }
                }
                Err(e) => {
                    error!("Failed to {} instances for {}: {}", action_type, name, e);
                    ctx.metrics
                        .actions_total
                        .get_or_create(&ActionLabels {
                            schedule: name.to_string(),
                            action: action_type.to_string(),
                            result: "error".to_string(),
                        })
                        .inc();
                    recorder
                        .publish_warning(
                            &format!("{action_type}Failed"),
                            &format!(
                                "Failed to {action_type} {n} instance(s): {display_names}: {e}",
                                n = instance_ids.len(),
                            ),
                        )
                        .await;

                    // Slack notification
                    if let Some(ref notifier) = ctx.slack {
                        let msg = notify::build_failed_message(
                            name,
                            &action_type,
                            &spec.region,
                            &described,
                            &e.to_string(),
                        );
                        notifier.send(name, &msg).await;
                    }

                    new_status.message = Some(format!("Failed to {action_type} instances: {e}"));
                    new_status.observed_generation = generation;
                    let _ = status::patch_status(&api, name, &new_status).await;
                    record_reconcile_metrics(&ctx.metrics, name, reconcile_start, "error");
                    return Ok(Action::requeue(Duration::from_secs(30)));
                }
            }
        }

        new_status.last_action = Some(action_type);
        new_status.last_action_time = Some(Utc::now());
    }

    // Update status from described instances
    {
        let instances = described;
        let mut running = 0i32;
        let mut stopped = 0i32;
        for inst in &instances {
            match inst.state.as_str() {
                "running" => running += 1,
                "stopped" => stopped += 1,
                _ => {}
            }
        }

        // Update status counts
        new_status.running_count = running;
        new_status.stopped_count = stopped;
        new_status.managed_instances = instances;

        // Update Prometheus gauge metrics
        ctx.metrics
            .managed_instances
            .get_or_create(&InstanceLabels {
                schedule: name.to_string(),
                region: spec.region.clone(),
                state: "running".to_string(),
            })
            .set(i64::from(running));
        ctx.metrics
            .managed_instances
            .get_or_create(&InstanceLabels {
                schedule: name.to_string(),
                region: spec.region.clone(),
                state: "stopped".to_string(),
            })
            .set(i64::from(stopped));
    }

    // Calculate next occurrences
    let (next_start, next_stop) = scheduler::next_occurrences(&spec.schedules, &spec.timezone);
    new_status.next_start_time = next_start;
    new_status.next_stop_time = next_stop;

    // Update next-action gauge metrics
    let now = Utc::now();
    if let Some(ns) = next_start {
        let secs = (ns - now).num_seconds().max(0);
        ctx.metrics
            .next_action_seconds
            .get_or_create(&NextActionLabels {
                schedule: name.to_string(),
                action: "Start".to_string(),
            })
            .set(secs);
    }
    if let Some(ns) = next_stop {
        let secs = (ns - now).num_seconds().max(0);
        ctx.metrics
            .next_action_seconds
            .get_or_create(&NextActionLabels {
                schedule: name.to_string(),
                action: "Stop".to_string(),
            })
            .set(secs);
    }

    // Update schedule info gauge
    ctx.metrics
        .schedule_info
        .get_or_create(&ScheduleInfoLabels {
            schedule: name.to_string(),
            timezone: spec.timezone.clone(),
            paused: spec.paused.to_string(),
        })
        .set(1);

    // Set Ready condition
    status::set_condition(
        &mut new_status,
        "Ready",
        "True",
        "ScheduleActive",
        Some(format!("Managing {} instance(s)", instance_ids.len())),
    );
    new_status.message = None;

    if let Err(e) = status::patch_status(&api, name, &new_status).await {
        warn!("Failed to patch status for {}: {}", name, e);
        record_reconcile_metrics(&ctx.metrics, name, reconcile_start, "error");
        return Ok(Action::requeue(Duration::from_secs(5)));
    }

    record_reconcile_metrics(&ctx.metrics, name, reconcile_start, "requeue");
    Ok(Action::requeue(Duration::from_secs(30)))
}

/// Resolve EC2 instance IDs from `instanceSelector` (explicit IDs + tag filter).
async fn resolve_instances(
    spec: &crate::crd::EC2ScheduleSpec,
    aws: &AwsClients,
) -> Result<Vec<String>> {
    let selector = &spec.instance_selector;
    let mut ids = selector.instance_ids.clone();

    if !selector.tags.is_empty() {
        let tag_ids = aws.resolve_instances_by_tags(&selector.tags).await?;
        ids.extend(tag_ids);
    }

    // Deduplicate
    ids.sort();
    ids.dedup();

    Ok(ids)
}

/// Record reconcile duration and result metrics.
fn record_reconcile_metrics(metrics: &Metrics, name: &str, start: Instant, result: &str) {
    let elapsed = start.elapsed().as_secs_f64();
    metrics
        .reconcile_duration_seconds
        .get_or_create(&ReconcileDurationLabels {
            schedule: name.to_string(),
        })
        .observe(elapsed);
    metrics
        .reconcile_total
        .get_or_create(&ReconcileLabels {
            schedule: name.to_string(),
            result: result.to_string(),
        })
        .inc();
}

/// Error policy for the controller.
#[allow(clippy::needless_pass_by_value)]
pub fn error_policy(obj: Arc<EC2Schedule>, err: &kube::Error, _ctx: Arc<Context>) -> Action {
    let name = obj.metadata.name.as_deref().unwrap_or("unknown");
    error!("Controller error for {}: {}", name, err);
    Action::requeue(Duration::from_secs(30))
}
