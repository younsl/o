//! `EC2Schedule` status types.

use chrono::{DateTime, Utc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::types::{ScheduleAction, SchedulePhase};

/// Status of a managed EC2 instance.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ManagedInstance {
    /// EC2 instance ID.
    pub instance_id: String,

    /// EC2 Name tag value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,

    /// Current EC2 instance state (running, stopped, etc.).
    pub state: String,

    /// Last time the instance transitioned state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_transition_time: Option<DateTime<Utc>>,
}

impl ManagedInstance {
    /// Format as `name/id` if Name tag exists, otherwise just `id`.
    pub fn display_name(&self) -> String {
        match &self.name {
            Some(n) if !n.is_empty() => format!("{n}/{}", self.instance_id),
            _ => self.instance_id.clone(),
        }
    }
}

/// Condition on the `EC2Schedule` resource.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleCondition {
    pub r#type: String,
    pub status: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub last_transition_time: DateTime<Utc>,
}

/// `EC2Schedule` status defines the observed state of the schedule.
#[derive(Deserialize, Serialize, Clone, Debug, Default, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EC2ScheduleStatus {
    /// Current phase of the schedule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<SchedulePhase>,

    /// Last action performed (Start or Stop).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_action: Option<ScheduleAction>,

    /// Timestamp of the last action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_action_time: Option<DateTime<Utc>>,

    /// Next scheduled start time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_start_time: Option<DateTime<Utc>>,

    /// Next scheduled stop time.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_stop_time: Option<DateTime<Utc>>,

    /// Number of running instances.
    #[serde(default)]
    pub running_count: i32,

    /// Number of stopped instances.
    #[serde(default)]
    pub stopped_count: i32,

    /// List of managed EC2 instances.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub managed_instances: Vec<ManagedInstance>,

    /// Conditions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub conditions: Vec<ScheduleCondition>,

    /// Last observed generation of the spec.
    #[serde(default)]
    pub observed_generation: i64,

    /// Human-readable message about the current state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_status_default() {
        let status = EC2ScheduleStatus::default();
        assert!(status.phase.is_none());
        assert!(status.last_action.is_none());
        assert!(status.last_action_time.is_none());
        assert!(status.next_start_time.is_none());
        assert!(status.next_stop_time.is_none());
        assert!(status.managed_instances.is_empty());
        assert!(status.conditions.is_empty());
        assert_eq!(status.observed_generation, 0);
        assert!(status.message.is_none());
    }

    #[test]
    fn test_managed_instance_fields() {
        let now = chrono::Utc::now();
        let instance = ManagedInstance {
            instance_id: "i-1234567890abcdef0".to_string(),
            name: Some("web-server".to_string()),
            state: "running".to_string(),
            last_transition_time: Some(now),
        };
        assert_eq!(instance.instance_id, "i-1234567890abcdef0");
        assert_eq!(instance.name.as_deref(), Some("web-server"));
        assert_eq!(instance.state, "running");
        assert_eq!(instance.last_transition_time, Some(now));
    }

    #[test]
    fn test_display_name_with_name_tag() {
        let inst = ManagedInstance {
            instance_id: "i-abc".to_string(),
            name: Some("web-server".to_string()),
            state: "running".to_string(),
            last_transition_time: None,
        };
        assert_eq!(inst.display_name(), "web-server/i-abc");
    }

    #[test]
    fn test_display_name_without_name_tag() {
        let inst = ManagedInstance {
            instance_id: "i-abc".to_string(),
            name: None,
            state: "running".to_string(),
            last_transition_time: None,
        };
        assert_eq!(inst.display_name(), "i-abc");
    }

    #[test]
    fn test_display_name_empty_name_tag() {
        let inst = ManagedInstance {
            instance_id: "i-abc".to_string(),
            name: Some(String::new()),
            state: "running".to_string(),
            last_transition_time: None,
        };
        assert_eq!(inst.display_name(), "i-abc");
    }

    #[test]
    fn test_schedule_condition_fields() {
        let now = chrono::Utc::now();
        let cond = ScheduleCondition {
            r#type: "Ready".to_string(),
            status: "True".to_string(),
            reason: "ScheduleActive".to_string(),
            message: Some("Schedule is active".to_string()),
            last_transition_time: now,
        };
        assert_eq!(cond.r#type, "Ready");
        assert_eq!(cond.status, "True");
        assert_eq!(cond.reason, "ScheduleActive");
        assert_eq!(cond.message.as_deref(), Some("Schedule is active"));
        assert_eq!(cond.last_transition_time, now);
    }

    #[test]
    fn test_status_serialization_roundtrip() {
        let status = EC2ScheduleStatus {
            phase: Some(SchedulePhase::Active),
            last_action: Some(ScheduleAction::Start),
            ..Default::default()
        };
        let json = serde_json::to_string(&status).unwrap();
        let deserialized: EC2ScheduleStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.phase, Some(SchedulePhase::Active));
        assert_eq!(deserialized.last_action, Some(ScheduleAction::Start));
    }

    #[test]
    fn test_status_empty_fields_skipped() {
        let status = EC2ScheduleStatus::default();
        let json = serde_json::to_value(&status).unwrap();
        let obj = json.as_object().unwrap();
        assert!(!obj.contains_key("phase"));
        assert!(!obj.contains_key("lastAction"));
        assert!(!obj.contains_key("lastActionTime"));
        assert!(!obj.contains_key("nextStartTime"));
        assert!(!obj.contains_key("nextStopTime"));
        assert!(!obj.contains_key("managedInstances"));
        assert!(!obj.contains_key("conditions"));
        assert!(!obj.contains_key("message"));
    }
}
