//! Common types and traits for EKS upgrade operations.

/// Trait for resources that have a name and version.
pub trait VersionedResource: Clone {
    /// Returns the resource name.
    fn name(&self) -> &str;

    /// Returns the current version.
    fn current_version(&self) -> &str;
}

/// Generic skipped resource with reason.
#[derive(Debug, Clone)]
pub struct Skipped<T: VersionedResource> {
    pub info: T,
    pub reason: String,
}

impl<T: VersionedResource> Skipped<T> {
    pub fn new(info: T, reason: impl Into<String>) -> Self {
        Self {
            info,
            reason: reason.into(),
        }
    }
}

/// Generic result of upgrade planning.
#[derive(Debug, Clone)]
pub struct PlanResult<T: VersionedResource, U = T> {
    /// Resources that need to be upgraded (with target version for addons).
    pub upgrades: Vec<U>,
    /// Resources that were skipped with reason.
    pub skipped: Vec<Skipped<T>>,
}

impl<T: VersionedResource, U> PlanResult<T, U> {
    pub fn new() -> Self {
        Self {
            upgrades: Vec::new(),
            skipped: Vec::new(),
        }
    }

    pub fn add_upgrade(&mut self, upgrade: U) {
        self.upgrades.push(upgrade);
    }

    pub fn add_skipped(&mut self, info: T, reason: impl Into<String>) {
        self.skipped.push(Skipped::new(info, reason));
    }

    pub fn upgrade_count(&self) -> usize {
        self.upgrades.len()
    }

    pub fn skipped_count(&self) -> usize {
        self.skipped.len()
    }
}

impl<T: VersionedResource, U> Default for PlanResult<T, U> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone)]
    struct TestResource {
        name: String,
        version: String,
    }

    impl VersionedResource for TestResource {
        fn name(&self) -> &str {
            &self.name
        }

        fn current_version(&self) -> &str {
            &self.version
        }
    }

    #[test]
    fn test_skipped_creation() {
        let resource = TestResource {
            name: "test".to_string(),
            version: "1.0".to_string(),
        };
        let skipped = Skipped::new(resource, "test reason");

        assert_eq!(skipped.info.name(), "test");
        assert_eq!(skipped.reason, "test reason");
    }

    #[test]
    fn test_plan_result() {
        let mut result: PlanResult<TestResource> = PlanResult::new();

        let resource1 = TestResource {
            name: "r1".to_string(),
            version: "1.0".to_string(),
        };
        let resource2 = TestResource {
            name: "r2".to_string(),
            version: "1.0".to_string(),
        };

        result.add_upgrade(resource1.clone());
        result.add_skipped(resource2, "already up to date");

        assert_eq!(result.upgrade_count(), 1);
        assert_eq!(result.skipped_count(), 1);
    }

    #[test]
    fn test_plan_result_default() {
        let result: PlanResult<TestResource> = PlanResult::default();
        assert_eq!(result.upgrade_count(), 0);
        assert_eq!(result.skipped_count(), 0);
    }

    #[test]
    fn test_plan_result_empty() {
        let result: PlanResult<TestResource> = PlanResult::new();
        assert_eq!(result.upgrade_count(), 0);
        assert_eq!(result.skipped_count(), 0);
        assert!(result.upgrades.is_empty());
        assert!(result.skipped.is_empty());
    }

    #[test]
    fn test_plan_result_multiple_upgrades() {
        let mut result: PlanResult<TestResource> = PlanResult::new();

        for i in 0..5 {
            result.add_upgrade(TestResource {
                name: format!("r{}", i),
                version: "1.0".to_string(),
            });
        }

        assert_eq!(result.upgrade_count(), 5);
        assert_eq!(result.skipped_count(), 0);
    }

    #[test]
    fn test_skipped_reason_from_string() {
        let resource = TestResource {
            name: "test".to_string(),
            version: "1.0".to_string(),
        };
        let reason = String::from("dynamically built reason");
        let skipped = Skipped::new(resource, reason);
        assert_eq!(skipped.reason, "dynamically built reason");
    }
}
