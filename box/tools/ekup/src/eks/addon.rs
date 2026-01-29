//! EKS Add-on operations.

use anyhow::Result;
use aws_sdk_eks::Client;
use std::collections::HashMap;
use tracing::{debug, info, warn};

use super::types::{PlanResult, VersionedResource};
use crate::error::EkupError;

/// Progress context for addon upgrade tracking.
struct ProgressContext {
    pb: indicatif::ProgressBar,
    index: usize,
    total: usize,
}

/// Add-on information.
#[derive(Debug, Clone)]
pub struct AddonInfo {
    pub name: String,
    pub current_version: String,
}

impl VersionedResource for AddonInfo {
    fn name(&self) -> &str {
        &self.name
    }

    fn current_version(&self) -> &str {
        &self.current_version
    }
}

/// Add-on version information.
#[derive(Debug, Clone)]
pub struct AddonVersionInfo {
    pub version: String,
    pub default_version: bool,
}

/// Type alias for addon upgrade item (addon info + target version).
pub type AddonUpgrade = (AddonInfo, String);

/// Type alias for addon plan result.
pub type AddonPlanResult = PlanResult<AddonInfo, AddonUpgrade>;

/// List all add-ons installed on a cluster.
pub async fn list_addons(client: &Client, cluster_name: &str) -> Result<Vec<AddonInfo>> {
    debug!("Listing add-ons for cluster: {}", cluster_name);

    let response = client
        .list_addons()
        .cluster_name(cluster_name)
        .send()
        .await
        .map_err(EkupError::aws)?;

    let mut addons = Vec::new();

    for addon_name in response.addons() {
        if let Some(info) = describe_addon(client, cluster_name, addon_name).await? {
            addons.push(info);
        }
    }

    debug!("Found {} add-ons", addons.len());
    Ok(addons)
}

/// Describe a specific add-on.
pub async fn describe_addon(
    client: &Client,
    cluster_name: &str,
    addon_name: &str,
) -> Result<Option<AddonInfo>> {
    debug!("Describing add-on: {}", addon_name);

    let response = client
        .describe_addon()
        .cluster_name(cluster_name)
        .addon_name(addon_name)
        .send()
        .await
        .map_err(EkupError::aws)?;

    if let Some(addon) = response.addon() {
        let info = AddonInfo {
            name: addon.addon_name().unwrap_or_default().to_string(),
            current_version: addon.addon_version().unwrap_or_default().to_string(),
        };
        return Ok(Some(info));
    }

    Ok(None)
}

/// Get available versions for an add-on compatible with a specific Kubernetes version.
pub async fn get_compatible_versions(
    client: &Client,
    addon_name: &str,
    k8s_version: &str,
) -> Result<Vec<AddonVersionInfo>> {
    debug!(
        "Getting compatible versions for {} with K8s {}",
        addon_name, k8s_version
    );

    let response = client
        .describe_addon_versions()
        .addon_name(addon_name)
        .kubernetes_version(k8s_version)
        .send()
        .await
        .map_err(EkupError::aws)?;

    let mut versions = Vec::new();

    for addon in response.addons() {
        for version_info in addon.addon_versions() {
            versions.push(AddonVersionInfo {
                version: version_info.addon_version().unwrap_or_default().to_string(),
                default_version: version_info
                    .compatibilities()
                    .iter()
                    .any(|c| c.default_version()),
            });
        }
    }

    // Sort by version (latest first)
    versions.sort_by(|a, b| b.version.cmp(&a.version));

    Ok(versions)
}

/// Get the latest compatible version for an add-on.
pub async fn get_latest_compatible_version(
    client: &Client,
    addon_name: &str,
    k8s_version: &str,
) -> Result<Option<String>> {
    let versions = get_compatible_versions(client, addon_name, k8s_version).await?;

    // Prefer default version, otherwise take the first (latest)
    if let Some(default) = versions.iter().find(|v| v.default_version) {
        return Ok(Some(default.version.clone()));
    }

    Ok(versions.first().map(|v| v.version.clone()))
}

/// Update an add-on to a specific version.
pub async fn update_addon(
    client: &Client,
    cluster_name: &str,
    addon_name: &str,
    target_version: &str,
) -> Result<String> {
    info!(
        "Updating add-on {} to version {}",
        addon_name, target_version
    );

    let response = client
        .update_addon()
        .cluster_name(cluster_name)
        .addon_name(addon_name)
        .addon_version(target_version)
        .resolve_conflicts(aws_sdk_eks::types::ResolveConflicts::Overwrite)
        .send()
        .await
        .map_err(EkupError::aws)?;

    let update_id = response
        .update()
        .and_then(|u| u.id())
        .map(|s| s.to_string())
        .unwrap_or_default();

    info!("Add-on update initiated: {}", update_id);
    Ok(update_id)
}

/// Plan add-on upgrades to target Kubernetes version.
pub async fn plan_addon_upgrades(
    client: &Client,
    cluster_name: &str,
    target_k8s_version: &str,
    specified_versions: &HashMap<String, String>,
) -> Result<AddonPlanResult> {
    let current_addons = list_addons(client, cluster_name).await?;
    let addon_count = current_addons.len();
    let mut result = AddonPlanResult::new();

    for addon in current_addons {
        // Check if user specified a version for this add-on
        let target_version = if let Some(specified) = specified_versions.get(&addon.name) {
            specified.clone()
        } else {
            // Get latest compatible version
            match get_latest_compatible_version(client, &addon.name, target_k8s_version).await? {
                Some(version) => version,
                None => {
                    warn!(
                        "No compatible version found for {} with K8s {}",
                        addon.name, target_k8s_version
                    );
                    result.add_skipped(
                        addon,
                        format!("no compatible version for K8s {}", target_k8s_version),
                    );
                    continue;
                }
            }
        };

        if target_version != addon.current_version {
            result.add_upgrade((addon, target_version));
        } else {
            result.add_skipped(addon, "already at compatible version");
        }
    }

    info!(
        "Found {} add-ons ({} to upgrade, {} skipped)",
        addon_count,
        result.upgrade_count(),
        result.skipped_count()
    );
    Ok(result)
}

/// Execute add-on upgrades sequentially with real-time status.
pub async fn execute_addon_upgrades(
    client: &Client,
    cluster_name: &str,
    upgrades: &[AddonUpgrade],
    timeout_minutes: u64,
    check_interval_seconds: u64,
) -> Result<()> {
    use indicatif::{ProgressBar, ProgressStyle};
    use std::time::Duration;

    let style = ProgressStyle::default_spinner()
        .template("{spinner:.cyan} {msg}")
        .unwrap();

    let total = upgrades.len();
    for (i, (addon, target_version)) in upgrades.iter().enumerate() {
        let pb = ProgressBar::new_spinner();
        pb.set_style(style.clone());
        pb.set_message(format!(
            "[{}/{}] {}: starting upgrade...",
            i + 1,
            total,
            addon.name
        ));
        pb.enable_steady_tick(Duration::from_millis(100));

        let update_id = update_addon(client, cluster_name, &addon.name, target_version).await?;

        let ctx = ProgressContext {
            pb,
            index: i + 1,
            total,
        };
        wait_for_addon_update_with_progress(
            client.clone(),
            cluster_name.to_string(),
            addon.name.clone(),
            update_id,
            timeout_minutes,
            check_interval_seconds,
            ctx,
        )
        .await?;
    }

    Ok(())
}

/// Wait for add-on update with progress bar updates.
async fn wait_for_addon_update_with_progress(
    client: Client,
    cluster_name: String,
    addon_name: String,
    update_id: String,
    timeout_minutes: u64,
    check_interval_seconds: u64,
    ctx: ProgressContext,
) -> Result<()> {
    use std::time::{Duration, Instant};

    let timeout = Duration::from_secs(timeout_minutes * 60);
    let interval = Duration::from_secs(check_interval_seconds);
    let start = Instant::now();

    loop {
        if start.elapsed() > timeout {
            ctx.pb.finish_with_message(format!(
                "[{}/{}] {}: timeout",
                ctx.index, ctx.total, addon_name
            ));
            return Err(EkupError::Timeout {
                operation: format!("add-on {} update", addon_name),
                details: format!(
                    "Update {} did not complete within {} minutes",
                    update_id, timeout_minutes
                ),
            }
            .into());
        }

        let response = client
            .describe_addon()
            .cluster_name(&cluster_name)
            .addon_name(&addon_name)
            .send()
            .await
            .map_err(EkupError::aws)?;

        if let Some(addon) = response.addon() {
            let status = addon.status().map(|s| s.as_str()).unwrap_or("Unknown");
            ctx.pb.set_message(format!(
                "[{}/{}] {}: {}",
                ctx.index, ctx.total, addon_name, status
            ));

            match status {
                "ACTIVE" => {
                    ctx.pb.finish_with_message(format!(
                        "[{}/{}] {}: done",
                        ctx.index, ctx.total, addon_name
                    ));
                    return Ok(());
                }
                "CREATE_FAILED" | "UPDATE_FAILED" | "DELETE_FAILED" | "DEGRADED" => {
                    ctx.pb.finish_with_message(format!(
                        "[{}/{}] {}: failed",
                        ctx.index, ctx.total, addon_name
                    ));
                    return Err(EkupError::AddonError(format!(
                        "Add-on {} update failed with status: {}",
                        addon_name, status
                    ))
                    .into());
                }
                _ => {
                    // CREATING, UPDATING, DELETING
                    tokio::time::sleep(interval).await;
                }
            }
        } else {
            tokio::time::sleep(interval).await;
        }
    }
}
