//! EKS upgrade orchestration.

use anyhow::Result;
use chrono::Local;
use colored::Colorize;
use indicatif::{ProgressBar, ProgressStyle};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::info;

use crate::output::report::{PhaseStatus, PhaseTiming};

use super::addon::{self, AddonInfo, AddonUpgrade};
use super::client::{EksClient, calculate_upgrade_path};
use super::nodegroup::{self, NodeGroupInfo, format_rolling_strategy};
use super::preflight::{
    PreflightCheckResult, PreflightResults, SkippedCheck, format_ami_selector_term,
};
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
    pub preflight: PreflightResults,
}

impl UpgradePlan {
    /// Returns true if there's nothing to upgrade (all components already at target version).
    pub fn is_empty(&self) -> bool {
        self.upgrade_path.is_empty()
            && self.addon_upgrades.is_empty()
            && self.nodegroup_upgrades.is_empty()
    }

    /// Returns true if any mandatory preflight check has failed.
    pub fn has_mandatory_failures(&self) -> bool {
        self.preflight.has_mandatory_failures()
    }

    /// Returns human-readable descriptions of failed mandatory preflight checks.
    pub fn mandatory_failure_reasons(&self) -> Vec<String> {
        self.preflight.mandatory_failure_reasons()
    }
}

/// Configuration for upgrade execution.
pub struct UpgradeConfig {
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
            skip_control_plane: false,
            dry_run: false,
            control_plane_timeout_minutes: 30,
            addon_timeout_minutes: 15,
            nodegroup_timeout_minutes: 60,
            check_interval_seconds: 10,
        }
    }
}

/// Create an upgrade plan for a cluster.
pub async fn create_upgrade_plan(
    client: &EksClient,
    cluster_name: &str,
    target_version: &str,
    addon_versions: &HashMap<String, String>,
    profile: Option<&str>,
) -> Result<UpgradePlan> {
    info!(
        "Creating upgrade plan for {} to version {}",
        cluster_name, target_version
    );

    // Get current cluster info
    let cluster = client
        .describe_cluster(cluster_name)
        .await?
        .ok_or_else(|| crate::error::KupError::ClusterNotFound(cluster_name.to_string()))?;

    // Calculate upgrade path
    let upgrade_path = calculate_upgrade_path(&cluster.version, target_version)?;

    // Plan addon upgrades (for target version)
    let addon_result =
        addon::plan_addon_upgrades(client.inner(), cluster_name, target_version, addon_versions)
            .await?;

    // Plan nodegroup upgrades
    let nodegroup_result =
        nodegroup::plan_nodegroup_upgrades(client.inner(), cluster_name, target_version).await?;

    // Build preflight results
    let mut preflight = PreflightResults::default();

    // Deletion protection check
    match cluster.deletion_protection {
        Some(enabled) => {
            preflight
                .checks
                .push(PreflightCheckResult::deletion_protection(enabled));
        }
        None => {
            preflight
                .skipped
                .push(SkippedCheck::deletion_protection("unable to determine"));
        }
    }

    // Build kube client once for PDB and Karpenter checks (non-fatal)
    let kube_client = if !nodegroup_result.upgrades.is_empty() {
        match crate::k8s::client::build_kube_client(&cluster, client.region(), profile).await {
            Ok(c) => Some(c),
            Err(e) => {
                tracing::warn!("Failed to build Kubernetes client (non-fatal): {}", e);
                None
            }
        }
    } else {
        None
    };

    // PDB drain deadlock check (only when nodegroup upgrades exist)
    if !nodegroup_result.upgrades.is_empty() {
        if let Some(ref kc) = kube_client {
            match crate::k8s::pdb::check_pdbs(kc).await {
                Ok(summary) => {
                    preflight
                        .checks
                        .push(PreflightCheckResult::pdb_drain_deadlock(summary));
                }
                Err(e) => {
                    tracing::warn!("PDB check failed (non-fatal): {}", e);
                    preflight.skipped.push(SkippedCheck::pdb_drain_deadlock(
                        "Kubernetes API unavailable",
                    ));
                }
            }
        } else {
            preflight.skipped.push(SkippedCheck::pdb_drain_deadlock(
                "Kubernetes API unavailable",
            ));
        }
    } else {
        preflight.skipped.push(SkippedCheck::pdb_drain_deadlock(
            "no managed node group upgrades",
        ));
    }

    // Karpenter EC2NodeClass check (only when nodegroup upgrades exist)
    if !nodegroup_result.upgrades.is_empty() {
        if let Some(ref kc) = kube_client {
            match crate::k8s::karpenter::check_ec2_node_classes(kc).await {
                Ok(summary) if !summary.node_classes.is_empty() => {
                    preflight
                        .checks
                        .push(PreflightCheckResult::karpenter_ami_config(summary));
                }
                Ok(_) => {
                    preflight
                        .skipped
                        .push(SkippedCheck::karpenter_ami_config("Karpenter not in use"));
                }
                Err(e) => {
                    tracing::warn!("Karpenter EC2NodeClass check failed (non-fatal): {}", e);
                    preflight.skipped.push(SkippedCheck::karpenter_ami_config(
                        "Kubernetes API unavailable or Karpenter not in use",
                    ));
                }
            }
        } else {
            preflight.skipped.push(SkippedCheck::karpenter_ami_config(
                "Kubernetes API unavailable or Karpenter not in use",
            ));
        }
    } else {
        preflight.skipped.push(SkippedCheck::karpenter_ami_config(
            "no managed node group upgrades",
        ));
    }

    Ok(UpgradePlan {
        cluster_name: cluster_name.to_string(),
        current_version: cluster.version,
        target_version: target_version.to_string(),
        upgrade_path,
        addon_upgrades: addon_result.upgrades,
        skipped_addons: addon_result.skipped,
        nodegroup_upgrades: nodegroup_result.upgrades,
        skipped_nodegroups: nodegroup_result.skipped,
        preflight,
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

/// Print skipped managed node groups with rolling strategy info.
fn print_skipped_nodegroups(skipped: &[SkippedNodeGroup], dimmed: bool) {
    for item in skipped {
        let rolling_strategy = format_rolling_strategy(&item.info);
        if dimmed {
            println!(
                "  {}: {} {} {}",
                item.info.name.dimmed(),
                item.info.current_version().dimmed(),
                format!("({})", item.reason).dimmed(),
                format!("[{}]", rolling_strategy).dimmed()
            );
        } else {
            println!(
                "  {} {}: {} ({}) [{}]",
                "→".cyan(),
                item.info.name,
                item.info.current_version(),
                item.reason,
                rolling_strategy
            );
        }
    }
}

/// Print detailed output for a single preflight check result.
fn print_check_details(check: &super::preflight::PreflightCheckResult, target_version: &str) {
    use super::preflight::{CheckKind, CheckStatus};

    match &check.kind {
        CheckKind::DeletionProtection { enabled } => {
            if *enabled {
                println!("  {} Deletion protection is enabled", "✓".green());
            } else {
                println!("  {} Deletion protection is disabled", "✗".red());
            }
        }
        CheckKind::PdbDrainDeadlock { summary } => {
            if summary.has_blocking_pdbs() {
                for finding in &summary.findings {
                    println!(
                        "  {} {}/{}: {}",
                        "✗".red(),
                        finding.namespace,
                        finding.name,
                        finding.reason()
                    );
                }
                println!(
                    "  {} {}/{} PDB(s) may block node drain during rolling update",
                    "✗".red(),
                    summary.blocking_count,
                    summary.total_pdbs
                );
                println!(
                    "  {} Consider scaling up replicas or adjusting PDB before proceeding",
                    "→".cyan()
                );
            } else {
                println!(
                    "  {} No PDB drain deadlock detected ({} PDBs checked)",
                    "✓".green(),
                    summary.total_pdbs
                );
            }
        }
        CheckKind::KarpenterAmiConfig { summary } => {
            for nc in &summary.node_classes {
                if nc.ami_selector_terms.is_empty() {
                    println!(
                        "  {} {}: {}",
                        "⚠".yellow(),
                        nc.name,
                        "(no amiSelectorTerms)".dimmed()
                    );
                } else {
                    for term in &nc.ami_selector_terms {
                        let desc = format_ami_selector_term(term);
                        println!("  {} {}: {}", "✓".green(), nc.name, desc);
                    }
                }
            }
            if check.status == CheckStatus::Info {
                println!(
                    "  {} {} EC2NodeClass(es) detected in cluster",
                    "✓".green(),
                    summary.node_classes.len()
                );
                println!(
                    "  {} Verify amiSelectorTerms compatibility with {} before upgrading",
                    "→".cyan(),
                    target_version
                );
            }
        }
    }
}

// ============================================================================
// Print Upgrade Plan
// ============================================================================

/// Print the upgrade plan to console.
pub fn print_upgrade_plan(plan: &UpgradePlan, skip_control_plane: bool) {
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
    print_phase_header(
        2,
        "Add-on Upgrade [sequential]",
        &plan.target_version,
        addon_skipped,
    );

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

    // Phase 3: Managed Node Groups
    println!();
    let ng_skipped = plan.nodegroup_upgrades.is_empty();
    print_phase_header(
        3,
        "Managed Node Group Upgrade",
        &plan.target_version,
        ng_skipped,
    );

    for ng in &plan.nodegroup_upgrades {
        let rolling_strategy = format_rolling_strategy(ng);
        println!(
            "  {}: {} -> {} ({} nodes, {})",
            ng.name,
            ng.current_version(),
            plan.target_version,
            ng.desired_size,
            rolling_strategy
        );
    }
    print_skipped_nodegroups(&plan.skipped_nodegroups, true);

    // Preflight Checks
    println!();
    println!("{}", "Preflight Checks:".cyan().bold());

    // --- Mandatory ---
    println!("  {}", "[Mandatory]".red().bold());
    for check in plan.preflight.mandatory_checks() {
        println!("  {}", format!("{}:", check.name).yellow().bold());
        println!("  {}", "─".repeat(38).dimmed());
        print_check_details(check, &plan.target_version);
    }
    for skip in plan.preflight.mandatory_skipped() {
        println!("  {}", format!("{}:", skip.name).yellow().bold());
        println!("  {}", "─".repeat(38).dimmed());
        println!("  {} Skipped ({})", "−".dimmed(), skip.reason);
    }

    // --- Informational ---
    println!();
    println!("  {}", "[Informational]".dimmed().bold());
    for check in plan.preflight.informational_checks() {
        println!("  {}", format!("{}:", check.name).yellow().bold());
        println!("  {}", "─".repeat(38).dimmed());
        print_check_details(check, &plan.target_version);
    }
    for skip in plan.preflight.informational_skipped() {
        println!("  {}", format!("{}:", skip.name).yellow().bold());
        println!("  {}", "─".repeat(38).dimmed());
        println!("  {} Skipped ({})", "−".dimmed(), skip.reason);
    }

    // Estimated time
    let estimated_time = calculate_estimated_time(plan, skip_control_plane);
    println!();
    println!("Estimated total time: ~{} min", estimated_time);
    println!();
}

// ============================================================================
// Execute Upgrade
// ============================================================================

/// Execute the upgrade plan, returning per-phase timing data.
pub async fn execute_upgrade(
    client: &EksClient,
    plan: &UpgradePlan,
    config: &UpgradeConfig,
) -> Result<Vec<PhaseTiming>> {
    if config.dry_run {
        println!(
            "{}",
            "[DRY RUN] Would execute the following upgrade:".yellow()
        );
        print_upgrade_plan(plan, config.skip_control_plane);
        return Ok(vec![]);
    }

    println!();
    println!("{}", "=== Executing Upgrade ===".green().bold());

    let time_fmt = "%Y-%m-%d %H:%M:%S";
    let mut timings = Vec::with_capacity(3);

    // Phase 1: Control Plane
    let cp_skipped = config.skip_control_plane || plan.upgrade_path.is_empty();
    let started = Local::now().format(time_fmt).to_string();
    let instant = Instant::now();
    execute_control_plane_phase(client, plan, config).await?;
    timings.push(if cp_skipped {
        PhaseTiming {
            phase_name: "Control Plane".to_string(),
            started_at: None,
            completed_at: None,
            duration_secs: None,
            status: PhaseStatus::Skipped,
        }
    } else {
        PhaseTiming {
            phase_name: "Control Plane".to_string(),
            started_at: Some(started),
            completed_at: Some(Local::now().format(time_fmt).to_string()),
            duration_secs: Some(instant.elapsed().as_secs()),
            status: PhaseStatus::Completed,
        }
    });

    // Phase 2: Add-ons
    let addons_skipped = plan.addon_upgrades.is_empty();
    let started = Local::now().format(time_fmt).to_string();
    let instant = Instant::now();
    execute_addon_phase(client, plan, config).await?;
    timings.push(if addons_skipped {
        PhaseTiming {
            phase_name: "Add-ons".to_string(),
            started_at: None,
            completed_at: None,
            duration_secs: None,
            status: PhaseStatus::Skipped,
        }
    } else {
        PhaseTiming {
            phase_name: "Add-ons".to_string(),
            started_at: Some(started),
            completed_at: Some(Local::now().format(time_fmt).to_string()),
            duration_secs: Some(instant.elapsed().as_secs()),
            status: PhaseStatus::Completed,
        }
    });

    // Phase 3: Managed Node Groups
    let ng_skipped = plan.nodegroup_upgrades.is_empty();
    let started = Local::now().format(time_fmt).to_string();
    let instant = Instant::now();
    execute_nodegroup_phase(client, plan, config).await?;
    timings.push(if ng_skipped {
        PhaseTiming {
            phase_name: "Node Groups".to_string(),
            started_at: None,
            completed_at: None,
            duration_secs: None,
            status: PhaseStatus::Skipped,
        }
    } else {
        PhaseTiming {
            phase_name: "Node Groups".to_string(),
            started_at: Some(started),
            completed_at: Some(Local::now().format(time_fmt).to_string()),
            duration_secs: Some(instant.elapsed().as_secs()),
            status: PhaseStatus::Completed,
        }
    });

    // Summary
    print_summary(plan, config.skip_control_plane);

    Ok(timings)
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

    let has_upgrades = !plan.addon_upgrades.is_empty();
    print_exec_phase_header(
        2,
        "Add-on Upgrade [sequential]",
        &plan.target_version,
        !has_upgrades,
    );

    if has_upgrades {
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

    let has_upgrades = !plan.nodegroup_upgrades.is_empty();
    print_exec_phase_header(
        3,
        "Managed Node Group Rolling Update",
        &plan.target_version,
        !has_upgrades,
    );

    if has_upgrades {
        for ng in &plan.nodegroup_upgrades {
            let rolling_strategy = format_rolling_strategy(ng);
            println!(
                "  {}: {} -> {} ({} nodes, {})",
                ng.name,
                ng.current_version(),
                plan.target_version,
                ng.desired_size,
                rolling_strategy
            );
        }
        println!();

        nodegroup::execute_nodegroup_upgrades(
            client.inner(),
            client.asg(),
            &plan.cluster_name,
            &plan.nodegroup_upgrades,
            &plan.target_version,
            config.nodegroup_timeout_minutes,
            config.check_interval_seconds,
        )
        .await?;
    } else {
        print_skipped_nodegroups(&plan.skipped_nodegroups, false);
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

        assert!(!config.skip_control_plane);
        assert!(!config.dry_run);
        assert_eq!(config.control_plane_timeout_minutes, 30);
        assert_eq!(config.addon_timeout_minutes, 15);
        assert_eq!(config.nodegroup_timeout_minutes, 60);
        assert_eq!(config.check_interval_seconds, 10);
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
            preflight: PreflightResults::default(),
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
            preflight: PreflightResults::default(),
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
            preflight: PreflightResults::default(),
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
            desired_size: 3,
            max_unavailable: None,
            max_unavailable_percentage: Some(25),
            asg_name: None,
        };
        let skipped = SkippedNodeGroup::new(ng, "already at target version");

        assert_eq!(skipped.info.name(), "ng-system");
        assert_eq!(skipped.reason, "already at target version");
    }

    #[test]
    fn test_format_rolling_strategy_percentage() {
        let ng = NodeGroupInfo {
            name: "ng-test".to_string(),
            version: Some("1.32".to_string()),
            desired_size: 10,
            max_unavailable: None,
            max_unavailable_percentage: Some(25),
            asg_name: None,
        };
        let strategy = format_rolling_strategy(&ng);
        assert_eq!(strategy, "25% = 2 at a time");
    }

    #[test]
    fn test_format_rolling_strategy_count() {
        let ng = NodeGroupInfo {
            name: "ng-test".to_string(),
            version: Some("1.32".to_string()),
            desired_size: 10,
            max_unavailable: Some(3),
            max_unavailable_percentage: None,
            asg_name: None,
        };
        let strategy = format_rolling_strategy(&ng);
        assert_eq!(strategy, "3 at a time");
    }

    #[test]
    fn test_format_rolling_strategy_default() {
        let ng = NodeGroupInfo {
            name: "ng-test".to_string(),
            version: Some("1.32".to_string()),
            desired_size: 10,
            max_unavailable: None,
            max_unavailable_percentage: None,
            asg_name: None,
        };
        let strategy = format_rolling_strategy(&ng);
        assert_eq!(strategy, "1 at a time (default)");
    }

    #[test]
    fn test_format_rolling_strategy_percentage_zero_desired() {
        let ng = NodeGroupInfo {
            name: "ng-test".to_string(),
            version: Some("1.32".to_string()),
            desired_size: 0,
            max_unavailable: None,
            max_unavailable_percentage: Some(33),
            asg_name: None,
        };
        let strategy = format_rolling_strategy(&ng);
        // max(1, 0 * 33 / 100) = max(1, 0) = 1
        assert_eq!(strategy, "33% = 1 at a time");
    }

    // UpgradePlan::is_empty() edge cases

    #[test]
    fn test_upgrade_plan_is_empty_true() {
        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
            preflight: PreflightResults::default(),
        };
        assert!(plan.is_empty());
    }

    #[test]
    fn test_upgrade_plan_is_empty_with_upgrade_path() {
        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec!["1.33".to_string()],
            addon_upgrades: vec![],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
            preflight: PreflightResults::default(),
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
            cluster_name: "test".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![(addon, "v1.11.3-eksbuild.2".to_string())],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
            preflight: PreflightResults::default(),
        };
        assert!(!plan.is_empty());
    }

    #[test]
    fn test_upgrade_plan_is_empty_with_nodegroup_upgrades_only() {
        let ng = NodeGroupInfo {
            name: "ng-system".to_string(),
            version: Some("1.32".to_string()),
            desired_size: 3,
            max_unavailable: None,
            max_unavailable_percentage: None,
            asg_name: None,
        };
        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![ng],
            skipped_nodegroups: vec![],
            preflight: PreflightResults::default(),
        };
        assert!(!plan.is_empty());
    }

    #[test]
    fn test_upgrade_plan_is_empty_skipped_only_still_empty() {
        let addon = AddonInfo {
            name: "coredns".to_string(),
            current_version: "v1.11.3-eksbuild.2".to_string(),
        };
        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![],
            skipped_addons: vec![SkippedAddon::new(addon, "already at compatible version")],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
            preflight: PreflightResults::default(),
        };
        // Skipped items don't count as upgrades
        assert!(plan.is_empty());
    }

    // calculate_estimated_time edge cases

    #[test]
    fn test_calculate_estimated_time_addons_only() {
        let addon = AddonInfo {
            name: "coredns".to_string(),
            current_version: "v1.11.1-eksbuild.1".to_string(),
        };
        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![(addon, "v1.11.3-eksbuild.2".to_string())],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
            preflight: PreflightResults::default(),
        };
        // Skip CP: 0 + addons: 10 + nodegroups: 0 = 10
        assert_eq!(calculate_estimated_time(&plan, true), 10);
    }

    #[test]
    fn test_calculate_estimated_time_nodegroups_only() {
        let ng1 = NodeGroupInfo {
            name: "ng-1".to_string(),
            version: Some("1.32".to_string()),
            desired_size: 3,
            max_unavailable: None,
            max_unavailable_percentage: None,
            asg_name: None,
        };
        let ng2 = NodeGroupInfo {
            name: "ng-2".to_string(),
            version: Some("1.32".to_string()),
            desired_size: 5,
            max_unavailable: None,
            max_unavailable_percentage: None,
            asg_name: None,
        };
        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![ng1, ng2],
            skipped_nodegroups: vec![],
            preflight: PreflightResults::default(),
        };
        // Skip CP: 0 + addons: 0 + nodegroups: 2 * 20 = 40
        assert_eq!(calculate_estimated_time(&plan, true), 40);
    }

    #[test]
    fn test_calculate_estimated_time_all_components() {
        let addon = AddonInfo {
            name: "coredns".to_string(),
            current_version: "v1.11.1-eksbuild.1".to_string(),
        };
        let ng = NodeGroupInfo {
            name: "ng-1".to_string(),
            version: Some("1.32".to_string()),
            desired_size: 3,
            max_unavailable: None,
            max_unavailable_percentage: None,
            asg_name: None,
        };
        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.34".to_string(),
            upgrade_path: vec!["1.33".to_string(), "1.34".to_string()],
            addon_upgrades: vec![(addon, "v1.11.3-eksbuild.2".to_string())],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![ng],
            skipped_nodegroups: vec![],
            preflight: PreflightResults::default(),
        };
        // CP: 2*10=20 + addons: 10 + nodegroups: 1*20=20 = 50
        assert_eq!(calculate_estimated_time(&plan, false), 50);
    }

    // VersionedResource trait impl tests

    #[test]
    fn test_addon_info_versioned_resource() {
        let addon = AddonInfo {
            name: "vpc-cni".to_string(),
            current_version: "v1.18.5-eksbuild.1".to_string(),
        };
        assert_eq!(addon.name(), "vpc-cni");
        assert_eq!(addon.current_version(), "v1.18.5-eksbuild.1");
    }

    #[test]
    fn test_nodegroup_info_versioned_resource() {
        let ng = NodeGroupInfo {
            name: "ng-app".to_string(),
            version: Some("1.33".to_string()),
            desired_size: 5,
            max_unavailable: None,
            max_unavailable_percentage: None,
            asg_name: None,
        };
        assert_eq!(ng.name(), "ng-app");
        assert_eq!(ng.current_version(), "1.33");
    }

    #[test]
    fn test_nodegroup_info_versioned_resource_none_version() {
        let ng = NodeGroupInfo {
            name: "ng-legacy".to_string(),
            version: None,
            desired_size: 2,
            max_unavailable: None,
            max_unavailable_percentage: None,
            asg_name: None,
        };
        assert_eq!(ng.name(), "ng-legacy");
        assert_eq!(ng.current_version(), "unknown");
    }

    // UpgradeConfig

    #[test]
    fn test_upgrade_config_custom() {
        let config = UpgradeConfig {
            skip_control_plane: false,
            dry_run: true,
            control_plane_timeout_minutes: 60,
            addon_timeout_minutes: 30,
            nodegroup_timeout_minutes: 120,
            check_interval_seconds: 5,
        };
        assert!(config.dry_run);
        assert_eq!(config.control_plane_timeout_minutes, 60);
    }

    // =========================================================================
    // Preflight Checks: format_ami_selector_term
    // =========================================================================

    #[test]
    fn test_format_ami_selector_term_alias() {
        use crate::k8s::karpenter::AmiSelectorTerm;
        let term = AmiSelectorTerm {
            alias: Some("al2023@v20250117".to_string()),
            id: None,
            name: None,
            owner: None,
            tags: None,
        };
        assert_eq!(format_ami_selector_term(&term), "alias: al2023@v20250117");
    }

    #[test]
    fn test_format_ami_selector_term_id() {
        use crate::k8s::karpenter::AmiSelectorTerm;
        let term = AmiSelectorTerm {
            alias: None,
            id: Some("ami-0123456789abcdef0".to_string()),
            name: None,
            owner: None,
            tags: None,
        };
        assert_eq!(format_ami_selector_term(&term), "id: ami-0123456789abcdef0");
    }

    #[test]
    fn test_format_ami_selector_term_name_with_owner() {
        use crate::k8s::karpenter::AmiSelectorTerm;
        let term = AmiSelectorTerm {
            alias: None,
            id: None,
            name: Some("my-ami-*".to_string()),
            owner: Some("123456789012".to_string()),
            tags: None,
        };
        assert_eq!(
            format_ami_selector_term(&term),
            "name: my-ami-*, owner: 123456789012"
        );
    }

    #[test]
    fn test_format_ami_selector_term_name_without_owner() {
        use crate::k8s::karpenter::AmiSelectorTerm;
        let term = AmiSelectorTerm {
            alias: None,
            id: None,
            name: Some("eks-node-*".to_string()),
            owner: None,
            tags: None,
        };
        assert_eq!(format_ami_selector_term(&term), "name: eks-node-*");
    }

    #[test]
    fn test_format_ami_selector_term_tags() {
        use crate::k8s::karpenter::AmiSelectorTerm;
        let mut tags = std::collections::HashMap::new();
        tags.insert("Environment".to_string(), "production".to_string());
        let term = AmiSelectorTerm {
            alias: None,
            id: None,
            name: None,
            owner: None,
            tags: Some(tags),
        };
        assert_eq!(
            format_ami_selector_term(&term),
            "tags: {Environment=production}"
        );
    }

    #[test]
    fn test_format_ami_selector_term_empty() {
        use crate::k8s::karpenter::AmiSelectorTerm;
        let term = AmiSelectorTerm {
            alias: None,
            id: None,
            name: None,
            owner: None,
            tags: None,
        };
        assert_eq!(format_ami_selector_term(&term), "(empty term)");
    }

    #[test]
    fn test_format_ami_selector_term_alias_takes_precedence() {
        use crate::k8s::karpenter::AmiSelectorTerm;
        let term = AmiSelectorTerm {
            alias: Some("al2023@latest".to_string()),
            id: Some("ami-fallback".to_string()),
            name: Some("name-fallback".to_string()),
            owner: None,
            tags: None,
        };
        // alias should be returned even though id and name are also set
        assert_eq!(format_ami_selector_term(&term), "alias: al2023@latest");
    }

    // =========================================================================
    // Preflight Checks: UpgradePlan with preflight data
    // =========================================================================

    #[test]
    fn test_upgrade_plan_with_pdb_findings() {
        use crate::k8s::pdb::{PdbFinding, PdbSummary};

        let pdb_summary = PdbSummary {
            total_pdbs: 3,
            blocking_count: 1,
            findings: vec![PdbFinding {
                namespace: "kube-system".to_string(),
                name: "coredns-pdb".to_string(),
                min_available: Some("1".to_string()),
                max_unavailable: None,
                current_healthy: 1,
                expected_pods: 1,
                disruptions_allowed: 0,
            }],
        };

        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec!["1.33".to_string()],
            addon_upgrades: vec![],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
            preflight: PreflightResults {
                checks: vec![PreflightCheckResult::pdb_drain_deadlock(pdb_summary)],
                skipped: vec![],
            },
        };

        let pdb = plan.preflight.pdb_summary().unwrap();
        assert!(pdb.has_blocking_pdbs());
        assert_eq!(pdb.blocking_count, 1);
        assert_eq!(pdb.findings[0].name, "coredns-pdb");
    }

    #[test]
    fn test_upgrade_plan_with_karpenter_summary() {
        use crate::k8s::karpenter::{AmiSelectorTerm, Ec2NodeClassInfo, KarpenterSummary};

        let karpenter = KarpenterSummary {
            node_classes: vec![Ec2NodeClassInfo {
                name: "default".to_string(),
                ami_selector_terms: vec![AmiSelectorTerm {
                    alias: Some("al2023@latest".to_string()),
                    id: None,
                    name: None,
                    owner: None,
                    tags: None,
                }],
            }],
            api_version: "v1".to_string(),
        };

        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec!["1.33".to_string()],
            addon_upgrades: vec![],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
            preflight: PreflightResults {
                checks: vec![PreflightCheckResult::karpenter_ami_config(karpenter)],
                skipped: vec![],
            },
        };

        let ks = plan.preflight.karpenter_summary().unwrap();
        assert_eq!(ks.node_classes.len(), 1);
        assert_eq!(ks.node_classes[0].name, "default");
    }

    #[test]
    fn test_upgrade_plan_is_empty_with_preflight_findings() {
        use crate::k8s::karpenter::{AmiSelectorTerm, Ec2NodeClassInfo, KarpenterSummary};
        use crate::k8s::pdb::PdbSummary;

        // Preflight findings don't affect is_empty (only upgrade actions matter)
        let plan = UpgradePlan {
            cluster_name: "test".to_string(),
            current_version: "1.33".to_string(),
            target_version: "1.33".to_string(),
            upgrade_path: vec![],
            addon_upgrades: vec![],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![],
            skipped_nodegroups: vec![],
            preflight: PreflightResults {
                checks: vec![
                    PreflightCheckResult::pdb_drain_deadlock(PdbSummary {
                        total_pdbs: 5,
                        blocking_count: 0,
                        findings: vec![],
                    }),
                    PreflightCheckResult::karpenter_ami_config(KarpenterSummary {
                        node_classes: vec![Ec2NodeClassInfo {
                            name: "default".to_string(),
                            ami_selector_terms: vec![AmiSelectorTerm {
                                alias: Some("al2023@latest".to_string()),
                                id: None,
                                name: None,
                                owner: None,
                                tags: None,
                            }],
                        }],
                        api_version: "v1".to_string(),
                    }),
                ],
                skipped: vec![],
            },
        };

        // Even with preflight data, plan is empty when no actual upgrades exist
        assert!(plan.is_empty());
    }

    #[test]
    fn test_upgrade_plan_with_all_preflight_and_upgrades() {
        use crate::k8s::karpenter::{AmiSelectorTerm, Ec2NodeClassInfo, KarpenterSummary};
        use crate::k8s::pdb::{PdbFinding, PdbSummary};

        let plan = UpgradePlan {
            cluster_name: "production".to_string(),
            current_version: "1.32".to_string(),
            target_version: "1.34".to_string(),
            upgrade_path: vec!["1.33".to_string(), "1.34".to_string()],
            addon_upgrades: vec![(
                AddonInfo {
                    name: "coredns".to_string(),
                    current_version: "v1.11.1-eksbuild.1".to_string(),
                },
                "v1.11.3-eksbuild.2".to_string(),
            )],
            skipped_addons: vec![],
            nodegroup_upgrades: vec![NodeGroupInfo {
                name: "ng-system".to_string(),
                version: Some("1.32".to_string()),
                desired_size: 3,
                max_unavailable: None,
                max_unavailable_percentage: Some(33),
                asg_name: None,
            }],
            skipped_nodegroups: vec![],
            preflight: PreflightResults {
                checks: vec![
                    PreflightCheckResult::pdb_drain_deadlock(PdbSummary {
                        total_pdbs: 5,
                        blocking_count: 1,
                        findings: vec![PdbFinding {
                            namespace: "kube-system".to_string(),
                            name: "coredns-pdb".to_string(),
                            min_available: Some("1".to_string()),
                            max_unavailable: None,
                            current_healthy: 1,
                            expected_pods: 1,
                            disruptions_allowed: 0,
                        }],
                    }),
                    PreflightCheckResult::karpenter_ami_config(KarpenterSummary {
                        node_classes: vec![Ec2NodeClassInfo {
                            name: "default".to_string(),
                            ami_selector_terms: vec![AmiSelectorTerm {
                                alias: Some("al2023@latest".to_string()),
                                id: None,
                                name: None,
                                owner: None,
                                tags: None,
                            }],
                        }],
                        api_version: "v1".to_string(),
                    }),
                ],
                skipped: vec![],
            },
        };

        assert!(!plan.is_empty());
        assert_eq!(plan.upgrade_path.len(), 2);
        assert_eq!(plan.addon_upgrades.len(), 1);
        assert_eq!(plan.nodegroup_upgrades.len(), 1);
        assert!(plan.preflight.pdb_summary().unwrap().has_blocking_pdbs());
        assert_eq!(
            plan.preflight
                .karpenter_summary()
                .unwrap()
                .node_classes
                .len(),
            1
        );

        // Estimated time: CP 2*10=20 + addon 10 + NG 1*20=20 = 50
        assert_eq!(calculate_estimated_time(&plan, false), 50);
    }
}
