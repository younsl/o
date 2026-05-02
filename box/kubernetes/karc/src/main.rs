//! karc - Karpenter NodePool consolidation manager CLI tool.
//!
//! View NodePool disruption status, pause/resume consolidation,
//! and display schedule-based disruption budget timetables.

mod config;
mod error;
mod k8s;
mod output;

use anyhow::Result;
use clap::Parser;
use colored::Colorize;
use dialoguer::{Confirm, theme::ColorfulTheme};
use tracing::{debug, error, info, warn};

use config::{Args, Command, Config};
use error::KarcError;

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let config = Config::from_args(args);

    if let Err(e) = init_tracing(&config.log_level) {
        eprintln!("Failed to initialize logging: {}", e);
        std::process::exit(1);
    }

    debug!("Starting karc - Karpenter NodePool Consolidation Manager");

    if let Err(e) = run(&config).await {
        error!("{}", e);
        std::process::exit(1);
    }
}

/// Main application logic.
async fn run(config: &Config) -> Result<()> {
    // Validate timezone
    validate_timezone(&config.timezone)?;

    let client = k8s::client::build_client(config.context.as_deref()).await?;
    let context_name = k8s::client::current_context(config.context.as_deref());

    match &config.command {
        Command::Status { nodepool } => {
            run_status(
                &client,
                nodepool.as_deref(),
                &context_name,
                &config.timezone,
            )
            .await
        }
        Command::Pause { nodepool } => run_pause(&client, nodepool, config).await,
        Command::Resume { nodepool } => run_resume(&client, nodepool, config).await,
    }
}

/// Show NodePool status.
async fn run_status(
    client: &kube::Client,
    nodepool_filter: Option<&str>,
    context_name: &str,
    timezone: &str,
) -> Result<()> {
    let result = k8s::nodepool::list_nodepools(client).await?;
    if result.nodepools.is_empty() {
        return Err(KarcError::NoNodePoolsFound.into());
    }

    let filtered = match nodepool_filter {
        Some(name) => {
            let found = result.nodepools.into_iter().find(|np| np.name == name);
            match found {
                Some(np) => vec![np],
                None => return Err(KarcError::NodePoolNotFound(name.to_string()).into()),
            }
        }
        None => result.nodepools,
    };

    let nodeclaim_counts = k8s::nodeclaim::count_by_nodepool(client).await?;

    output::table::print_status(
        &filtered,
        &nodeclaim_counts,
        context_name,
        timezone,
        &result.api_version,
    );

    Ok(())
}

/// Pause consolidation for NodePool(s).
async fn run_pause(client: &kube::Client, nodepool: &str, config: &Config) -> Result<()> {
    let targets = resolve_targets(client, nodepool).await?;

    for name in &targets {
        if config.dry_run {
            println!(
                "{} Would pause NodePool '{}'",
                "[DRY RUN]".yellow(),
                name.bold()
            );
            continue;
        }

        if !config.yes {
            let proceed = Confirm::with_theme(&ColorfulTheme::default())
                .with_prompt(format!("Pause consolidation for NodePool '{}'?", name))
                .default(false)
                .interact()?;

            if !proceed {
                info!("Skipping NodePool '{}'", name);
                continue;
            }
        }

        match k8s::nodepool::pause_nodepool(client, name).await? {
            true => println!("Paused consolidation for NodePool '{}'", name.bold()),
            false => warn!("NodePool '{}' is already paused", name),
        }
    }

    Ok(())
}

/// Resume consolidation for NodePool(s).
async fn run_resume(client: &kube::Client, nodepool: &str, config: &Config) -> Result<()> {
    let targets = resolve_targets(client, nodepool).await?;

    for name in &targets {
        if config.dry_run {
            println!(
                "{} Would resume NodePool '{}'",
                "[DRY RUN]".yellow(),
                name.bold()
            );
            continue;
        }

        if !config.yes {
            let proceed = Confirm::with_theme(&ColorfulTheme::default())
                .with_prompt(format!("Resume consolidation for NodePool '{}'?", name))
                .default(false)
                .interact()?;

            if !proceed {
                info!("Skipping NodePool '{}'", name);
                continue;
            }
        }

        match k8s::nodepool::resume_nodepool(client, name).await? {
            true => println!("Resumed consolidation for NodePool '{}'", name.bold()),
            false => warn!("NodePool '{}' is not paused", name),
        }
    }

    Ok(())
}

/// Resolve target NodePool names from arguments.
/// If nodepool is "all" (case-insensitive), returns all NodePools.
async fn resolve_targets(client: &kube::Client, nodepool: &str) -> Result<Vec<String>> {
    if nodepool.eq_ignore_ascii_case("all") {
        let result = k8s::nodepool::list_nodepools(client).await?;
        if result.nodepools.is_empty() {
            return Err(KarcError::NoNodePoolsFound.into());
        }
        Ok(result.nodepools.into_iter().map(|np| np.name).collect())
    } else {
        // Verify the NodePool exists
        k8s::nodepool::get_nodepool(client, nodepool).await?;
        Ok(vec![nodepool.to_string()])
    }
}

/// Validate the timezone string.
fn validate_timezone(timezone: &str) -> Result<()> {
    if timezone == "UTC" {
        return Ok(());
    }

    use chrono_tz::Tz;
    timezone
        .parse::<Tz>()
        .map_err(|_| KarcError::InvalidTimezone(timezone.to_string()))?;

    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_timezone_utc() {
        assert!(validate_timezone("UTC").is_ok());
    }

    #[test]
    fn test_validate_timezone_valid() {
        assert!(validate_timezone("Asia/Seoul").is_ok());
        assert!(validate_timezone("US/Eastern").is_ok());
        assert!(validate_timezone("Europe/London").is_ok());
    }

    #[test]
    fn test_validate_timezone_invalid() {
        assert!(validate_timezone("Invalid/Zone").is_err());
        assert!(validate_timezone("KST").is_err());
    }
}
