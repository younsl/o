use clap::Parser;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("BUILD_COMMIT");
pub const BUILD_DATE: &str = env!("BUILD_DATE");
pub const APP_NAME: &str = env!("CARGO_PKG_NAME");

/// Find and remove unused AMIs and associated EBS snapshots (TUI).
#[derive(Parser, Debug)]
#[command(name = "ami-cleanup", about)]
#[command(version = const_format::formatcp!(
    "{} (commit: {}, build date: {})",
    VERSION, COMMIT, BUILD_DATE
))]
pub struct Cli {
    /// AWS profile name (interactive selection if omitted)
    #[arg(long)]
    pub profile: Option<String>,

    /// AWS regions to scan (defaults to all enabled regions)
    #[arg(long, short)]
    pub region: Vec<String>,

    /// Only target AMIs older than N days
    #[arg(long, default_value_t = 0)]
    pub min_age_days: u64,

    /// Additional AWS profiles to check for AMI usage (e.g. dev, stg, prd accounts)
    #[arg(long = "consumer-profile")]
    pub consumer_profiles: Vec<String>,
}
