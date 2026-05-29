//! Enum types for upgrade phases and component statuses.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Phase of the upgrade process.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub enum UpgradePhase {
    Pending,
    Planning,
    PreflightChecking,
    UpgradingControlPlane,
    UpgradingAddons,
    UpgradingNodeGroups,
    Completed,
    Failed,
}

impl std::fmt::Display for UpgradePhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pending => write!(f, "Pending"),
            Self::Planning => write!(f, "Planning"),
            Self::PreflightChecking => write!(f, "PreflightChecking"),
            Self::UpgradingControlPlane => write!(f, "UpgradingControlPlane"),
            Self::UpgradingAddons => write!(f, "UpgradingAddons"),
            Self::UpgradingNodeGroups => write!(f, "UpgradingNodeGroups"),
            Self::Completed => write!(f, "Completed"),
            Self::Failed => write!(f, "Failed"),
        }
    }
}

/// Status of a component upgrade.
#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Eq, JsonSchema)]
pub enum ComponentStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Skipped,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_upgrade_phase_display() {
        assert_eq!(UpgradePhase::Pending.to_string(), "Pending");
        assert_eq!(
            UpgradePhase::UpgradingControlPlane.to_string(),
            "UpgradingControlPlane"
        );
        assert_eq!(UpgradePhase::Completed.to_string(), "Completed");
        assert_eq!(UpgradePhase::Failed.to_string(), "Failed");
    }

    #[test]
    fn test_component_status_equality() {
        assert_eq!(ComponentStatus::Pending, ComponentStatus::Pending);
        assert_eq!(ComponentStatus::InProgress, ComponentStatus::InProgress);
        assert_eq!(ComponentStatus::Completed, ComponentStatus::Completed);
        assert_eq!(ComponentStatus::Failed, ComponentStatus::Failed);
        assert_eq!(ComponentStatus::Skipped, ComponentStatus::Skipped);
        assert_ne!(ComponentStatus::Pending, ComponentStatus::Completed);
    }

    #[test]
    fn test_component_status_all_variants() {
        let variants = [
            ComponentStatus::Pending,
            ComponentStatus::InProgress,
            ComponentStatus::Completed,
            ComponentStatus::Failed,
            ComponentStatus::Skipped,
        ];
        assert_eq!(variants.len(), 5);
    }

    #[test]
    fn test_upgrade_phase_all_variants() {
        let variants = [
            UpgradePhase::Pending,
            UpgradePhase::Planning,
            UpgradePhase::PreflightChecking,
            UpgradePhase::UpgradingControlPlane,
            UpgradePhase::UpgradingAddons,
            UpgradePhase::UpgradingNodeGroups,
            UpgradePhase::Completed,
            UpgradePhase::Failed,
        ];
        let displays: Vec<String> = variants.iter().map(|v| v.to_string()).collect();
        assert_eq!(displays.len(), 8);
        assert!(displays.contains(&"Pending".to_string()));
        assert!(displays.contains(&"Planning".to_string()));
        assert!(displays.contains(&"PreflightChecking".to_string()));
        assert!(displays.contains(&"UpgradingControlPlane".to_string()));
        assert!(displays.contains(&"UpgradingAddons".to_string()));
        assert!(displays.contains(&"UpgradingNodeGroups".to_string()));
        assert!(displays.contains(&"Completed".to_string()));
        assert!(displays.contains(&"Failed".to_string()));
    }
}
