use clap::Parser;

/// Find and remove unused AMIs and associated EBS snapshots (TUI).
#[derive(Parser, Debug)]
#[command(name = "ami-cleanup", version, about)]
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
