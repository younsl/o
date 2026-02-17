//! Preflight check types and results for EKS upgrade validation.

use crate::k8s::karpenter::{AmiSelectorTerm, KarpenterSummary};
use crate::k8s::pdb::PdbSummary;

/// Category of a preflight check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckCategory {
    Mandatory,
    Informational,
}

/// Status of a preflight check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckStatus {
    Pass,
    Fail,
    Info,
}

/// Check-specific data carried by each preflight result.
#[derive(Debug, Clone)]
pub enum CheckKind {
    DeletionProtection { enabled: bool },
    PdbDrainDeadlock { summary: PdbSummary },
    KarpenterAmiConfig { summary: KarpenterSummary },
}

/// A single preflight check result.
#[derive(Debug, Clone)]
pub struct PreflightCheckResult {
    pub name: &'static str,
    pub category: CheckCategory,
    pub status: CheckStatus,
    pub summary: String,
    pub kind: CheckKind,
}

/// A preflight check that was skipped.
#[derive(Debug, Clone)]
pub struct SkippedCheck {
    pub name: &'static str,
    pub category: CheckCategory,
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
            kind: CheckKind::DeletionProtection { enabled },
        }
    }

    /// Build a PDB drain deadlock check result.
    pub fn pdb_drain_deadlock(summary: PdbSummary) -> Self {
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
            kind: CheckKind::PdbDrainDeadlock { summary },
        }
    }

    /// Build a Karpenter AMI configuration check result.
    pub fn karpenter_ami_config(summary: KarpenterSummary) -> Self {
        let msg = format!(
            "{} EC2NodeClass(es) detected in cluster",
            summary.node_classes.len()
        );
        Self {
            name: "Karpenter EC2NodeClass AMI Configuration",
            category: CheckCategory::Informational,
            status: CheckStatus::Info,
            summary: msg,
            kind: CheckKind::KarpenterAmiConfig { summary },
        }
    }
}

impl SkippedCheck {
    /// Create a skipped deletion protection check.
    pub fn deletion_protection(reason: &str) -> Self {
        Self {
            name: "EKS Deletion Protection",
            category: CheckCategory::Mandatory,
            reason: reason.to_string(),
        }
    }

    /// Create a skipped PDB drain deadlock check.
    pub fn pdb_drain_deadlock(reason: &str) -> Self {
        Self {
            name: "PDB Drain Deadlock",
            category: CheckCategory::Mandatory,
            reason: reason.to_string(),
        }
    }

    /// Create a skipped Karpenter AMI configuration check.
    pub fn karpenter_ami_config(reason: &str) -> Self {
        Self {
            name: "Karpenter EC2NodeClass AMI Configuration",
            category: CheckCategory::Informational,
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

    /// Iterator over mandatory checks and skipped mandatory checks.
    pub fn mandatory_checks(&self) -> impl Iterator<Item = &PreflightCheckResult> {
        self.checks
            .iter()
            .filter(|c| c.category == CheckCategory::Mandatory)
    }

    /// Iterator over skipped mandatory checks.
    pub fn mandatory_skipped(&self) -> impl Iterator<Item = &SkippedCheck> {
        self.skipped
            .iter()
            .filter(|s| s.category == CheckCategory::Mandatory)
    }

    /// Iterator over informational checks.
    pub fn informational_checks(&self) -> impl Iterator<Item = &PreflightCheckResult> {
        self.checks
            .iter()
            .filter(|c| c.category == CheckCategory::Informational)
    }

    /// Iterator over skipped informational checks.
    pub fn informational_skipped(&self) -> impl Iterator<Item = &SkippedCheck> {
        self.skipped
            .iter()
            .filter(|s| s.category == CheckCategory::Informational)
    }

    /// Get PDB summary if the check was run.
    #[cfg(test)]
    pub fn pdb_summary(&self) -> Option<&PdbSummary> {
        self.checks.iter().find_map(|c| match &c.kind {
            CheckKind::PdbDrainDeadlock { summary } => Some(summary),
            _ => None,
        })
    }

    /// Get Karpenter summary if the check was run.
    #[cfg(test)]
    pub fn karpenter_summary(&self) -> Option<&KarpenterSummary> {
        self.checks.iter().find_map(|c| match &c.kind {
            CheckKind::KarpenterAmiConfig { summary } => Some(summary),
            _ => None,
        })
    }
}

// ============================================================================
// Shared helper
// ============================================================================

/// Format a single AMI selector term for display.
pub fn format_ami_selector_term(term: &AmiSelectorTerm) -> String {
    if let Some(ref alias) = term.alias {
        return format!("alias: {}", alias);
    }
    if let Some(ref id) = term.id {
        return format!("id: {}", id);
    }
    if let Some(ref name) = term.name {
        let mut s = format!("name: {}", name);
        if let Some(ref owner) = term.owner {
            s.push_str(&format!(", owner: {}", owner));
        }
        return s;
    }
    if let Some(ref tags) = term.tags {
        let pairs: Vec<String> = tags.iter().map(|(k, v)| format!("{}={}", k, v)).collect();
        return format!("tags: {{{}}}", pairs.join(", "));
    }
    "(empty term)".to_string()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::k8s::karpenter::{AmiSelectorTerm, Ec2NodeClassInfo, KarpenterSummary};
    use crate::k8s::pdb::{PdbFinding, PdbSummary};

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
            findings: vec![],
        };
        let check = PreflightCheckResult::pdb_drain_deadlock(summary);
        assert_eq!(check.status, CheckStatus::Pass);
        assert!(check.summary.contains("No PDB drain deadlock"));
    }

    #[test]
    fn test_pdb_drain_deadlock_fail() {
        let summary = PdbSummary {
            total_pdbs: 3,
            blocking_count: 1,
            findings: vec![PdbFinding {
                namespace: "kube-system".to_string(),
                name: "coredns-pdb".to_string(),
                min_available: Some("1".to_string()),
                max_unavailable: None,
                current_healthy: 1,
                expected_pods: 1,
                disruptions_allowed: 0,
            }],
        };
        let check = PreflightCheckResult::pdb_drain_deadlock(summary);
        assert_eq!(check.status, CheckStatus::Fail);
        assert!(check.summary.contains("1/3"));
    }

    #[test]
    fn test_karpenter_ami_config() {
        let summary = KarpenterSummary {
            node_classes: vec![Ec2NodeClassInfo {
                name: "default".to_string(),
                ami_selector_terms: vec![AmiSelectorTerm {
                    alias: Some("al2023@latest".to_string()),
                    id: None,
                    name: None,
                    owner: None,
                    tags: None,
                }],
            }],
            api_version: "v1".to_string(),
        };
        let check = PreflightCheckResult::karpenter_ami_config(summary);
        assert_eq!(check.category, CheckCategory::Informational);
        assert_eq!(check.status, CheckStatus::Info);
        assert!(check.summary.contains("1 EC2NodeClass"));
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
            findings: vec![PdbFinding {
                namespace: "default".to_string(),
                name: "test-pdb".to_string(),
                min_available: Some("1".to_string()),
                max_unavailable: None,
                current_healthy: 1,
                expected_pods: 1,
                disruptions_allowed: 0,
            }],
        };
        let results = PreflightResults {
            checks: vec![PreflightCheckResult::pdb_drain_deadlock(pdb)],
            skipped: vec![],
        };
        assert!(results.has_mandatory_failures());
    }

    #[test]
    fn test_no_mandatory_failures_with_all_pass() {
        let pdb = PdbSummary {
            total_pdbs: 3,
            blocking_count: 0,
            findings: vec![],
        };
        let results = PreflightResults {
            checks: vec![
                PreflightCheckResult::deletion_protection(true),
                PreflightCheckResult::pdb_drain_deadlock(pdb),
            ],
            skipped: vec![],
        };
        assert!(!results.has_mandatory_failures());
    }

    #[test]
    fn test_informational_does_not_cause_mandatory_failure() {
        let summary = KarpenterSummary {
            node_classes: vec![Ec2NodeClassInfo {
                name: "default".to_string(),
                ami_selector_terms: vec![],
            }],
            api_version: "v1".to_string(),
        };
        let results = PreflightResults {
            checks: vec![PreflightCheckResult::karpenter_ami_config(summary)],
            skipped: vec![],
        };
        assert!(!results.has_mandatory_failures());
    }

    #[test]
    fn test_pdb_summary_accessor() {
        let pdb = PdbSummary {
            total_pdbs: 5,
            blocking_count: 0,
            findings: vec![],
        };
        let results = PreflightResults {
            checks: vec![PreflightCheckResult::pdb_drain_deadlock(pdb)],
            skipped: vec![],
        };
        assert!(results.pdb_summary().is_some());
        assert_eq!(results.pdb_summary().unwrap().total_pdbs, 5);
    }

    #[test]
    fn test_karpenter_summary_accessor() {
        let summary = KarpenterSummary {
            node_classes: vec![],
            api_version: "v1".to_string(),
        };
        let results = PreflightResults {
            checks: vec![PreflightCheckResult::karpenter_ami_config(summary)],
            skipped: vec![],
        };
        assert!(results.karpenter_summary().is_some());
    }

    #[test]
    fn test_mandatory_checks_iterator() {
        let pdb = PdbSummary {
            total_pdbs: 1,
            blocking_count: 0,
            findings: vec![],
        };
        let karpenter = KarpenterSummary {
            node_classes: vec![],
            api_version: "v1".to_string(),
        };
        let results = PreflightResults {
            checks: vec![
                PreflightCheckResult::deletion_protection(true),
                PreflightCheckResult::pdb_drain_deadlock(pdb),
                PreflightCheckResult::karpenter_ami_config(karpenter),
            ],
            skipped: vec![],
        };
        assert_eq!(results.mandatory_checks().count(), 2);
        assert_eq!(results.informational_checks().count(), 1);
    }

    #[test]
    fn test_skipped_checks() {
        let results = PreflightResults {
            checks: vec![],
            skipped: vec![
                SkippedCheck::pdb_drain_deadlock("no managed node group upgrades"),
                SkippedCheck::karpenter_ami_config("Kubernetes API unavailable"),
            ],
        };
        assert_eq!(results.mandatory_skipped().count(), 1);
        assert_eq!(results.informational_skipped().count(), 1);
    }

    // ---- format_ami_selector_term tests ----

    #[test]
    fn test_format_ami_selector_term_alias() {
        let term = AmiSelectorTerm {
            alias: Some("al2023@v20250117".to_string()),
            id: None,
            name: None,
            owner: None,
            tags: None,
        };
        assert_eq!(format_ami_selector_term(&term), "alias: al2023@v20250117");
    }

    #[test]
    fn test_format_ami_selector_term_id() {
        let term = AmiSelectorTerm {
            alias: None,
            id: Some("ami-0123456789abcdef0".to_string()),
            name: None,
            owner: None,
            tags: None,
        };
        assert_eq!(format_ami_selector_term(&term), "id: ami-0123456789abcdef0");
    }

    #[test]
    fn test_format_ami_selector_term_name_with_owner() {
        let term = AmiSelectorTerm {
            alias: None,
            id: None,
            name: Some("my-ami-*".to_string()),
            owner: Some("123456789012".to_string()),
            tags: None,
        };
        assert_eq!(
            format_ami_selector_term(&term),
            "name: my-ami-*, owner: 123456789012"
        );
    }

    #[test]
    fn test_format_ami_selector_term_name_without_owner() {
        let term = AmiSelectorTerm {
            alias: None,
            id: None,
            name: Some("eks-node-*".to_string()),
            owner: None,
            tags: None,
        };
        assert_eq!(format_ami_selector_term(&term), "name: eks-node-*");
    }

    #[test]
    fn test_format_ami_selector_term_tags() {
        let mut tags = std::collections::HashMap::new();
        tags.insert("Environment".to_string(), "production".to_string());
        let term = AmiSelectorTerm {
            alias: None,
            id: None,
            name: None,
            owner: None,
            tags: Some(tags),
        };
        assert_eq!(
            format_ami_selector_term(&term),
            "tags: {Environment=production}"
        );
    }

    #[test]
    fn test_format_ami_selector_term_empty() {
        let term = AmiSelectorTerm {
            alias: None,
            id: None,
            name: None,
            owner: None,
            tags: None,
        };
        assert_eq!(format_ami_selector_term(&term), "(empty term)");
    }

    #[test]
    fn test_format_ami_selector_term_alias_takes_precedence() {
        let term = AmiSelectorTerm {
            alias: Some("al2023@latest".to_string()),
            id: Some("ami-fallback".to_string()),
            name: Some("name-fallback".to_string()),
            owner: None,
            tags: None,
        };
        assert_eq!(format_ami_selector_term(&term), "alias: al2023@latest");
    }
}
