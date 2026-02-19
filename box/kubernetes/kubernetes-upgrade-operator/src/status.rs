//! Status patch helpers, condition builders, and event recording.

use anyhow::Result;
use chrono::Utc;
use k8s_openapi::api::core::v1::ObjectReference;
use kube::Api;
use kube::Resource;
use kube::api::{Patch, PatchParams};
use kube::runtime::events::{Event, EventType, Recorder, Reporter};
use tracing::debug;

use crate::crd::{EKSUpgrade, EKSUpgradeStatus, UpgradeCondition, UpgradePhase};

/// Patch the status subresource of an EKSUpgrade.
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

/// Event recorder bundled with its target ObjectReference.
pub struct EventRecorder {
    recorder: Recorder,
    obj_ref: ObjectReference,
}

impl EventRecorder {
    /// Create an event recorder for the given EKSUpgrade resource.
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
