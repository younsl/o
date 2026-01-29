//! EKS upgrade orchestration.

use anyhow::Result;
use colored::Colorize;
use indicatif::{ProgressBar, ProgressStyle};
use std::collections::HashMap;
use std::time::Duration;
use tracing::info;

use super::addon::{self, AddonInfo, AddonUpgrade};
use super::client::{EksClient, calculate_upgrade_path};
use super::nodegroup::{self, NodeGroupInfo};
use super::types::{Skipped, VersionedResource};

// Re-export for backward compatibility
pub type SkippedAddon = Skipped<AddonInfo>;
pub type SkippedNodeGroup = Skipped<NodeGroupInfo>;

/// Upgrade plan for a cluster.
#[derive(Debug, Clone)]
pub struct UpgradePlan {
    pub cluster_name: String,
    pub current_version: String,
    pub target_version: String,
    pub upgrade_path: Vec<String>,
    pub addon_upgrades: Vec<AddonUpgrade>,
    pub skipped_addons: Vec<SkippedAddon>,
    pub nodegroup_upgrades: Vec<NodeGroupInfo>,
    pub skipped_nodegroups: Vec<SkippedNodeGroup>,
}

/// Configuration for upgrade execution.
pub struct UpgradeConfig {
    pub skip_addons: bool,
    pub skip_nodegroups: bool,
    pub skip_control_plane: bool,
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
            skip_control_plane: false,
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
    let addon_result =
        addon::plan_addon_upgrades(client.inner(), cluster_name, target_version, addon_versions)
            .await?;

    // Plan nodegroup upgrades
    let nodegroup_result =
        nodegroup::plan_nodegroup_upgrades(client.inner(), cluster_name, target_version).await?;

    Ok(UpgradePlan {
        cluster_name: cluster_name.to_string(),
        current_version: cluster.version,
        target_version: target_version.to_string(),
        upgrade_path,
        addon_upgrades: addon_result.upgrades,
        skipped_addons: addon_result.skipped,
        nodegroup_upgrades: nodegroup_result.upgrades,
        skipped_nodegroups: nodegroup_result.skipped,
    })
}

/// Calculate estimated time for upgrade plan.
pub fn calculate_estimated_time(plan: &UpgradePlan, skip_control_plane: bool) -> u64 {
    let cp_time = if skip_control_plane {
        0
    } else {
        plan.upgrade_path.len() as u64 * 10
    };
    let addon_time = if plan.addon_upgrades.is_empty() {
        0
    } else {
        10
    };
    let ng_time = plan.nodegroup_upgrades.len() as u64 * 20;
    cp_time + addon_time + ng_time
}

// ============================================================================
// Display Helper Functions (DRY)
// ============================================================================

/// Print a phase header.
fn print_phase_header(phase: u8, title: &str, target_version: &str, skipped: bool) {
    let status = if skipped { " [SKIPPED]" } else { "" };
    let header = format!(
        "Phase {}: {}{} (to {})",
        phase, title, status, target_version
    );
    println!("{}", header.cyan().bold());
}

/// Print a phase header for execution.
fn print_exec_phase_header(phase: u8, title: &str, target_version: &str, skipped: bool) {
    let status = if skipped { " [SKIPPED]" } else { "" };
    let header = format!(
        "=== Phase {}: {}{} (to {}) ===",
        phase, title, status, target_version
    );
    println!("{}", header.cyan().bold());
}

/// Print skipped resources.
fn print_skipped<T: VersionedResource>(skipped: &[Skipped<T>], dimmed: bool) {
    for item in skipped {
        if dimmed {
            println!(
                "  {}: {} {}",
                item.info.name().dimmed(),
                item.info.current_version().dimmed(),
                format!("({})", item.reason).dimmed()
            );
        } else {
            println!(
                "  {} {}: {} ({})",
                "→".cyan(),
                item.info.name(),
                item.info.current_version(),
                item.reason
            );
        }
    }
}

// ============================================================================
// Print Upgrade Plan
// ============================================================================

/// Print the upgrade plan to console.
pub fn print_upgrade_plan(plan: &UpgradePlan, skip_control_plane: bool) {
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
    if skip_control_plane {
        println!(
            "{}",
            "Phase 1: Control Plane Upgrade [SKIPPED]".cyan().bold()
        );
        println!(
            "  Current version: {} (no upgrade needed)",
            plan.current_version
        );
    } else {
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
    }

    // Phase 2: Add-ons
    println!();
    let addon_skipped = plan.addon_upgrades.is_empty();
    print_phase_header(2, "Add-on Upgrade [sequential]", &plan.target_version, addon_skipped);

    for (addon, target_version) in &plan.addon_upgrades {
        let label = if target_version.contains("eksbuild") {
            "(latest)"
        } else {
            ""
        };
        println!(
            "  {}: {} -> {} {}",
            addon.name, addon.current_version, target_version, label
        );
    }
    print_skipped(&plan.skipped_addons, true);

    // Phase 3: Node Groups
    println!();
    let ng_skipped = plan.nodegroup_upgrades.is_empty();
    print_phase_header(3, "Node Group Upgrade", &plan.target_version, ng_skipped);

    for ng in &plan.nodegroup_upgrades {
        println!(
            "  {}: {} -> {} (~20 min)",
            ng.name,
            ng.current_version(),
            plan.target_version
        );
    }
    print_skipped(&plan.skipped_nodegroups, true);

    // Estimated time
    let estimated_time = calculate_estimated_time(plan, skip_control_plane);
    println!();
    println!("Estimated total time: ~{} min", estimated_time);
    println!();
}

// ============================================================================
// Execute Upgrade
// ============================================================================

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
        print_upgrade_plan(plan, config.skip_control_plane);
        return Ok(());
    }

    println!();
    println!("{}", "=== Executing Upgrade ===".green().bold());

    // Phase 1: Control Plane
    execute_control_plane_phase(client, plan, config).await?;

    // Phase 2: Add-ons
    execute_addon_phase(client, plan, config).await?;

    // Phase 3: Node Groups
    execute_nodegroup_phase(client, plan, config).await?;

    // Summary
    print_summary(plan, config.skip_control_plane);

    Ok(())
}

/// Execute control plane upgrade phase.
async fn execute_control_plane_phase(
    client: &EksClient,
    plan: &UpgradePlan,
    config: &UpgradeConfig,
) -> Result<()> {
    println!();

    if !config.skip_control_plane && !plan.upgrade_path.is_empty() {
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

            let update_id = client
                .update_cluster_version(&plan.cluster_name, version)
                .await?;

            let pb = create_progress_bar(config.control_plane_timeout_minutes * 60);
            pb.set_message(format!("Upgrading control plane to {}", version));

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
    } else {
        println!(
            "{}",
            "=== Phase 1: Control Plane Upgrade [SKIPPED] ==="
                .cyan()
                .bold()
        );
        println!("  {} Current version: {}", "→".cyan(), plan.current_version);
    }

    Ok(())
}

/// Execute addon upgrade phase.
async fn execute_addon_phase(
    client: &EksClient,
    plan: &UpgradePlan,
    config: &UpgradeConfig,
) -> Result<()> {
    println!();

    let should_upgrade = !config.skip_addons && !plan.addon_upgrades.is_empty();
    print_exec_phase_header(2, "Add-on Upgrade [sequential]", &plan.target_version, !should_upgrade);

    if should_upgrade {
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
    } else {
        print_skipped(&plan.skipped_addons, false);
    }

    Ok(())
}

/// Execute nodegroup upgrade phase.
async fn execute_nodegroup_phase(
    client: &EksClient,
    plan: &UpgradePlan,
    config: &UpgradeConfig,
) -> Result<()> {
    println!();

    let should_upgrade = !config.skip_nodegroups && !plan.nodegroup_upgrades.is_empty();
    print_exec_phase_header(3, "Node Group Rolling Update", &plan.target_version, !should_upgrade);

    if should_upgrade {
        for ng in &plan.nodegroup_upgrades {
            println!("  {}: {} -> {}", ng.name, ng.current_version(), plan.target_version);
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
    } else {
        print_skipped(&plan.skipped_nodegroups, false);
    }

    Ok(())
}

/// Print final summary.
fn print_summary(plan: &UpgradePlan, skip_control_plane: bool) {
    println!();
    println!("{}", "=".repeat(60));

    let message = if skip_control_plane {
        format!(
            "Sync complete: {} addons/nodegroups updated to {}",
            plan.cluster_name, plan.target_version
        )
    } else {
        format!(
            "Upgrade complete: {} -> {}",
            plan.current_version, plan.target_version
        )
    };

    println!("{}", message.green().bold());
    println!("{}", "=".repeat(60));
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

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_upgrade_config_default() {
        let config = UpgradeConfig::default();

        assert!(!config.skip_addons);
        assert!(!config.skip_nodegroups);
        assert!(!config.skip_control_plane);
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
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
        };

        assert_eq!(plan.cluster_name, "test-cluster");
        assert_eq!(plan.upgrade_path.len(), 2);
    }

    #[test]
    fn test_calculate_estimated_time_with_control_plane() {
        let plan = UpgradePlan {
            cluster_name: "test-cluster".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.34".to_string(),
            upgrade_path: vec!["1.33".to_string(), "1.34".to_string()],
            addon_upgrades: vec![],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
        };

        // With control plane: 2 steps * 10 min = 20 min
        let time = calculate_estimated_time(&plan, false);
        assert_eq!(time, 20);
    }

    #[test]
    fn test_calculate_estimated_time_skip_control_plane() {
        let plan = UpgradePlan {
            cluster_name: "test-cluster".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
        };

        // Skip control plane: 0 min (no addons/nodegroups either)
        let time = calculate_estimated_time(&plan, true);
        assert_eq!(time, 0);
    }

    #[test]
    fn test_skipped_addon_creation() {
        let addon = AddonInfo {
            name: "coredns".to_string(),
            current_version: "v1.11.3-eksbuild.2".to_string(),
        };
        let skipped = SkippedAddon::new(addon, "already at compatible version");

        assert_eq!(skipped.info.name(), "coredns");
        assert_eq!(skipped.reason, "already at compatible version");
    }

    #[test]
    fn test_skipped_nodegroup_creation() {
        let ng = NodeGroupInfo {
            name: "ng-system".to_string(),
            version: Some("1.32".to_string()),
        };
        let skipped = SkippedNodeGroup::new(ng, "already at target version");

        assert_eq!(skipped.info.name(), "ng-system");
        assert_eq!(skipped.reason, "already at target version");
    }
}
