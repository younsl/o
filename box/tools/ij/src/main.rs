use anyhow::{Context, Result};
use aws_config::BehaviorVersion;
use aws_sdk_ec2::types::Filter;
use clap::Parser;
use colored::Colorize;
use console::{Style, Term};
use dialoguer::{theme::ColorfulTheme, Select};
use std::process::Command;
use tabled::Tabled;
use tracing::{debug, warn};

// ============================================================================
// Build Information
// ============================================================================

const VERSION: &str = env!("CARGO_PKG_VERSION");
const COMMIT: &str = env!("BUILD_COMMIT");
const BUILD_DATE: &str = env!("BUILD_DATE");

// ============================================================================
// CLI Arguments
// ============================================================================

#[derive(Parser, Debug)]
#[command(name = "ij")]
#[command(about = "Interactive EC2 Session Manager connection tool")]
#[command(version = const_format::formatcp!(
    "{} (commit: {}, build date: {})",
    VERSION, COMMIT, BUILD_DATE
))]
struct Args {
    /// AWS profile name (e.g., 'ij dev' or 'ij stg')
    #[arg(value_name = "PROFILE")]
    profile_arg: Option<String>,

    /// AWS profile to use (overrides positional argument)
    #[arg(short, long, env = "AWS_PROFILE")]
    profile: Option<String>,

    /// Specific AWS region (if not set, searches all regions)
    #[arg(short, long, env = "AWS_REGION")]
    region: Option<String>,

    /// Filter instances by tag (format: Key=Value)
    #[arg(short = 't', long)]
    tag_filter: Vec<String>,

    /// Only show running instances
    #[arg(long, default_value = "true")]
    running_only: bool,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info", env = "IJ_LOG_LEVEL")]
    log_level: String,
}

// ============================================================================
// Instance Model
// ============================================================================

#[derive(Debug, Clone, Tabled)]
struct Instance {
    #[tabled(rename = "REGION")]
    region: String,
    #[tabled(rename = "NAME")]
    name: String,
    #[tabled(rename = "INSTANCE ID")]
    instance_id: String,
    #[tabled(rename = "TYPE")]
    instance_type: String,
    #[tabled(rename = "PRIVATE IP")]
    private_ip: String,
    #[tabled(rename = "STATE")]
    state: String,
}

impl Instance {
    /// Format instance as a single row string for selection list
    fn to_row(&self, col_widths: &[usize]) -> String {
        format!(
            "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {:<w4$}  {:<w5$}",
            self.region,
            self.name,
            self.instance_id,
            self.instance_type,
            self.private_ip,
            self.state,
            w0 = col_widths[0],
            w1 = col_widths[1],
            w2 = col_widths[2],
            w3 = col_widths[3],
            w4 = col_widths[4],
            w5 = col_widths[5],
        )
    }
}

/// Calculate column widths from instances
fn calculate_column_widths(instances: &[Instance]) -> Vec<usize> {
    vec![
        instances.iter().map(|i| i.region.len()).max().unwrap_or(6).max(6),
        instances.iter().map(|i| i.name.len()).max().unwrap_or(4).max(4),
        instances.iter().map(|i| i.instance_id.len()).max().unwrap_or(11).max(11),
        instances.iter().map(|i| i.instance_type.len()).max().unwrap_or(4).max(4),
        instances.iter().map(|i| i.private_ip.len()).max().unwrap_or(10).max(10),
        instances.iter().map(|i| i.state.len()).max().unwrap_or(5).max(5),
    ]
}

/// Format header row string
fn format_header(col_widths: &[usize]) -> String {
    format!(
        "{:<w0$}  {:<w1$}  {:<w2$}  {:<w3$}  {:<w4$}  {:<w5$}",
        "REGION", "NAME", "INSTANCE ID", "TYPE", "PRIVATE IP", "STATE",
        w0 = col_widths[0],
        w1 = col_widths[1],
        w2 = col_widths[2],
        w3 = col_widths[3],
        w4 = col_widths[4],
        w5 = col_widths[5],
    )
}


// ============================================================================
// AWS Regions
// ============================================================================

const AWS_REGIONS: &[&str] = &[
    "us-east-1", "us-east-2", "us-west-1", "us-west-2",
    "ap-south-1", "ap-northeast-1", "ap-northeast-2", "ap-northeast-3",
    "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-east-1",
    "ca-central-1",
    "eu-central-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-south-1", "eu-north-1",
    "me-south-1", "sa-east-1", "af-south-1",
];

// ============================================================================
// EC2 Instance Listing
// ============================================================================

async fn fetch_instances_in_region(
    region: &str,
    profile: Option<&str>,
    tag_filters: &[String],
    running_only: bool,
) -> Result<Vec<Instance>> {
    debug!("Scanning region: {}", region);

    let mut config_loader = aws_config::defaults(BehaviorVersion::latest())
        .region(aws_config::Region::new(region.to_string()));

    if let Some(p) = profile {
        config_loader = config_loader.profile_name(p);
    }

    let sdk_config = config_loader.load().await;
    let client = aws_sdk_ec2::Client::new(&sdk_config);

    let filters = build_filters(tag_filters, running_only);
    let mut request = client.describe_instances();
    if !filters.is_empty() {
        request = request.set_filters(Some(filters));
    }

    let resp = match request.send().await {
        Ok(r) => r,
        Err(e) => {
            debug!("Failed to describe instances in {}: {}", region, e);
            return Ok(Vec::new());
        }
    };

    let instances = resp
        .reservations()
        .iter()
        .flat_map(|r| r.instances())
        .map(|i| Instance {
            region: region.to_string(),
            name: get_name_tag(i).unwrap_or_else(|| "(no name)".to_string()),
            instance_id: i.instance_id().unwrap_or("N/A").to_string(),
            instance_type: i.instance_type().map(|t| t.as_str()).unwrap_or("N/A").to_string(),
            state: i.state().and_then(|s| s.name()).map(|s| s.as_str()).unwrap_or("unknown").to_string(),
            private_ip: i.private_ip_address().unwrap_or("N/A").to_string(),
        })
        .collect();

    Ok(instances)
}

fn build_filters(tag_filters: &[String], running_only: bool) -> Vec<Filter> {
    let mut filters = Vec::new();

    if running_only {
        filters.push(
            Filter::builder()
                .name("instance-state-name")
                .values("running")
                .build(),
        );
    }

    for tag_filter in tag_filters {
        if let Some((key, value)) = tag_filter.split_once('=') {
            filters.push(
                Filter::builder()
                    .name(format!("tag:{}", key))
                    .values(value)
                    .build(),
            );
        } else {
            warn!("Invalid tag filter format '{}', expected Key=Value", tag_filter);
        }
    }

    filters
}

fn get_name_tag(instance: &aws_sdk_ec2::types::Instance) -> Option<String> {
    instance
        .tags()
        .iter()
        .find(|tag| tag.key() == Some("Name"))
        .and_then(|tag| tag.value())
        .map(|s| s.to_string())
}

async fn fetch_all_instances(
    profile: Option<&str>,
    specific_region: Option<&str>,
    tag_filters: &[String],
    running_only: bool,
) -> Result<Vec<Instance>> {
    let regions: Vec<&str> = match specific_region {
        Some(region) => vec![region],
        None => AWS_REGIONS.to_vec(),
    };

    println!(
        "\n{} {} region(s)...",
        "Scanning".bright_blue().bold(),
        regions.len().to_string().bright_yellow()
    );

    let tasks: Vec<_> = regions
        .into_iter()
        .map(|region| {
            let region_owned = region.to_string();
            let profile_owned = profile.map(|s| s.to_string());
            let tag_filters_owned = tag_filters.to_vec();

            tokio::spawn(async move {
                fetch_instances_in_region(
                    &region_owned,
                    profile_owned.as_deref(),
                    &tag_filters_owned,
                    running_only,
                )
                .await
            })
        })
        .collect();

    let mut all_instances = Vec::new();
    for task in tasks {
        match task.await {
            Ok(Ok(instances)) => all_instances.extend(instances),
            Ok(Err(e)) => warn!("Error fetching instances: {}", e),
            Err(e) => warn!("Task failed: {}", e),
        }
    }

    all_instances.sort_by(|a, b| a.region.cmp(&b.region).then_with(|| a.name.cmp(&b.name)));
    Ok(all_instances)
}

// ============================================================================
// Session Manager Connection
// ============================================================================

fn connect_to_instance(instance_id: &str, region: &str, profile: Option<&str>) -> Result<()> {
    debug!("Connecting to {} in {} via Session Manager", instance_id, region);

    let mut cmd = Command::new("aws");
    cmd.args(["ssm", "start-session", "--target", instance_id, "--region", region]);

    if let Some(p) = profile {
        cmd.args(["--profile", p]);
    }

    debug!("Executing: {:?}", cmd);

    let status = cmd.status().context("Failed to execute aws ssm start-session")?;
    if !status.success() {
        anyhow::bail!("Session Manager connection failed with status: {}", status);
    }

    Ok(())
}

// ============================================================================
// Interactive Selection
// ============================================================================

fn select_instance(instances: &[Instance]) -> Result<Option<&Instance>> {
    let col_widths = calculate_column_widths(instances);
    let term = Term::stderr();

    // Print header with 2-space indent to match dialoguer's cursor
    println!("  {}", format_header(&col_widths).bright_white().bold());

    // Build selection items
    let items: Vec<String> = instances.iter().map(|i| i.to_row(&col_widths)).collect();

    // Custom theme with cyan highlight for selected item
    let theme = ColorfulTheme {
        active_item_style: Style::new().cyan(),
        active_item_prefix: Style::new().cyan().apply_to(">".to_string()),
        inactive_item_prefix: Style::new().apply_to(" ".to_string()),
        ..ColorfulTheme::default()
    };

    let selection = Select::with_theme(&theme)
        .items(&items)
        .default(0)
        .interact_on_opt(&term)?;

    // Clear the selection UI and reprint cleanly
    term.clear_last_lines(items.len().min(10) + 1)?;

    match selection {
        Some(index) => Ok(Some(&instances[index])),
        None => Ok(None),
    }
}

// ============================================================================
// Main
// ============================================================================

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Initialize logging (suppress verbose AWS SDK logs)
    let log_filter = format!("warn,ij={}", args.log_level);
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(&log_filter)),
        )
        .with_target(false)
        .init();

    // Priority: --profile flag > positional argument > AWS_PROFILE env
    let profile = args
        .profile
        .or(args.profile_arg)
        .or_else(|| std::env::var("AWS_PROFILE").ok());

    if let Some(ref p) = profile {
        debug!("Using AWS profile: {}", p);
    }

    // Fetch instances
    let instances = fetch_all_instances(
        profile.as_deref(),
        args.region.as_deref(),
        &args.tag_filter,
        args.running_only,
    )
    .await?;

    if instances.is_empty() {
        println!("{}", "\nNo instances found.".yellow());
        return Ok(());
    }

    let profile_display = profile.as_deref().unwrap_or("default");
    println!(
        "\n{} {} instances (profile: {})\n",
        "Found".bright_blue().bold(),
        instances.len().to_string().bright_yellow().bold(),
        profile_display.bright_cyan()
    );

    // Interactive selection
    match select_instance(&instances)? {
        Some(selected) => {
            println!(
                "\n{} {} ({})",
                "Selected:".bright_blue(),
                selected.name.bright_cyan().bold(),
                selected.region.bright_blue()
            );
            connect_to_instance(&selected.instance_id, &selected.region, profile.as_deref())?;
        }
        None => {
            println!("\n{}", "No instance selected. Exiting.".yellow());
        }
    }

    Ok(())
}
