//! PDB (`PodDisruptionBudget`) drain deadlock validation.
//!
//! Detects PDBs that would block node drain during managed node group rolling updates.

use anyhow::Result;
use k8s_openapi::api::policy::v1::PodDisruptionBudget;
use kube::Api;
use kube::api::ListParams;
use tracing::{debug, warn};

/// Summary of PDB analysis results.
#[derive(Debug, Clone)]
pub struct PdbSummary {
    pub total_pdbs: usize,
    /// Blocking PDBs identified as `namespace/name`.
    pub blocking: Vec<String>,
}

impl PdbSummary {
    /// Returns true if any PDBs would block node drain.
    pub const fn has_blocking_pdbs(&self) -> bool {
        !self.blocking.is_empty()
    }

    /// Number of blocking PDBs.
    pub const fn blocking_count(&self) -> usize {
        self.blocking.len()
    }
}

/// Check all PDBs in the cluster for drain deadlock.
///
/// A PDB is considered blocking when `status.disruptionsAllowed == 0`
/// and `status.expectedPods > 0` (i.e., it protects active pods but
/// allows zero disruptions).
pub async fn check_pdbs(client: &kube::Client) -> Result<PdbSummary> {
    let pdbs: Api<PodDisruptionBudget> = Api::all(client.clone());
    let list = pdbs
        .list(&ListParams::default())
        .await
        .map_err(|e| crate::error::KuoError::KubernetesApi(format!("Failed to list PDBs: {e}")))?;

    let total_pdbs = list.items.len();
    debug!("Found {} PDBs in cluster", total_pdbs);

    let mut blocking = Vec::new();

    for pdb in &list.items {
        let Some(status) = &pdb.status else {
            continue;
        };

        let disruptions_allowed = status.disruptions_allowed;
        let expected_pods = status.expected_pods;

        // A PDB blocks drain when no disruptions are allowed and it protects active pods
        if disruptions_allowed == 0 && expected_pods > 0 {
            let namespace = pdb.metadata.namespace.as_deref().unwrap_or("default");
            let name = pdb.metadata.name.as_deref().unwrap_or("unknown");
            let id = format!("{namespace}/{name}");

            warn!(
                "PodDisruptionBudget {id} blocks node drain because it allows zero disruptions while protecting {expected_pods} pods"
            );

            blocking.push(id);
        }
    }

    debug!(
        "PDB check complete, {} of {} block node drain",
        blocking.len(),
        total_pdbs
    );

    Ok(PdbSummary {
        total_pdbs,
        blocking,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pdb_summary_has_blocking() {
        let summary = PdbSummary {
            total_pdbs: 5,
            blocking: vec![
                "default/api-pdb".to_string(),
                "payments/worker-pdb".to_string(),
            ],
        };
        assert!(summary.has_blocking_pdbs());
        assert_eq!(summary.blocking_count(), 2);
    }

    #[test]
    fn test_pdb_summary_no_blocking() {
        let summary = PdbSummary {
            total_pdbs: 5,
            blocking: vec![],
        };
        assert!(!summary.has_blocking_pdbs());
        assert_eq!(summary.blocking_count(), 0);
    }

    #[test]
    fn test_pdb_summary_zero_total() {
        let summary = PdbSummary {
            total_pdbs: 0,
            blocking: vec![],
        };
        assert!(!summary.has_blocking_pdbs());
        assert_eq!(summary.total_pdbs, 0);
    }

    #[test]
    fn test_pdb_summary_retains_namespace_name() {
        let summary = PdbSummary {
            total_pdbs: 10,
            blocking: vec!["kube-system/coredns-pdb".to_string()],
        };
        assert!(summary.has_blocking_pdbs());
        assert_eq!(summary.blocking[0], "kube-system/coredns-pdb");
    }
}
