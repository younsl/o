//! EKS upgrade planning logic.

use anyhow::Result;
use std::collections::HashMap;
use tracing::info;

use super::addon::{self, AddonUpgrade};
use super::client::{EksClient, calculate_upgrade_path};
use super::nodegroup::{self, NodeGroupInfo};

/// Upgrade plan for a cluster.
#[derive(Debug, Clone)]
pub struct UpgradePlan {
    pub current_version: String,
    pub upgrade_path: Vec<String>,
    pub addon_upgrades: Vec<AddonUpgrade>,
    pub nodegroup_upgrades: Vec<NodeGroupInfo>,
}

impl UpgradePlan {
    /// Returns true if there's nothing to upgrade (all components already at target version).
    pub fn is_empty(&self) -> bool {
        self.upgrade_path.is_empty()
            && self.addon_upgrades.is_empty()
            && self.nodegroup_upgrades.is_empty()
    }
}

/// Create an upgrade plan for a cluster.
pub async fn create_upgrade_plan(
    client: &EksClient,
    cluster_name: &str,
    target_version: &str,
    addon_versions: &HashMap<String, String>,
) -> Result<UpgradePlan> {
    info!(
        "Creating upgrade plan for {} to version {}",
        cluster_name, target_version
    );

    // Get current cluster info
    let cluster = client
        .describe_cluster(cluster_name)
        .await?
        .ok_or_else(|| crate::error::KuoError::ClusterNotFound(cluster_name.to_string()))?;

    // Calculate upgrade path
    let upgrade_path = calculate_upgrade_path(&cluster.version, target_version)?;

    // Plan addon upgrades (for target version)
    let addon_result =
        addon::plan_addon_upgrades(client.inner(), cluster_name, target_version, addon_versions)
            .await?;

    // Plan nodegroup upgrades
    let nodegroup_result =
        nodegroup::plan_nodegroup_upgrades(client.inner(), cluster_name, target_version).await?;

    Ok(UpgradePlan {
        current_version: cluster.version,
        upgrade_path,
        addon_upgrades: addon_result.upgrades,
        nodegroup_upgrades: nodegroup_result.upgrades,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eks::addon::AddonInfo;

    #[test]
    fn test_upgrade_plan_is_empty_true() {
        let plan = UpgradePlan {
            current_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![],
            nodegroup_upgrades: vec![],
        };
        assert!(plan.is_empty());
    }

    #[test]
    fn test_upgrade_plan_is_empty_with_upgrade_path() {
        let plan = UpgradePlan {
            current_version: "1.32".to_string(),
            upgrade_path: vec!["1.33".to_string()],
            addon_upgrades: vec![],
            nodegroup_upgrades: vec![],
        };
        assert!(!plan.is_empty());
    }

    #[test]
    fn test_upgrade_plan_is_empty_with_addon_upgrades_only() {
        let addon = AddonInfo {
            name: "coredns".to_string(),
            current_version: "v1.11.1-eksbuild.1".to_string(),
        };
        let plan = UpgradePlan {
            current_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![(addon, "v1.11.3-eksbuild.2".to_string())],
            nodegroup_upgrades: vec![],
        };
        assert!(!plan.is_empty());
    }

    #[test]
    fn test_upgrade_plan_is_empty_with_nodegroup_upgrades_only() {
        let ng = NodeGroupInfo {
            name: "ng-system".to_string(),
            version: Some("1.32".to_string()),
        };
        let plan = UpgradePlan {
            current_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![],
            nodegroup_upgrades: vec![ng],
        };
        assert!(!plan.is_empty());
    }

    #[test]
    fn test_upgrade_plan_is_empty_with_all_components() {
        let addon = AddonInfo {
            name: "coredns".to_string(),
            current_version: "v1.11.1-eksbuild.1".to_string(),
        };
        let ng = NodeGroupInfo {
            name: "ng-system".to_string(),
            version: Some("1.32".to_string()),
        };
        let plan = UpgradePlan {
            current_version: "1.32".to_string(),
            upgrade_path: vec!["1.33".to_string()],
            addon_upgrades: vec![(addon, "v1.11.3-eksbuild.2".to_string())],
            nodegroup_upgrades: vec![ng],
        };
        assert!(!plan.is_empty());
    }

    #[test]
    fn test_upgrade_plan_current_version() {
        let plan = UpgradePlan {
            current_version: "1.31".to_string(),
            upgrade_path: vec!["1.32".to_string(), "1.33".to_string()],
            addon_upgrades: vec![],
            nodegroup_upgrades: vec![],
        };
        assert_eq!(plan.current_version, "1.31");
        assert_eq!(plan.upgrade_path.len(), 2);
    }
}
