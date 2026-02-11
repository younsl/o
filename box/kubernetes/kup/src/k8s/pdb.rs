//! PDB (PodDisruptionBudget) drain deadlock validation.
//!
//! Detects PDBs that would block node drain during managed node group rolling updates.

use anyhow::Result;
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use k8s_openapi::apimachinery::pkg::util::intstr::IntOrString;
use kube::Api;
use kube::api::ListParams;
use tracing::debug;

/// A PDB that may block node drain.
#[derive(Debug, Clone)]
pub struct PdbFinding {
    pub namespace: String,
    pub name: String,
    pub min_available: Option<String>,
    pub max_unavailable: Option<String>,
    pub current_healthy: i32,
    pub expected_pods: i32,
    pub disruptions_allowed: i32,
}

impl PdbFinding {
    /// Format a human-readable reason string.
    pub fn reason(&self) -> String {
        let spec_info = if let Some(ref min) = self.min_available {
            format!("minAvailable={}", min)
        } else if let Some(ref max) = self.max_unavailable {
            format!("maxUnavailable={}", max)
        } else {
            "unknown spec".to_string()
        };

        format!(
            "{}, {}/{} healthy pods, {} disruptions allowed",
            spec_info, self.current_healthy, self.expected_pods, self.disruptions_allowed
        )
    }
}

/// Summary of PDB analysis results.
#[derive(Debug, Clone)]
pub struct PdbSummary {
    pub total_pdbs: usize,
    pub blocking_count: usize,
    pub findings: Vec<PdbFinding>,
}

impl PdbSummary {
    /// Returns true if any PDBs would block node drain.
    pub fn has_blocking_pdbs(&self) -> bool {
        self.blocking_count > 0
    }
}

/// Check all PDBs in the cluster for drain deadlock.
///
/// A PDB is considered blocking when `status.disruptionsAllowed == 0`
/// and `status.expectedPods > 0` (i.e., it protects active pods but
/// allows zero disruptions).
pub async fn check_pdbs(client: &kube::Client) -> Result<PdbSummary> {
    let pdbs: Api<PodDisruptionBudget> = Api::all(client.clone());
    let list = pdbs.list(&ListParams::default()).await.map_err(|e| {
        crate::error::KupError::KubernetesApi(format!("Failed to list PDBs: {}", e))
    })?;

    let total_pdbs = list.items.len();
    debug!("Found {} PDBs in cluster", total_pdbs);

    let mut findings = Vec::new();

    for pdb in &list.items {
        let namespace = pdb
            .metadata
            .namespace
            .as_deref()
            .unwrap_or("default")
            .to_string();
        let name = pdb
            .metadata
            .name
            .as_deref()
            .unwrap_or("unknown")
            .to_string();

        let status = match &pdb.status {
            Some(s) => s,
            None => continue,
        };

        let disruptions_allowed = status.disruptions_allowed;
        let expected_pods = status.expected_pods;
        let current_healthy = status.current_healthy;

        // A PDB blocks drain when no disruptions are allowed and it protects active pods
        if disruptions_allowed == 0 && expected_pods > 0 {
            let spec = pdb.spec.as_ref();

            let min_available = spec
                .and_then(|s| s.min_available.as_ref())
                .map(format_int_or_string);

            let max_unavailable = spec
                .and_then(|s| s.max_unavailable.as_ref())
                .map(format_int_or_string);

            debug!(
                "Blocking PDB found: {}/{} (disruptions_allowed=0, expected_pods={})",
                namespace, name, expected_pods
            );

            findings.push(PdbFinding {
                namespace,
                name,
                min_available,
                max_unavailable,
                current_healthy,
                expected_pods,
                disruptions_allowed,
            });
        }
    }

    let blocking_count = findings.len();
    debug!(
        "PDB check complete: {}/{} blocking",
        blocking_count, total_pdbs
    );

    Ok(PdbSummary {
        total_pdbs,
        blocking_count,
        findings,
    })
}

/// Format an IntOrString value for display.
fn format_int_or_string(value: &IntOrString) -> String {
    match value {
        IntOrString::Int(i) => i.to_string(),
        IntOrString::String(s) => s.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_int_or_string_int() {
        let value = IntOrString::Int(1);
        assert_eq!(format_int_or_string(&value), "1");
    }

    #[test]
    fn test_format_int_or_string_string() {
        let value = IntOrString::String("50%".to_string());
        assert_eq!(format_int_or_string(&value), "50%");
    }

    #[test]
    fn test_pdb_finding_reason_min_available() {
        let finding = PdbFinding {
            namespace: "kube-system".to_string(),
            name: "coredns-pdb".to_string(),
            min_available: Some("1".to_string()),
            max_unavailable: None,
            current_healthy: 1,
            expected_pods: 1,
            disruptions_allowed: 0,
        };

        assert_eq!(
            finding.reason(),
            "minAvailable=1, 1/1 healthy pods, 0 disruptions allowed"
        );
    }

    #[test]
    fn test_pdb_finding_reason_max_unavailable() {
        let finding = PdbFinding {
            namespace: "app".to_string(),
            name: "my-service-pdb".to_string(),
            min_available: None,
            max_unavailable: Some("0".to_string()),
            current_healthy: 3,
            expected_pods: 3,
            disruptions_allowed: 0,
        };

        assert_eq!(
            finding.reason(),
            "maxUnavailable=0, 3/3 healthy pods, 0 disruptions allowed"
        );
    }

    #[test]
    fn test_pdb_summary_has_blocking() {
        let summary = PdbSummary {
            total_pdbs: 5,
            blocking_count: 2,
            findings: vec![],
        };
        assert!(summary.has_blocking_pdbs());
    }

    #[test]
    fn test_pdb_summary_no_blocking() {
        let summary = PdbSummary {
            total_pdbs: 5,
            blocking_count: 0,
            findings: vec![],
        };
        assert!(!summary.has_blocking_pdbs());
    }
}
