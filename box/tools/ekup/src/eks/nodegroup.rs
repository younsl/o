//! EKS Node Group operations.

use anyhow::Result;
use aws_sdk_eks::Client;
use tracing::{debug, info};

use crate::error::EkupError;

/// Node group information.
#[derive(Debug, Clone)]
pub struct NodeGroupInfo {
    pub name: String,
    pub version: Option<String>,
}

/// List all node groups in a cluster.
pub async fn list_nodegroups(client: &Client, cluster_name: &str) -> Result<Vec<NodeGroupInfo>> {
    debug!("Listing node groups for cluster: {}", cluster_name);

    let response = client
        .list_nodegroups()
        .cluster_name(cluster_name)
        .send()
        .await
        .map_err(EkupError::aws)?;

    let mut nodegroups = Vec::new();

    for ng_name in response.nodegroups() {
        if let Some(info) = describe_nodegroup(client, cluster_name, ng_name).await? {
            nodegroups.push(info);
        }
    }

    debug!("Found {} node groups", nodegroups.len());
    Ok(nodegroups)
}

/// Describe a specific node group.
pub async fn describe_nodegroup(
    client: &Client,
    cluster_name: &str,
    nodegroup_name: &str,
) -> Result<Option<NodeGroupInfo>> {
    debug!("Describing node group: {}", nodegroup_name);

    let response = client
        .describe_nodegroup()
        .cluster_name(cluster_name)
        .nodegroup_name(nodegroup_name)
        .send()
        .await
        .map_err(EkupError::aws)?;

    if let Some(ng) = response.nodegroup() {
        let info = NodeGroupInfo {
            name: ng.nodegroup_name().unwrap_or_default().to_string(),
            version: ng.version().map(|s| s.to_string()),
        };
        return Ok(Some(info));
    }

    Ok(None)
}

/// Update node group version (rolling update).
pub async fn update_nodegroup_version(
    client: &Client,
    cluster_name: &str,
    nodegroup_name: &str,
    target_version: &str,
) -> Result<String> {
    info!(
        "Updating node group {} to version {}",
        nodegroup_name, target_version
    );

    let response = client
        .update_nodegroup_version()
        .cluster_name(cluster_name)
        .nodegroup_name(nodegroup_name)
        .version(target_version)
        .send()
        .await
        .map_err(EkupError::aws)?;

    let update_id = response
        .update()
        .and_then(|u| u.id())
        .map(|s| s.to_string())
        .unwrap_or_default();

    info!("Node group update initiated: {}", update_id);
    Ok(update_id)
}

/// Wait for node group update to complete.
pub async fn wait_for_nodegroup_update(
    client: &Client,
    cluster_name: &str,
    nodegroup_name: &str,
    update_id: &str,
    timeout_minutes: u64,
    check_interval_seconds: u64,
) -> Result<()> {
    use std::time::{Duration, Instant};

    let timeout = Duration::from_secs(timeout_minutes * 60);
    let interval = Duration::from_secs(check_interval_seconds);
    let start = Instant::now();

    loop {
        if start.elapsed() > timeout {
            return Err(EkupError::Timeout {
                operation: format!("node group {} update", nodegroup_name),
                details: format!(
                    "Update {} did not complete within {} minutes",
                    update_id, timeout_minutes
                ),
            }
            .into());
        }

        let response = client
            .describe_update()
            .name(cluster_name)
            .nodegroup_name(nodegroup_name)
            .update_id(update_id)
            .send()
            .await
            .map_err(EkupError::aws)?;

        if let Some(update) = response.update() {
            let status = update.status().map(|s| s.as_str()).unwrap_or("Unknown");
            debug!("Node group {} update status: {}", nodegroup_name, status);

            match status {
                "Successful" => {
                    info!(
                        "Node group {} update completed successfully",
                        nodegroup_name
                    );
                    return Ok(());
                }
                "Failed" | "Cancelled" => {
                    let errors: Vec<String> = update
                        .errors()
                        .iter()
                        .filter_map(|e| e.error_message().map(|s| s.to_string()))
                        .collect();
                    return Err(EkupError::NodeGroupError(format!(
                        "Node group {} update {}: {}",
                        nodegroup_name,
                        status,
                        errors.join(", ")
                    ))
                    .into());
                }
                _ => {
                    // InProgress, Pending
                    tokio::time::sleep(interval).await;
                }
            }
        } else {
            tokio::time::sleep(interval).await;
        }
    }
}

/// Plan node group upgrades to target version.
pub async fn plan_nodegroup_upgrades(
    client: &Client,
    cluster_name: &str,
    target_version: &str,
) -> Result<Vec<NodeGroupInfo>> {
    let nodegroups = list_nodegroups(client, cluster_name).await?;
    let ng_count = nodegroups.len();
    let mut upgrade_plan = Vec::new();

    for ng in nodegroups {
        // Check if node group needs upgrade
        if ng.version.as_deref() != Some(target_version) {
            upgrade_plan.push(ng);
        }
    }

    info!(
        "Found {} node groups ({} to upgrade)",
        ng_count,
        upgrade_plan.len()
    );
    Ok(upgrade_plan)
}

/// Execute node group upgrades (parallel or sequential).
pub async fn execute_nodegroup_upgrades(
    client: &Client,
    cluster_name: &str,
    nodegroups: &[NodeGroupInfo],
    target_version: &str,
    timeout_minutes: u64,
    check_interval_seconds: u64,
) -> Result<()> {
    // For now, execute sequentially to avoid overwhelming the cluster
    for ng in nodegroups {
        info!(
            "Upgrading node group {} to version {}",
            ng.name, target_version
        );

        let update_id =
            update_nodegroup_version(client, cluster_name, &ng.name, target_version).await?;

        wait_for_nodegroup_update(
            client,
            cluster_name,
            &ng.name,
            &update_id,
            timeout_minutes,
            check_interval_seconds,
        )
        .await?;
    }

    Ok(())
}
