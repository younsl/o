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

#[cfg(test)]
mod tests {
    use super::*;
    use clap::Parser;

    #[test]
    fn test_cli_defaults() {
        let cli = Cli::try_parse_from(["ami-cleanup"]).unwrap();
        assert!(cli.profile.is_none());
        assert!(cli.region.is_empty());
        assert_eq!(cli.min_age_days, 0);
        assert!(cli.consumer_profiles.is_empty());
    }

    #[test]
    fn test_cli_with_profile() {
        let cli = Cli::try_parse_from(["ami-cleanup", "--profile", "prod"]).unwrap();
        assert_eq!(cli.profile, Some("prod".into()));
    }

    #[test]
    fn test_cli_with_regions() {
        let cli =
            Cli::try_parse_from(["ami-cleanup", "-r", "us-east-1", "-r", "eu-west-1"]).unwrap();
        assert_eq!(cli.region, vec!["us-east-1", "eu-west-1"]);
    }

    #[test]
    fn test_cli_with_min_age_days() {
        let cli = Cli::try_parse_from(["ami-cleanup", "--min-age-days", "30"]).unwrap();
        assert_eq!(cli.min_age_days, 30);
    }

    #[test]
    fn test_cli_with_consumer_profiles() {
        let cli = Cli::try_parse_from([
            "ami-cleanup",
            "--consumer-profile",
            "dev",
            "--consumer-profile",
            "stg",
        ])
        .unwrap();
        assert_eq!(cli.consumer_profiles, vec!["dev", "stg"]);
    }

    #[test]
    fn test_cli_all_options() {
        let cli = Cli::try_parse_from([
            "ami-cleanup",
            "--profile",
            "prod",
            "-r",
            "us-east-1",
            "--min-age-days",
            "90",
            "--consumer-profile",
            "dev",
        ])
        .unwrap();
        assert_eq!(cli.profile, Some("prod".into()));
        assert_eq!(cli.region, vec!["us-east-1"]);
        assert_eq!(cli.min_age_days, 90);
        assert_eq!(cli.consumer_profiles, vec!["dev"]);
    }
}
