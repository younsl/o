//! kup - EKS cluster upgrade support CLI tool.
//!
//! Interactive tool for upgrading EKS clusters with:
//! - Cluster Insights analysis
//! - Sequential control plane upgrades
//! - Add-on compatibility checks
//! - Managed node group rolling updates

mod config;
mod eks;
mod error;
mod output;

use anyhow::Result;
use clap::Parser;
use colored::Colorize;
use dialoguer::{Confirm, Input, Select, theme::ColorfulTheme};
use tracing::{debug, error};

use config::{Args, Config};
use eks::client::EksClient;
use eks::insights;
use eks::upgrade::{self, UpgradeConfig};
use error::KupError;
use output::print_insights_summary;

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let config = Config::from_args(args);

    // Initialize logging
    if let Err(e) = init_tracing(&config.log_level) {
        eprintln!("Failed to initialize logging: {}", e);
        std::process::exit(1);
    }

    debug!("Starting kup - EKS Upgrade Support Tool");

    if let Err(e) = run(&config).await {
        error!("{}", e);
        std::process::exit(1);
    }
}

/// Main application logic.
async fn run(config: &Config) -> Result<()> {
    // Create EKS client
    let client = EksClient::new(config.profile.as_deref(), config.region.as_deref()).await?;

    if config.is_interactive() {
        run_interactive(&client, config).await
    } else {
        run_noninteractive(&client, config).await
    }
}

/// Initialize tracing subscriber.
fn init_tracing(log_level: &str) -> Result<()> {
    use tracing_subscriber::{EnvFilter, fmt};

    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new(log_level))
        .map_err(|e| anyhow::anyhow!("Failed to initialize log filter: {}", e))?;

    fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_thread_ids(false)
        .with_file(false)
        .with_line_number(false)
        .init();

    Ok(())
}

/// Interactive mode step names.
const STEPS: &[&str] = &[
    "Select Cluster",
    "Check Insights",
    "Select Target Version",
    "Review Plan",
    "Execute Upgrade",
];

/// Prints a step header in "Phase [current/total]: name" format.
fn print_step(index: usize) {
    println!();
    println!(
        "{}",
        format!("Phase [{}/{}]: {}", index + 1, STEPS.len(), STEPS[index])
            .cyan()
            .bold()
    );
}

/// Run in interactive mode.
async fn run_interactive(client: &EksClient, config: &Config) -> Result<()> {
    // Step 1: Select Cluster
    print_step(0);

    let clusters = client.list_clusters().await?;
    if clusters.is_empty() {
        return Err(KupError::NoClustersFound.into());
    }

    let cluster_items: Vec<String> = clusters
        .iter()
        .map(|c| format!("{} ({}) - {}", c.name, c.version, c.region))
        .collect();

    let cluster_idx = Select::with_theme(&ColorfulTheme::default())
        .with_prompt(format!("Select EKS cluster ({} found)", clusters.len()))
        .items(&cluster_items)
        .default(0)
        .interact()?;

    let selected_cluster = &clusters[cluster_idx];
    debug!("Selected cluster: {}", selected_cluster.name);

    // Step 2: Check Insights
    print_step(1);
    println!(
        "Fetching Cluster Insights for {}...",
        selected_cluster.name.bold()
    );

    let (is_ready, insights_summary) =
        insights::check_upgrade_readiness(client.inner(), &selected_cluster.name).await?;

    print_insights_summary(&insights_summary);

    if !is_ready {
        println!();
        println!(
            "{}",
            "Warning: Critical issues found that may block upgrade."
                .yellow()
                .bold()
        );
        if !Confirm::new()
            .with_prompt("Continue anyway?")
            .default(false)
            .interact()?
        {
            return Err(KupError::UserCancelled.into());
        }
    }

    // Step 3: Select Target Version
    print_step(2);

    let available_versions = client
        .get_available_versions(&selected_cluster.name)
        .await?;

    // Build version items with current version (sync only) option first
    let mut version_items: Vec<String> = vec![format!(
        "{:<5} {:<10} (sync addons/nodegroups only)",
        selected_cluster.version, "(current)"
    )];

    version_items.extend(available_versions.iter().enumerate().map(|(i, v)| {
        let steps = calculate_steps(&selected_cluster.version, v);
        let label = if i == 0 { "(latest)" } else { "" };
        let step_word = if steps == 1 { "step" } else { "steps" };
        format!("{:<5} {:<10} +{} {}", v, label, steps, step_word)
    }));

    println!("Select target version ({}):", selected_cluster.name);
    let version_idx = Select::with_theme(&ColorfulTheme::default())
        .items(&version_items)
        .default(0)
        .interact()?;

    // First option (index 0) is current version (sync mode)
    let (target_version, skip_control_plane) = if version_idx == 0 {
        (selected_cluster.version.clone(), true)
    } else {
        (available_versions[version_idx - 1].clone(), false)
    };
    debug!(
        "Selected target version: {} (skip_control_plane: {})",
        target_version, skip_control_plane
    );

    // Step 4: Review Plan
    print_step(3);

    let plan = upgrade::create_upgrade_plan(
        client,
        &selected_cluster.name,
        &target_version,
        &config.addon_versions,
    )
    .await?;

    upgrade::print_upgrade_plan(&plan, skip_control_plane);

    // Step 5: Confirm and Execute
    if config.dry_run {
        println!("{}", "[DRY RUN] Upgrade plan generated.".yellow());
        return Ok(());
    }

    // Skip confirmation if nothing to upgrade
    if plan.is_empty() {
        println!(
            "{}",
            "All components are already at target version. Nothing to upgrade."
                .green()
                .bold()
        );
        return Ok(());
    }

    println!(
        "{}",
        "This will upgrade your EKS cluster. This action cannot be undone."
            .yellow()
            .bold()
    );

    let confirmation: String = Input::new()
        .with_prompt(format!("Type {} to confirm", "Yes".green().bold()))
        .interact_text()?;

    if confirmation != "Yes" {
        println!(
            "{}",
            "Upgrade cancelled. You must type 'Yes' to proceed.".red()
        );
        return Err(KupError::UserCancelled.into());
    }

    // Step 5: Execute Upgrade
    print_step(4);

    let upgrade_config = UpgradeConfig {
        skip_addons: config.skip_addons,
        skip_nodegroups: config.skip_nodegroups,
        skip_control_plane,
        dry_run: config.dry_run,
        ..Default::default()
    };

    upgrade::execute_upgrade(client, &plan, &upgrade_config).await?;

    Ok(())
}

/// Run in non-interactive mode.
async fn run_noninteractive(client: &EksClient, config: &Config) -> Result<()> {
    let cluster_name = config
        .cluster
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("--cluster is required in non-interactive mode"))?;

    let target_version = config
        .target_version
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("--target is required in non-interactive mode"))?;

    debug!(
        "Non-interactive mode: upgrading {} to {}",
        cluster_name, target_version
    );

    // Check cluster exists
    let cluster = client
        .describe_cluster(cluster_name)
        .await?
        .ok_or_else(|| KupError::ClusterNotFound(cluster_name.clone()))?;

    println!(
        "Cluster: {} (current: {}, target: {})",
        cluster.name.bold(),
        cluster.version,
        target_version
    );

    // Check insights
    let (_is_ready, insights_summary) =
        insights::check_upgrade_readiness(client.inner(), cluster_name).await?;

    if insights_summary.has_critical_blockers() && !config.yes {
        println!(
            "{}",
            "Critical issues found. Use --yes to proceed anyway."
                .red()
                .bold()
        );
        return Err(KupError::UpgradeNotPossible("Critical blockers found".to_string()).into());
    }

    // Create and execute plan
    let plan =
        upgrade::create_upgrade_plan(client, cluster_name, target_version, &config.addon_versions)
            .await?;

    upgrade::print_upgrade_plan(&plan, false);

    // Skip execution if nothing to upgrade
    if plan.is_empty() {
        println!(
            "{}",
            "All components are already at target version. Nothing to upgrade."
                .green()
                .bold()
        );
        return Ok(());
    }

    if !config.yes && !config.dry_run {
        println!("{}", "Use --yes to proceed without confirmation.".yellow());
        return Ok(());
    }

    let upgrade_config = UpgradeConfig {
        skip_addons: config.skip_addons,
        skip_nodegroups: config.skip_nodegroups,
        dry_run: config.dry_run,
        ..Default::default()
    };

    upgrade::execute_upgrade(client, &plan, &upgrade_config).await?;

    Ok(())
}

/// Calculate number of upgrade steps between two versions.
fn calculate_steps(current: &str, target: &str) -> usize {
    let current_parts: Vec<u32> = current.split('.').filter_map(|s| s.parse().ok()).collect();
    let target_parts: Vec<u32> = target.split('.').filter_map(|s| s.parse().ok()).collect();

    if current_parts.len() >= 2 && target_parts.len() >= 2 {
        (target_parts[1] as i32 - current_parts[1] as i32).unsigned_abs() as usize
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_calculate_steps_single_step() {
        assert_eq!(calculate_steps("1.32", "1.33"), 1);
        assert_eq!(calculate_steps("1.28", "1.29"), 1);
    }

    #[test]
    fn test_calculate_steps_multiple_steps() {
        assert_eq!(calculate_steps("1.32", "1.34"), 2);
        assert_eq!(calculate_steps("1.28", "1.32"), 4);
    }

    #[test]
    fn test_calculate_steps_same_version() {
        assert_eq!(calculate_steps("1.32", "1.32"), 0);
    }

    #[test]
    fn test_calculate_steps_invalid_version() {
        assert_eq!(calculate_steps("invalid", "1.33"), 0);
        assert_eq!(calculate_steps("1.32", "invalid"), 0);
        assert_eq!(calculate_steps("", ""), 0);
    }
}
