//! Preflight check types and results for EKS upgrade validation.

use crate::eks::insights::InsightsSummary;
use crate::k8s::pdb::PdbSummary;

/// Category of a preflight check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckCategory {
    Mandatory,
}

/// Status of a preflight check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckStatus {
    Pass,
    Fail,
}

/// A single preflight check result.
#[derive(Debug, Clone)]
pub struct PreflightCheckResult {
    pub name: &'static str,
    pub category: CheckCategory,
    pub status: CheckStatus,
    pub summary: String,
}

/// A preflight check that was skipped.
#[derive(Debug, Clone)]
pub struct SkippedCheck {
    pub name: &'static str,
    pub reason: String,
}

/// Aggregated results of all preflight checks.
#[derive(Debug, Clone, Default)]
pub struct PreflightResults {
    pub checks: Vec<PreflightCheckResult>,
    pub skipped: Vec<SkippedCheck>,
}

// ============================================================================
// Builder functions
// ============================================================================

impl PreflightCheckResult {
    /// Build a deletion protection check result.
    pub fn deletion_protection(enabled: bool) -> Self {
        let (status, summary) = if enabled {
            (CheckStatus::Pass, "Deletion protection is enabled".into())
        } else {
            (CheckStatus::Fail, "Deletion protection is disabled".into())
        };
        Self {
            name: "EKS Deletion Protection",
            category: CheckCategory::Mandatory,
            status,
            summary,
        }
    }

    /// Build an EKS Cluster Insights check result.
    pub fn cluster_insights(summary: &InsightsSummary) -> Self {
        let (status, msg) = if summary.has_critical_blockers() {
            (
                CheckStatus::Fail,
                format!(
                    "{} critical insight(s) found that may block upgrade ({} total: {} warning, {} passing, {} info)",
                    summary.critical_count,
                    summary.total_findings,
                    summary.warning_count,
                    summary.passing_count,
                    summary.info_count,
                ),
            )
        } else {
            (
                CheckStatus::Pass,
                format!(
                    "No critical insights ({} total: {} warning, {} passing, {} info)",
                    summary.total_findings,
                    summary.warning_count,
                    summary.passing_count,
                    summary.info_count,
                ),
            )
        };
        Self {
            name: "EKS Cluster Insights",
            category: CheckCategory::Mandatory,
            status,
            summary: msg,
        }
    }

    /// Build a PDB drain deadlock check result.
    pub fn pdb_drain_deadlock(summary: &PdbSummary) -> Self {
        let (status, msg) = if summary.has_blocking_pdbs() {
            (
                CheckStatus::Fail,
                format!(
                    "{}/{} PDB(s) have disruptionsAllowed=0 and may block node drain during rolling update",
                    summary.blocking_count, summary.total_pdbs
                ),
            )
        } else {
            (
                CheckStatus::Pass,
                format!(
                    "No PDB drain deadlock detected ({} PDBs checked)",
                    summary.total_pdbs
                ),
            )
        };
        Self {
            name: "PDB Drain Deadlock",
            category: CheckCategory::Mandatory,
            status,
            summary: msg,
        }
    }
}

impl SkippedCheck {
    /// Create a skipped deletion protection check.
    pub fn deletion_protection(reason: &str) -> Self {
        Self {
            name: "EKS Deletion Protection",
            reason: reason.to_string(),
        }
    }

    /// Create a skipped EKS Cluster Insights check.
    pub fn cluster_insights(reason: &str) -> Self {
        Self {
            name: "EKS Cluster Insights",
            reason: reason.to_string(),
        }
    }

    /// Create a skipped PDB drain deadlock check.
    pub fn pdb_drain_deadlock(reason: &str) -> Self {
        Self {
            name: "PDB Drain Deadlock",
            reason: reason.to_string(),
        }
    }
}

// ============================================================================
// PreflightResults methods
// ============================================================================

impl PreflightResults {
    /// Returns true if any mandatory preflight check has failed.
    pub fn has_mandatory_failures(&self) -> bool {
        self.checks
            .iter()
            .any(|c| c.category == CheckCategory::Mandatory && c.status == CheckStatus::Fail)
    }

    /// Returns human-readable descriptions of failed mandatory preflight checks.
    pub fn mandatory_failure_reasons(&self) -> Vec<String> {
        self.checks
            .iter()
            .filter(|c| c.category == CheckCategory::Mandatory && c.status == CheckStatus::Fail)
            .map(|c| format!("[{}] {}", c.name, c.summary))
            .collect()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::k8s::pdb::PdbSummary;

    // ---- Builder tests ----

    #[test]
    fn test_deletion_protection_enabled() {
        let check = PreflightCheckResult::deletion_protection(true);
        assert_eq!(check.name, "EKS Deletion Protection");
        assert_eq!(check.category, CheckCategory::Mandatory);
        assert_eq!(check.status, CheckStatus::Pass);
        assert!(check.summary.contains("enabled"));
    }

    #[test]
    fn test_deletion_protection_disabled() {
        let check = PreflightCheckResult::deletion_protection(false);
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(check.summary.contains("disabled"));
    }

    #[test]
    fn test_pdb_drain_deadlock_pass() {
        let summary = PdbSummary {
            total_pdbs: 5,
            blocking_count: 0,
        };
        let check = PreflightCheckResult::pdb_drain_deadlock(&summary);
        assert_eq!(check.status, CheckStatus::Pass);
        assert!(check.summary.contains("No PDB drain deadlock"));
    }

    #[test]
    fn test_pdb_drain_deadlock_fail() {
        let summary = PdbSummary {
            total_pdbs: 3,
            blocking_count: 1,
        };
        let check = PreflightCheckResult::pdb_drain_deadlock(&summary);
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(check.summary.contains("1/3"));
    }

    // ---- PreflightResults tests ----

    #[test]
    fn test_default_has_no_failures() {
        let results = PreflightResults::default();
        assert!(!results.has_mandatory_failures());
        assert!(results.mandatory_failure_reasons().is_empty());
    }

    #[test]
    fn test_has_mandatory_failures_with_deletion_protection_off() {
        let results = PreflightResults {
            checks: vec![PreflightCheckResult::deletion_protection(false)],
            skipped: vec![],
        };
        assert!(results.has_mandatory_failures());
        let reasons = results.mandatory_failure_reasons();
        assert_eq!(reasons.len(), 1);
        assert!(reasons[0].contains("EKS Deletion Protection"));
    }

    #[test]
    fn test_has_mandatory_failures_with_pdb_blocking() {
        let pdb = PdbSummary {
            total_pdbs: 3,
            blocking_count: 1,
        };
        let results = PreflightResults {
            checks: vec![PreflightCheckResult::pdb_drain_deadlock(&pdb)],
            skipped: vec![],
        };
        assert!(results.has_mandatory_failures());
    }

    #[test]
    fn test_no_mandatory_failures_with_all_pass() {
        let pdb = PdbSummary {
            total_pdbs: 3,
            blocking_count: 0,
        };
        let results = PreflightResults {
            checks: vec![
                PreflightCheckResult::deletion_protection(true),
                PreflightCheckResult::pdb_drain_deadlock(&pdb),
            ],
            skipped: vec![],
        };
        assert!(!results.has_mandatory_failures());
    }

    #[test]
    fn test_skipped_checks() {
        let results = PreflightResults {
            checks: vec![],
            skipped: vec![SkippedCheck::pdb_drain_deadlock(
                "no managed node group upgrades",
            )],
        };
        assert_eq!(results.skipped.len(), 1);
        assert_eq!(results.skipped[0].name, "PDB Drain Deadlock");
    }
}
