//! Enum types for schedule phases and actions.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Phase of the schedule lifecycle.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub enum SchedulePhase {
    Pending,
    Active,
    Paused,
    Failed,
}

impl std::fmt::Display for SchedulePhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "Pending"),
            Self::Active => write!(f, "Active"),
            Self::Paused => write!(f, "Paused"),
            Self::Failed => write!(f, "Failed"),
        }
    }
}

/// Action performed on EC2 instances.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub enum ScheduleAction {
    Start,
    Stop,
}

impl std::fmt::Display for ScheduleAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Start => write!(f, "Start"),
            Self::Stop => write!(f, "Stop"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_schedule_phase_display() {
        assert_eq!(SchedulePhase::Pending.to_string(), "Pending");
        assert_eq!(SchedulePhase::Active.to_string(), "Active");
        assert_eq!(SchedulePhase::Paused.to_string(), "Paused");
        assert_eq!(SchedulePhase::Failed.to_string(), "Failed");
    }

    #[test]
    fn test_schedule_phase_equality() {
        assert_eq!(SchedulePhase::Pending, SchedulePhase::Pending);
        assert_ne!(SchedulePhase::Pending, SchedulePhase::Active);
    }

    #[test]
    fn test_schedule_phase_all_variants() {
        let variants = [
            SchedulePhase::Pending,
            SchedulePhase::Active,
            SchedulePhase::Paused,
            SchedulePhase::Failed,
        ];
        let displays: Vec<String> = variants.iter().map(|v| v.to_string()).collect();
        assert_eq!(displays.len(), 4);
        assert!(displays.contains(&"Pending".to_string()));
        assert!(displays.contains(&"Active".to_string()));
        assert!(displays.contains(&"Paused".to_string()));
        assert!(displays.contains(&"Failed".to_string()));
    }

    #[test]
    fn test_schedule_action_display() {
        assert_eq!(ScheduleAction::Start.to_string(), "Start");
        assert_eq!(ScheduleAction::Stop.to_string(), "Stop");
    }

    #[test]
    fn test_schedule_action_equality() {
        assert_eq!(ScheduleAction::Start, ScheduleAction::Start);
        assert_ne!(ScheduleAction::Start, ScheduleAction::Stop);
    }
}
