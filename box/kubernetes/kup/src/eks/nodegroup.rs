//! EKS Managed Node Group operations.

use anyhow::Result;
use aws_sdk_autoscaling::Client as AsgClient;
use aws_sdk_eks::Client;
use colored::Colorize;
use futures::future::join_all;
use indicatif::{ProgressBar, ProgressStyle};
use std::time::Duration;
use tracing::{debug, info};

use super::types::{PlanResult, VersionedResource};
use crate::error::KupError;

/// Managed node group information.
#[derive(Debug, Clone)]
pub struct NodeGroupInfo {
    pub name: String,
    pub version: Option<String>,
    pub desired_size: i32,
    pub max_unavailable: Option<i32>,
    pub max_unavailable_percentage: Option<i32>,
    pub asg_name: Option<String>,
}

impl VersionedResource for NodeGroupInfo {
    fn name(&self) -> &str {
        &self.name
    }

    fn current_version(&self) -> &str {
        self.version.as_deref().unwrap_or("unknown")
    }
}

/// Type alias for nodegroup plan result.
pub type NodeGroupPlanResult = PlanResult<NodeGroupInfo, NodeGroupInfo>;

/// Format rolling strategy for a managed node group.
pub fn format_rolling_strategy(ng: &NodeGroupInfo) -> String {
    if let Some(percentage) = ng.max_unavailable_percentage {
        let max_unavailable = std::cmp::max(1, ng.desired_size * percentage / 100);
        format!("{}% = {} at a time", percentage, max_unavailable)
    } else if let Some(count) = ng.max_unavailable {
        format!("{} at a time", count)
    } else {
        // AWS default: 1 node at a time
        "1 at a time (default)".to_string()
    }
}

/// List all managed node groups in a cluster.
pub async fn list_nodegroups(client: &Client, cluster_name: &str) -> Result<Vec<NodeGroupInfo>> {
    debug!("Listing managed node groups for cluster: {}", cluster_name);

    let response = client
        .list_nodegroups()
        .cluster_name(cluster_name)
        .send()
        .await
        .map_err(|e| KupError::aws(module_path!(), e))?;

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
        .map_err(|e| KupError::aws(module_path!(), e))?;

    if let Some(ng) = response.nodegroup() {
        let desired_size = ng
            .scaling_config()
            .and_then(|sc| sc.desired_size)
            .unwrap_or(0);

        let (max_unavailable, max_unavailable_percentage) = ng
            .update_config()
            .map(|uc| (uc.max_unavailable, uc.max_unavailable_percentage))
            .unwrap_or((None, None));

        let asg_name = ng
            .resources()
            .and_then(|r| r.auto_scaling_groups().first())
            .and_then(|asg| asg.name())
            .map(|s| s.to_string());

        let info = NodeGroupInfo {
            name: ng.nodegroup_name().unwrap_or_default().to_string(),
            version: ng.version().map(|s| s.to_string()),
            desired_size,
            max_unavailable,
            max_unavailable_percentage,
            asg_name,
        };
        return Ok(Some(info));
    }

    Ok(None)
}

/// Update managed node group version (rolling update).
///
/// Note: Rolling update strategy (maxUnavailable/maxUnavailablePercentage) is configured
/// on the managed node group itself via UpdateNodegroupConfig, not per-update.
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
        .map_err(|e| KupError::aws(module_path!(), e))?;

    let update_id = response
        .update()
        .and_then(|u| u.id())
        .map(|s| s.to_string())
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
        if ng.version.as_deref() != Some(target_version) {
            result.add_upgrade(ng);
        } else {
            result.add_skipped(ng, "already at target version");
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

/// Execute managed node group upgrades (parallel or sequential).
pub async fn execute_nodegroup_upgrades(
    eks_client: &Client,
    asg_client: &AsgClient,
    cluster_name: &str,
    nodegroups: &[NodeGroupInfo],
    target_version: &str,
    timeout_minutes: u64,
    check_interval_seconds: u64,
) -> Result<()> {
    let total = nodegroups.len();

    for (i, ng) in nodegroups.iter().enumerate() {
        let rolling_strategy = format_rolling_strategy(ng);
        println!(
            "  [{}/{}] {}: starting upgrade ({} nodes, {})...",
            i + 1,
            total,
            ng.name,
            ng.desired_size,
            rolling_strategy
        );

        let update_id =
            update_nodegroup_version(eks_client, cluster_name, &ng.name, target_version).await?;

        wait_for_nodegroup_update_with_progress(
            eks_client,
            asg_client,
            cluster_name,
            ng,
            &update_id,
            timeout_minutes,
            check_interval_seconds,
            i + 1,
            total,
        )
        .await?;
    }

    Ok(())
}

/// Wait for managed node group update with rolling progress display.
#[allow(clippy::too_many_arguments)]
async fn wait_for_nodegroup_update_with_progress(
    eks_client: &Client,
    asg_client: &AsgClient,
    cluster_name: &str,
    ng: &NodeGroupInfo,
    update_id: &str,
    timeout_minutes: u64,
    check_interval_seconds: u64,
    current_index: usize,
    total_count: usize,
) -> Result<()> {
    use std::time::Instant;

    let timeout = Duration::from_secs(timeout_minutes * 60);
    let interval = Duration::from_secs(check_interval_seconds);
    let start = Instant::now();

    let pb = ProgressBar::new_spinner();
    pb.set_style(
        ProgressStyle::default_spinner()
            .template("{spinner:.cyan} {msg}")
            .unwrap(),
    );
    pb.enable_steady_tick(Duration::from_millis(100));

    loop {
        if start.elapsed() > timeout {
            pb.finish_with_message(format!(
                "[{}/{}] {}: timeout",
                current_index, total_count, ng.name
            ));
            return Err(KupError::Timeout {
                operation: format!("managed node group {} update", ng.name),
                details: format!(
                    "Update {} did not complete within {} minutes",
                    update_id, timeout_minutes
                ),
            }
            .into());
        }

        // Check update status
        let response = eks_client
            .describe_update()
            .name(cluster_name)
            .nodegroup_name(&ng.name)
            .update_id(update_id)
            .send()
            .await
            .map_err(|e| KupError::aws(module_path!(), e))?;

        let status = response
            .update()
            .and_then(|u| u.status())
            .map(|s| s.as_str())
            .unwrap_or("Unknown");

        // Get rolling progress from ASG
        let progress = if let Some(asg_name) = &ng.asg_name {
            get_asg_rolling_progress(asg_client, asg_name).await.ok()
        } else {
            None
        };

        let progress_str = progress
            .map(|(healthy, total)| format!("{}/{} nodes ready", healthy, total))
            .unwrap_or_else(|| status.to_string());

        let elapsed = start.elapsed().as_secs();
        pb.set_message(format!(
            "[{}/{}] {}: {} ({}m {}s)",
            current_index,
            total_count,
            ng.name,
            progress_str,
            elapsed / 60,
            elapsed % 60
        ));

        match status {
            "Successful" => {
                pb.finish_with_message(format!(
                    "[{}/{}] {}: {} complete",
                    current_index,
                    total_count,
                    ng.name,
                    "✓".green()
                ));
                return Ok(());
            }
            "Failed" | "Cancelled" => {
                let errors: Vec<String> = response
                    .update()
                    .map(|u| {
                        u.errors()
                            .iter()
                            .filter_map(|e| e.error_message().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                pb.finish_with_message(format!(
                    "[{}/{}] {}: {} failed",
                    current_index,
                    total_count,
                    ng.name,
                    "✗".red()
                ));
                return Err(KupError::NodeGroupError(format!(
                    "Managed node group {} update {}: {}",
                    ng.name,
                    status,
                    errors.join(", ")
                ))
                .into());
            }
            _ => {
                tokio::time::sleep(interval).await;
            }
        }
    }
}

/// Get ASG rolling update progress (healthy instances / total instances).
async fn get_asg_rolling_progress(asg_client: &AsgClient, asg_name: &str) -> Result<(i32, i32)> {
    let response = asg_client
        .describe_auto_scaling_groups()
        .auto_scaling_group_names(asg_name)
        .send()
        .await
        .map_err(|e| KupError::aws(module_path!(), e))?;

    if let Some(asg) = response.auto_scaling_groups().first() {
        let total = asg.desired_capacity().unwrap_or(0);
        let healthy = asg
            .instances()
            .iter()
            .filter(|i| {
                i.health_status().map(|s| s == "Healthy").unwrap_or(false)
                    && i.lifecycle_state()
                        .map(|s| s.as_str() == "InService")
                        .unwrap_or(false)
            })
            .count() as i32;

        return Ok((healthy, total));
    }

    Ok((0, 0))
}
