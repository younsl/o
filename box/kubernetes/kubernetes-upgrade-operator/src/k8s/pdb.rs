//! PDB (PodDisruptionBudget) drain deadlock validation.
//!
//! Detects PDBs that would block node drain during managed node group rolling updates.

use anyhow::Result;
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::Api;
use kube::api::ListParams;
use tracing::debug;

/// Summary of PDB analysis results.
#[derive(Debug, Clone)]
pub struct PdbSummary {
    pub total_pdbs: usize,
    pub blocking_count: usize,
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
        crate::error::KuoError::KubernetesApi(format!("Failed to list PDBs: {}", e))
    })?;

    let total_pdbs = list.items.len();
    debug!("Found {} PDBs in cluster", total_pdbs);

    let mut blocking_count = 0;

    for pdb in &list.items {
        let status = match &pdb.status {
            Some(s) => s,
            None => continue,
        };

        let disruptions_allowed = status.disruptions_allowed;
        let expected_pods = status.expected_pods;

        // A PDB blocks drain when no disruptions are allowed and it protects active pods
        if disruptions_allowed == 0 && expected_pods > 0 {
            let namespace = pdb.metadata.namespace.as_deref().unwrap_or("default");
            let name = pdb.metadata.name.as_deref().unwrap_or("unknown");

            debug!(
                "Blocking PDB found: {}/{} (disruptions_allowed=0, expected_pods={})",
                namespace, name, expected_pods
            );

            blocking_count += 1;
        }
    }

    debug!(
        "PDB check complete: {}/{} blocking",
        blocking_count, total_pdbs
    );

    Ok(PdbSummary {
        total_pdbs,
        blocking_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pdb_summary_has_blocking() {
        let summary = PdbSummary {
            total_pdbs: 5,
            blocking_count: 2,
        };
        assert!(summary.has_blocking_pdbs());
    }

    #[test]
    fn test_pdb_summary_no_blocking() {
        let summary = PdbSummary {
            total_pdbs: 5,
            blocking_count: 0,
        };
        assert!(!summary.has_blocking_pdbs());
    }

    #[test]
    fn test_pdb_summary_zero_total() {
        let summary = PdbSummary {
            total_pdbs: 0,
            blocking_count: 0,
        };
        assert!(!summary.has_blocking_pdbs());
        assert_eq!(summary.total_pdbs, 0);
    }

    #[test]
    fn test_pdb_summary_single_blocking() {
        let summary = PdbSummary {
            total_pdbs: 10,
            blocking_count: 1,
        };
        assert!(summary.has_blocking_pdbs());
        assert_eq!(summary.blocking_count, 1);
    }

    #[test]
    fn test_pdb_summary_all_blocking() {
        let summary = PdbSummary {
            total_pdbs: 3,
            blocking_count: 3,
        };
        assert!(summary.has_blocking_pdbs());
        assert_eq!(summary.blocking_count, summary.total_pdbs);
    }
}
