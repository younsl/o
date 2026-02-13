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
mod k8s;
mod output;

use std::collections::HashMap;

use anyhow::Result;
use chrono::NaiveDate;
use clap::Parser;
use colored::{ColoredString, Colorize};
use dialoguer::{Confirm, Input, Select, theme::ColorfulTheme};
use tracing::{debug, error};

use config::{Args, Config};
use eks::client::{EksClient, VersionLifecycle};
use eks::insights;
use eks::upgrade::{self, UpgradeConfig};
use error::KupError;
use output::{
    PhaseStatus, PhaseTiming, ReportData, generate_report, print_insights_summary, save_report,
};

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

/// Format an EOS date string with color coding based on urgency.
///
/// - Red: already past or within 90 days
/// - Yellow: within 180 days
/// - Dimmed: more than 180 days away
fn format_eos(date_str: &str) -> ColoredString {
    let today = chrono::Local::now().date_naive();
    if let Ok(eos_date) = NaiveDate::parse_from_str(date_str, "%Y-%m-%d") {
        let days_until = (eos_date - today).num_days();
        let label = format!("Standard Support ends on {}", date_str);
        if days_until <= 90 {
            label.red()
        } else if days_until <= 180 {
            label.yellow()
        } else {
            label.dimmed()
        }
    } else {
        format!("Standard Support ends on {}", date_str).dimmed()
    }
}

/// Look up the EOS date string for a given version from the lifecycles map.
fn eos_for_version(
    version: &str,
    lifecycles: &HashMap<String, VersionLifecycle>,
) -> Option<String> {
    lifecycles
        .get(version)
        .and_then(|lc| lc.end_of_standard_support.as_deref())
        .map(|s| s.to_string())
}

/// Build estimated phase timings for non-executed reports (dry-run, planned, noop).
fn build_estimated_timings(
    plan: &upgrade::UpgradePlan,
    skip_control_plane: bool,
) -> Vec<PhaseTiming> {
    let cp_mins = if skip_control_plane || plan.upgrade_path.is_empty() {
        0
    } else {
        plan.upgrade_path.len() as u64 * 10
    };
    let addon_mins = if plan.addon_upgrades.is_empty() {
        0
    } else {
        10
    };
    let ng_mins = if plan.nodegroup_upgrades.is_empty() {
        0
    } else {
        plan.nodegroup_upgrades.len() as u64 * 20
    };

    vec![
        PhaseTiming {
            phase_name: "Control Plane".to_string(),
            started_at: None,
            completed_at: None,
            duration_secs: None,
            status: if cp_mins == 0 {
                PhaseStatus::Skipped
            } else {
                PhaseStatus::Estimated(cp_mins)
            },
        },
        PhaseTiming {
            phase_name: "Add-ons".to_string(),
            started_at: None,
            completed_at: None,
            duration_secs: None,
            status: if addon_mins == 0 {
                PhaseStatus::Skipped
            } else {
                PhaseStatus::Estimated(addon_mins)
            },
        },
        PhaseTiming {
            phase_name: "Node Groups".to_string(),
            started_at: None,
            completed_at: None,
            duration_secs: None,
            status: if ng_mins == 0 {
                PhaseStatus::Skipped
            } else {
                PhaseStatus::Estimated(ng_mins)
            },
        },
    ]
}

/// Generate and save the HTML report, printing the output path.
#[allow(clippy::too_many_arguments)]
fn emit_report(
    plan: &upgrade::UpgradePlan,
    region: &str,
    platform_version: Option<&str>,
    insights: Option<&insights::InsightsSummary>,
    skip_control_plane: bool,
    dry_run: bool,
    executed: bool,
    phase_timings: Vec<PhaseTiming>,
    lifecycles: &HashMap<String, VersionLifecycle>,
) {
    let current_eos = eos_for_version(&plan.current_version, lifecycles);
    let target_eos = eos_for_version(&plan.target_version, lifecycles);

    let data = ReportData {
        cluster_name: plan.cluster_name.clone(),
        current_version: plan.current_version.clone(),
        target_version: plan.target_version.clone(),
        current_version_eos: current_eos,
        target_version_eos: target_eos,
        platform_version: platform_version.map(|s| s.to_string()),
        region: region.to_string(),
        kup_version: format!(
            "kup {} (commit: {}, build date: {})",
            config::VERSION,
            config::COMMIT,
            config::BUILD_DATE,
        ),
        insights: insights.cloned(),
        plan: plan.clone(),
        phase_timings,
        skip_control_plane,
        dry_run,
        executed,
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
    };

    match generate_report(&data) {
        Ok(html) => match save_report(&html, &data.cluster_name) {
            Ok(path) => println!(
                "EKS upgrade report saved to {}",
                path.display().to_string().bold()
            ),
            Err(e) => eprintln!("Warning: failed to save report: {}", e),
        },
        Err(e) => eprintln!("Warning: failed to generate report: {}", e),
    }
}

/// Run in interactive mode.
async fn run_interactive(client: &EksClient, config: &Config) -> Result<()> {
    // Step 1: Select Cluster
    print_step(0);

    let clusters = client.list_clusters().await?;
    if clusters.is_empty() {
        return Err(KupError::NoClustersFound.into());
    }

    let lifecycles = client.get_version_lifecycles().await;

    let cluster_items: Vec<String> = clusters
        .iter()
        .map(|c| match eos_for_version(&c.version, &lifecycles) {
            Some(date) => format!(
                "{} ({}, {}) - {}",
                c.name,
                c.version,
                format_eos(&date),
                c.region
            ),
            None => format!("{} ({}) - {}", c.name, c.version, c.region),
        })
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
    let current_ver = &selected_cluster.version;
    let current_ver_display = match eos_for_version(current_ver, &lifecycles) {
        Some(d) => format!("{} ({})", current_ver, format_eos(&d)),
        None => current_ver.to_string(),
    };
    let mut version_items: Vec<String> = vec![format!(
        "{:<22} {:<10} (sync addons/nodegroups only)",
        current_ver_display, "(current)"
    )];

    version_items.extend(available_versions.iter().enumerate().map(|(i, v)| {
        let steps = calculate_steps(&selected_cluster.version, v);
        let label = if i == available_versions.len() - 1 {
            "(latest)"
        } else {
            ""
        };
        let step_word = if steps == 1 { "step" } else { "steps" };
        let ver_display = match eos_for_version(v, &lifecycles) {
            Some(d) => format!("{} ({})", v, format_eos(&d)),
            None => v.to_string(),
        };
        format!("{:<22} {:<10} +{} {}", ver_display, label, steps, step_word)
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
        config.profile.as_deref(),
    )
    .await?;

    upgrade::print_upgrade_plan(&plan, skip_control_plane);

    // Step 5: Confirm and Execute
    if config.dry_run {
        println!("{}", "[DRY RUN] Upgrade plan generated.".yellow());
        let timings = build_estimated_timings(&plan, skip_control_plane);
        emit_report(
            &plan,
            &selected_cluster.region,
            selected_cluster.platform_version.as_deref(),
            Some(&insights_summary),
            skip_control_plane,
            true,
            false,
            timings,
            &lifecycles,
        );
        return Ok(());
    }

    // Skip confirmation if nothing to upgrade
    if plan.is_empty() {
        println!(
            "{}",
            format!(
                "All components are already at version {}. Nothing to upgrade.",
                plan.target_version
            )
            .green()
            .bold()
        );
        emit_report(
            &plan,
            &selected_cluster.region,
            selected_cluster.platform_version.as_deref(),
            Some(&insights_summary),
            skip_control_plane,
            false,
            false,
            vec![],
            &lifecycles,
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
        skip_control_plane,
        dry_run: config.dry_run,
        ..Default::default()
    };

    let phase_timings = upgrade::execute_upgrade(client, &plan, &upgrade_config).await?;

    emit_report(
        &plan,
        &selected_cluster.region,
        selected_cluster.platform_version.as_deref(),
        Some(&insights_summary),
        skip_control_plane,
        false,
        true,
        phase_timings,
        &lifecycles,
    );

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

    let lifecycles = client.get_version_lifecycles().await;

    let current_display = match eos_for_version(&cluster.version, &lifecycles) {
        Some(d) => format!("{}, {}", cluster.version, format_eos(&d)),
        None => cluster.version.clone(),
    };
    let target_display = match eos_for_version(target_version, &lifecycles) {
        Some(d) => format!("{}, {}", target_version, format_eos(&d)),
        None => target_version.clone(),
    };

    println!(
        "Cluster: {} (current: {} → target: {})",
        cluster.name.bold(),
        current_display,
        target_display,
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
    let plan = upgrade::create_upgrade_plan(
        client,
        cluster_name,
        target_version,
        &config.addon_versions,
        config.profile.as_deref(),
    )
    .await?;

    upgrade::print_upgrade_plan(&plan, false);

    // Block on PDB risk in non-interactive mode
    if let Some(ref pdb) = plan.pdb_findings
        && pdb.has_blocking_pdbs()
        && !config.yes
    {
        println!(
            "{}",
            format!(
                "{} PDB(s) may block node drain. Use --yes to proceed.",
                pdb.blocking_count
            )
            .red()
            .bold()
        );
        return Err(KupError::UpgradeNotPossible("Blocking PDBs found".to_string()).into());
    }

    // Skip execution if nothing to upgrade
    if plan.is_empty() {
        println!(
            "{}",
            format!(
                "All components are already at version {}. Nothing to upgrade.",
                plan.target_version
            )
            .green()
            .bold()
        );
        emit_report(
            &plan,
            client.region(),
            cluster.platform_version.as_deref(),
            Some(&insights_summary),
            false,
            config.dry_run,
            false,
            vec![],
            &lifecycles,
        );
        return Ok(());
    }

    if !config.yes && !config.dry_run {
        println!("{}", "Use --yes to proceed without confirmation.".yellow());
        let timings = build_estimated_timings(&plan, false);
        emit_report(
            &plan,
            client.region(),
            cluster.platform_version.as_deref(),
            Some(&insights_summary),
            false,
            false,
            false,
            timings,
            &lifecycles,
        );
        return Ok(());
    }

    let upgrade_config = UpgradeConfig {
        dry_run: config.dry_run,
        ..Default::default()
    };

    let executed = !config.dry_run;
    let phase_timings = upgrade::execute_upgrade(client, &plan, &upgrade_config).await?;

    // For dry-run, execute_upgrade returns empty vec; build estimated timings instead
    let timings = if phase_timings.is_empty() {
        build_estimated_timings(&plan, false)
    } else {
        phase_timings
    };

    emit_report(
        &plan,
        client.region(),
        cluster.platform_version.as_deref(),
        Some(&insights_summary),
        false,
        config.dry_run,
        executed,
        timings,
        &lifecycles,
    );

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
