//! EKS upgrade orchestration.

use anyhow::Result;
use colored::Colorize;
use indicatif::{ProgressBar, ProgressStyle};
use std::collections::HashMap;
use std::time::Duration;
use tracing::info;

use super::addon::{self, AddonInfo};
use super::client::{EksClient, calculate_upgrade_path};
use super::nodegroup::{self, NodeGroupInfo};

/// Upgrade plan for a cluster.
#[derive(Debug, Clone)]
pub struct UpgradePlan {
    pub cluster_name: String,
    pub current_version: String,
    pub target_version: String,
    pub upgrade_path: Vec<String>,
    pub addon_upgrades: Vec<(AddonInfo, String)>,
    pub nodegroup_upgrades: Vec<NodeGroupInfo>,
    pub estimated_time_minutes: u64,
}

/// Configuration for upgrade execution.
pub struct UpgradeConfig {
    pub skip_addons: bool,
    pub skip_nodegroups: bool,
    pub dry_run: bool,
    pub control_plane_timeout_minutes: u64,
    pub addon_timeout_minutes: u64,
    pub nodegroup_timeout_minutes: u64,
    pub check_interval_seconds: u64,
}

impl Default for UpgradeConfig {
    fn default() -> Self {
        Self {
            skip_addons: false,
            skip_nodegroups: false,
            dry_run: false,
            control_plane_timeout_minutes: 30,
            addon_timeout_minutes: 15,
            nodegroup_timeout_minutes: 60,
            check_interval_seconds: 30,
        }
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
        .ok_or_else(|| crate::error::EkupError::ClusterNotFound(cluster_name.to_string()))?;

    // Calculate upgrade path
    let upgrade_path = calculate_upgrade_path(&cluster.version, target_version)?;

    // Plan addon upgrades (for target version)
    let addon_upgrades =
        addon::plan_addon_upgrades(client.inner(), cluster_name, target_version, addon_versions)
            .await?;

    // Plan nodegroup upgrades
    let nodegroup_upgrades =
        nodegroup::plan_nodegroup_upgrades(client.inner(), cluster_name, target_version).await?;

    // Estimate time
    let cp_time = upgrade_path.len() as u64 * 10; // ~10 min per CP upgrade
    let addon_time = if addon_upgrades.is_empty() { 0 } else { 10 }; // ~10 min for all addons
    let ng_time = nodegroup_upgrades.len() as u64 * 20; // ~20 min per nodegroup
    let estimated_time_minutes = cp_time + addon_time + ng_time;

    Ok(UpgradePlan {
        cluster_name: cluster_name.to_string(),
        current_version: cluster.version,
        target_version: target_version.to_string(),
        upgrade_path,
        addon_upgrades,
        nodegroup_upgrades,
        estimated_time_minutes,
    })
}

/// Print the upgrade plan to console.
pub fn print_upgrade_plan(plan: &UpgradePlan) {
    println!();
    println!(
        "{}",
        format!(
            "Upgrade Plan: {} ({} -> {})",
            plan.cluster_name, plan.current_version, plan.target_version
        )
        .bold()
    );
    println!("{}", "=".repeat(60));

    // Phase 1: Control Plane
    println!();
    println!("{}", "Phase 1: Control Plane Upgrade".cyan().bold());
    let mut prev_version = plan.current_version.clone();
    for (i, version) in plan.upgrade_path.iter().enumerate() {
        println!(
            "  Step {}: {} -> {} (~10 min)",
            i + 1,
            prev_version,
            version
        );
        prev_version = version.clone();
    }

    // Phase 2: Add-ons
    if !plan.addon_upgrades.is_empty() {
        println!();
        println!(
            "{}",
            format!(
                "Phase 2: Add-on Upgrade [sequential] (to {})",
                plan.target_version
            )
            .cyan()
            .bold()
        );
        for (addon, target_version) in &plan.addon_upgrades {
            let label = if target_version.contains("latest") || target_version.contains("eksbuild")
            {
                "(latest)"
            } else {
                ""
            };
            println!(
                "  {}: {} -> {} {}",
                addon.name, addon.current_version, target_version, label
            );
        }
    }

    // Phase 3: Node Groups
    if !plan.nodegroup_upgrades.is_empty() {
        println!();
        println!(
            "{}",
            format!("Phase 3: Node Group Upgrade (to {})", plan.target_version)
                .cyan()
                .bold()
        );
        for ng in &plan.nodegroup_upgrades {
            let current = ng.version.as_deref().unwrap_or("unknown");
            println!(
                "  {}: {} -> {} (~20 min)",
                ng.name, current, plan.target_version
            );
        }
    }

    // Estimated time
    println!();
    println!("Estimated total time: ~{} min", plan.estimated_time_minutes);
    println!();
}

/// Execute the upgrade plan.
pub async fn execute_upgrade(
    client: &EksClient,
    plan: &UpgradePlan,
    config: &UpgradeConfig,
) -> Result<()> {
    if config.dry_run {
        println!(
            "{}",
            "[DRY RUN] Would execute the following upgrade:".yellow()
        );
        print_upgrade_plan(plan);
        return Ok(());
    }

    println!();
    println!("{}", "=== Executing Upgrade ===".green().bold());

    // Phase 1: Control Plane Sequential Upgrades
    println!();
    println!("{}", "=== Phase 1: Control Plane Upgrade ===".cyan().bold());

    let mut current_version = plan.current_version.clone();
    for (i, version) in plan.upgrade_path.iter().enumerate() {
        println!();
        println!(
            "{}",
            format!(
                "[Step {}/{}] {} -> {}",
                i + 1,
                plan.upgrade_path.len(),
                current_version,
                version
            )
            .bold()
        );

        // Start upgrade
        let update_id = client
            .update_cluster_version(&plan.cluster_name, version)
            .await?;

        // Show progress
        let pb = create_progress_bar(config.control_plane_timeout_minutes * 60);
        pb.set_message(format!("Upgrading control plane to {}", version));

        // Wait for completion in background
        let wait_result = client
            .wait_for_cluster_update(
                &plan.cluster_name,
                &update_id,
                config.control_plane_timeout_minutes,
                config.check_interval_seconds,
            )
            .await;

        pb.finish_with_message(format!("Control plane {} complete", version));

        wait_result?;
        current_version = version.clone();
        println!("  {} Done!", "✓".green());
    }

    println!();
    println!(
        "{}",
        format!(
            "Control Plane: {} -> {} complete!",
            plan.current_version, plan.target_version
        )
        .green()
    );

    // Phase 2: Add-on Upgrades
    if !config.skip_addons && !plan.addon_upgrades.is_empty() {
        println!();
        println!(
            "{}",
            format!(
                "=== Phase 2: Add-on Upgrade [sequential] (to {}) ===",
                plan.target_version
            )
            .cyan()
            .bold()
        );

        for (addon, target_version) in &plan.addon_upgrades {
            println!(
                "  {}: {} -> {}",
                addon.name, addon.current_version, target_version
            );
        }
        println!();

        addon::execute_addon_upgrades(
            client.inner(),
            &plan.cluster_name,
            &plan.addon_upgrades,
            config.addon_timeout_minutes,
            config.check_interval_seconds,
        )
        .await?;

        println!("  {} Add-ons upgraded!", "✓".green());
    }

    // Phase 3: Node Group Upgrades
    if !config.skip_nodegroups && !plan.nodegroup_upgrades.is_empty() {
        println!();
        println!(
            "{}",
            format!(
                "=== Phase 3: Node Group Rolling Update (to {}) ===",
                plan.target_version
            )
            .cyan()
            .bold()
        );

        for ng in &plan.nodegroup_upgrades {
            let current = ng.version.as_deref().unwrap_or("unknown");
            println!("  {}: {} -> {}", ng.name, current, plan.target_version);
        }
        println!();

        nodegroup::execute_nodegroup_upgrades(
            client.inner(),
            &plan.cluster_name,
            &plan.nodegroup_upgrades,
            &plan.target_version,
            config.nodegroup_timeout_minutes,
            config.check_interval_seconds,
        )
        .await?;

        println!("  {} Node groups upgraded!", "✓".green());
    }

    // Summary
    println!();
    println!("{}", "=".repeat(60));
    println!(
        "{}",
        format!(
            "Upgrade complete: {} -> {}",
            plan.current_version, plan.target_version
        )
        .green()
        .bold()
    );
    println!("{}", "=".repeat(60));

    Ok(())
}

/// Create a progress bar for long-running operations.
fn create_progress_bar(duration_secs: u64) -> ProgressBar {
    let pb = ProgressBar::new(duration_secs);
    pb.set_style(
        ProgressStyle::default_bar()
            .template("{spinner:.green} [{elapsed_precise}] {bar:40.cyan/blue} {msg}")
            .unwrap()
            .progress_chars("=>-"),
    );
    pb.enable_steady_tick(Duration::from_secs(1));
    pb
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_upgrade_config_default() {
        let config = UpgradeConfig::default();

        assert!(!config.skip_addons);
        assert!(!config.skip_nodegroups);
        assert!(!config.dry_run);
        assert_eq!(config.control_plane_timeout_minutes, 30);
        assert_eq!(config.addon_timeout_minutes, 15);
        assert_eq!(config.nodegroup_timeout_minutes, 60);
        assert_eq!(config.check_interval_seconds, 30);
    }

    #[test]
    fn test_upgrade_plan_creation() {
        let plan = UpgradePlan {
            cluster_name: "test-cluster".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.34".to_string(),
            upgrade_path: vec!["1.33".to_string(), "1.34".to_string()],
            addon_upgrades: vec![],
            nodegroup_upgrades: vec![],
            estimated_time_minutes: 40,
        };

        assert_eq!(plan.cluster_name, "test-cluster");
        assert_eq!(plan.upgrade_path.len(), 2);
        assert_eq!(plan.estimated_time_minutes, 40);
    }
}
