//! Status patch helpers, condition builders, and event recording.

use anyhow::Result;
use chrono::Utc;
use k8s_openapi::api::core::v1::ObjectReference;
use kube::Api;
use kube::Resource;
use kube::api::{Patch, PatchParams};
use kube::runtime::events::{Event, EventType, Recorder, Reporter};
use tracing::debug;

use crate::crd::{EC2Schedule, EC2ScheduleStatus, ScheduleCondition, SchedulePhase};

/// Patch the status subresource of an `EC2Schedule`.
pub async fn patch_status(
    api: &Api<EC2Schedule>,
    name: &str,
    status: &EC2ScheduleStatus,
) -> Result<EC2Schedule> {
    debug!("Patching status for {}: phase={:?}", name, status.phase);

    let patch = serde_json::json!({ "status": status });
    let result = api
        .patch_status(
            name,
            &PatchParams::apply("ec2-scheduler"),
            &Patch::Merge(&patch),
        )
        .await?;
    Ok(result)
}

/// Set the phase on a status, preserving other fields.
pub const fn set_phase(status: &mut EC2ScheduleStatus, phase: SchedulePhase) {
    status.phase = Some(phase);
}

/// Set the phase to Failed with a message.
pub fn set_failed(status: &mut EC2ScheduleStatus, message: impl Into<String>) {
    status.phase = Some(SchedulePhase::Failed);
    status.message = Some(message.into());
    set_condition(
        status,
        "Ready",
        "False",
        "ScheduleFailed",
        status.message.clone(),
    );
}

/// Set a condition on the status.
pub fn set_condition(
    status: &mut EC2ScheduleStatus,
    condition_type: &str,
    condition_status: &str,
    reason: &str,
    message: Option<String>,
) {
    let now = Utc::now();

    // Remove existing condition of same type
    status.conditions.retain(|c| c.r#type != condition_type);

    status.conditions.push(ScheduleCondition {
        r#type: condition_type.to_string(),
        status: condition_status.to_string(),
        reason: reason.to_string(),
        message,
        last_transition_time: now,
    });
}

/// Event recorder bundled with its target `ObjectReference`.
pub struct EventRecorder {
    recorder: Recorder,
    obj_ref: ObjectReference,
}

impl EventRecorder {
    /// Create an event recorder for the given `EC2Schedule` resource.
    pub fn new(client: kube::Client, obj: &EC2Schedule) -> Self {
        let reporter = Reporter {
            controller: "ec2-scheduler".into(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crd::EC2ScheduleStatus;

    #[test]
    fn test_set_phase() {
        let mut status = EC2ScheduleStatus::default();
        set_phase(&mut status, SchedulePhase::Active);
        assert_eq!(status.phase, Some(SchedulePhase::Active));
    }

    #[test]
    fn test_set_failed() {
        let mut status = EC2ScheduleStatus::default();
        set_failed(&mut status, "something broke");
        assert_eq!(status.phase, Some(SchedulePhase::Failed));
        assert_eq!(status.message.as_deref(), Some("something broke"));
    }

    #[test]
    fn test_set_failed_message_in_condition() {
        let mut status = EC2ScheduleStatus::default();
        set_failed(&mut status, "timeout exceeded");
        let cond = status
            .conditions
            .iter()
            .find(|c| c.r#type == "Ready")
            .unwrap();
        assert_eq!(cond.message.as_deref(), Some("timeout exceeded"));
        assert_eq!(cond.status, "False");
        assert_eq!(cond.reason, "ScheduleFailed");
    }

    #[test]
    fn test_set_condition_adds_new() {
        let mut status = EC2ScheduleStatus::default();
        assert!(status.conditions.is_empty());
        set_condition(&mut status, "Ready", "True", "AllGood", None);
        assert_eq!(status.conditions.len(), 1);
        assert_eq!(status.conditions[0].r#type, "Ready");
    }

    #[test]
    fn test_set_condition_replaces_existing() {
        let mut status = EC2ScheduleStatus::default();
        set_condition(&mut status, "Ready", "False", "NotReady", None);
        set_condition(
            &mut status,
            "Ready",
            "True",
            "NowReady",
            Some("ok".to_string()),
        );
        assert_eq!(status.conditions.len(), 1);
        assert_eq!(status.conditions[0].status, "True");
        assert_eq!(status.conditions[0].reason, "NowReady");
    }

    #[test]
    fn test_set_condition_preserves_other_types() {
        let mut status = EC2ScheduleStatus::default();
        set_condition(&mut status, "AWSAuthenticated", "True", "Auth", None);
        set_condition(&mut status, "Ready", "True", "Ok", None);
        assert_eq!(status.conditions.len(), 2);
        assert!(
            status
                .conditions
                .iter()
                .any(|c| c.r#type == "AWSAuthenticated")
        );
        assert!(status.conditions.iter().any(|c| c.r#type == "Ready"));
    }

    #[test]
    fn test_set_phase_paused() {
        let mut status = EC2ScheduleStatus::default();
        set_phase(&mut status, SchedulePhase::Paused);
        assert_eq!(status.phase, Some(SchedulePhase::Paused));
    }

    #[test]
    fn test_set_phase_preserves_other_fields() {
        let mut status = EC2ScheduleStatus::default();
        status.message = Some("existing message".to_string());
        status.observed_generation = 5;
        set_phase(&mut status, SchedulePhase::Active);
        assert_eq!(status.phase, Some(SchedulePhase::Active));
        assert_eq!(status.message.as_deref(), Some("existing message"));
        assert_eq!(status.observed_generation, 5);
    }

    #[test]
    fn test_set_phase_overwrite() {
        let mut status = EC2ScheduleStatus::default();
        set_phase(&mut status, SchedulePhase::Active);
        set_phase(&mut status, SchedulePhase::Paused);
        assert_eq!(status.phase, Some(SchedulePhase::Paused));
    }

    #[test]
    fn test_set_failed_creates_ready_condition() {
        let mut status = EC2ScheduleStatus::default();
        set_failed(&mut status, "error");
        assert_eq!(status.conditions.len(), 1);
        assert_eq!(status.conditions[0].r#type, "Ready");
        assert_eq!(status.conditions[0].status, "False");
    }

    #[test]
    fn test_set_condition_last_transition_time_is_recent() {
        let mut status = EC2ScheduleStatus::default();
        set_condition(&mut status, "Ready", "True", "Ok", None);
        let elapsed =
            chrono::Utc::now().signed_duration_since(&status.conditions[0].last_transition_time);
        assert!(elapsed.num_seconds() < 2);
    }
}
