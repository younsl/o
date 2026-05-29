//! Common types for EKS upgrade operations.

/// Generic result of upgrade planning.
#[derive(Debug, Clone)]
pub struct PlanResult<U> {
    /// Resources that need to be upgraded (with target version for addons).
    pub upgrades: Vec<U>,
    /// Number of resources skipped.
    skipped: usize,
}

impl<U> PlanResult<U> {
    pub const fn new() -> Self {
        Self {
            upgrades: Vec::new(),
            skipped: 0,
        }
    }

    pub fn add_upgrade(&mut self, upgrade: U) {
        self.upgrades.push(upgrade);
    }

    pub const fn add_skipped(&mut self) {
        self.skipped += 1;
    }

    pub const fn upgrade_count(&self) -> usize {
        self.upgrades.len()
    }

    pub const fn skipped_count(&self) -> usize {
        self.skipped
    }
}

impl<U> Default for PlanResult<U> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_plan_result() {
        let mut result: PlanResult<String> = PlanResult::new();

        result.add_upgrade("r1".to_string());
        result.add_skipped();

        assert_eq!(result.upgrade_count(), 1);
        assert_eq!(result.skipped_count(), 1);
    }

    #[test]
    fn test_plan_result_default() {
        let result: PlanResult<String> = PlanResult::default();
        assert_eq!(result.upgrade_count(), 0);
        assert_eq!(result.skipped_count(), 0);
    }

    #[test]
    fn test_plan_result_empty() {
        let result: PlanResult<String> = PlanResult::new();
        assert_eq!(result.upgrade_count(), 0);
        assert_eq!(result.skipped_count(), 0);
        assert!(result.upgrades.is_empty());
    }

    #[test]
    fn test_plan_result_multiple_upgrades() {
        let mut result: PlanResult<String> = PlanResult::new();

        for i in 0..5 {
            result.add_upgrade(format!("r{}", i));
        }

        assert_eq!(result.upgrade_count(), 5);
        assert_eq!(result.skipped_count(), 0);
    }
}
