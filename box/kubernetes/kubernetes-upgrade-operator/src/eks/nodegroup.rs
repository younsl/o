//! EKS Managed Node Group operations.

use anyhow::Result;
use aws_sdk_eks::Client;
use futures::future::join_all;
use tracing::{debug, info};

use super::types::PlanResult;
use crate::error::KuoError;

/// Managed node group information.
#[derive(Debug, Clone)]
pub struct NodeGroupInfo {
    pub name: String,
    pub version: Option<String>,
}

impl NodeGroupInfo {
    /// Returns the current version or "unknown" if not set.
    pub fn current_version(&self) -> &str {
        self.version.as_deref().unwrap_or("unknown")
    }
}

/// Type alias for nodegroup plan result.
pub type NodeGroupPlanResult = PlanResult<NodeGroupInfo>;

/// List all managed node groups in a cluster.
pub async fn list_nodegroups(client: &Client, cluster_name: &str) -> Result<Vec<NodeGroupInfo>> {
    debug!("Listing managed node groups for cluster: {}", cluster_name);

    let response = client
        .list_nodegroups()
        .cluster_name(cluster_name)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    // Parallel describe_nodegroup calls for better performance
    let futures: Vec<_> = response
        .nodegroups()
        .iter()
        .map(|ng_name| describe_nodegroup(client, cluster_name, ng_name))
        .collect();

    let results = join_all(futures).await;

    let nodegroups: Vec<NodeGroupInfo> = results
        .into_iter()
        .filter_map(|r| r.ok().flatten())
        .collect();

    debug!("Found {} managed node groups", nodegroups.len());
    Ok(nodegroups)
}

/// Describe a specific managed node group.
pub async fn describe_nodegroup(
    client: &Client,
    cluster_name: &str,
    nodegroup_name: &str,
) -> Result<Option<NodeGroupInfo>> {
    debug!("Describing managed node group: {}", nodegroup_name);

    let response = client
        .describe_nodegroup()
        .cluster_name(cluster_name)
        .nodegroup_name(nodegroup_name)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    if let Some(ng) = response.nodegroup() {
        let info = NodeGroupInfo {
            name: ng.nodegroup_name().unwrap_or_default().to_string(),
            version: ng.version().map(std::string::ToString::to_string),
        };
        return Ok(Some(info));
    }

    Ok(None)
}

/// Update managed node group version (rolling update).
pub async fn update_nodegroup_version(
    client: &Client,
    cluster_name: &str,
    nodegroup_name: &str,
    target_version: &str,
) -> Result<String> {
    info!(
        "Updating managed node group {} to version {}",
        nodegroup_name, target_version
    );

    let response = client
        .update_nodegroup_version()
        .cluster_name(cluster_name)
        .nodegroup_name(nodegroup_name)
        .version(target_version)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    let update_id = response
        .update()
        .and_then(|u| u.id())
        .map(std::string::ToString::to_string)
        .unwrap_or_default();

    info!("Managed node group update initiated: {}", update_id);
    Ok(update_id)
}

/// Plan managed node group upgrades to target version.
pub async fn plan_nodegroup_upgrades(
    client: &Client,
    cluster_name: &str,
    target_version: &str,
) -> Result<NodeGroupPlanResult> {
    let nodegroups = list_nodegroups(client, cluster_name).await?;
    let ng_count = nodegroups.len();
    let mut result = NodeGroupPlanResult::new();

    for ng in nodegroups {
        if ng.version.as_deref() == Some(target_version) {
            result.add_skipped();
        } else {
            result.add_upgrade(ng);
        }
    }

    info!(
        "Found {} managed node groups ({} to upgrade, {} skipped)",
        ng_count,
        result.upgrade_count(),
        result.skipped_count()
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_current_version_with_some() {
        let ng = NodeGroupInfo {
            name: "ng-system".to_string(),
            version: Some("1.33".to_string()),
        };
        assert_eq!(ng.current_version(), "1.33");
    }

    #[test]
    fn test_current_version_with_none() {
        let ng = NodeGroupInfo {
            name: "ng-system".to_string(),
            version: None,
        };
        assert_eq!(ng.current_version(), "unknown");
    }

    #[test]
    fn test_nodegroup_info_clone() {
        let ng = NodeGroupInfo {
            name: "ng-app".to_string(),
            version: Some("1.32".to_string()),
        };
        let cloned = ng.clone();
        assert_eq!(cloned.name, "ng-app");
        assert_eq!(cloned.version.as_deref(), Some("1.32"));
    }
}

/// Poll nodegroup update status (non-blocking).
/// Returns the update status string (e.g., "`InProgress`", "Successful", "Failed").
pub async fn poll_nodegroup_update(
    client: &Client,
    cluster_name: &str,
    nodegroup_name: &str,
    update_id: &str,
) -> Result<String> {
    let response = client
        .describe_update()
        .name(cluster_name)
        .nodegroup_name(nodegroup_name)
        .update_id(update_id)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    let status = response
        .update()
        .and_then(|u| u.status())
        .map_or_else(|| "Unknown".to_string(), |s| s.as_str().to_string());

    Ok(status)
}
