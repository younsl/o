//! Application configuration.

use clap::Parser;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const COMMIT: &str = env!("BUILD_COMMIT");
const BUILD_DATE: &str = env!("BUILD_DATE");

/// CLI arguments.
#[derive(Parser, Debug, Clone)]
#[command(name = "ij")]
#[command(about = "Interactive EC2 Session Manager connection tool")]
#[command(version = const_format::formatcp!(
    "{} (commit: {}, build date: {})",
    VERSION, COMMIT, BUILD_DATE
))]
pub struct Args {
    /// AWS profile name (e.g., 'ij dev' or 'ij stg')
    #[arg(value_name = "PROFILE")]
    pub profile_arg: Option<String>,

    /// AWS profile to use (overrides positional argument)
    #[arg(short, long, env = "AWS_PROFILE")]
    pub profile: Option<String>,

    /// Specific AWS region (if not set, searches all regions)
    #[arg(short, long, env = "AWS_REGION")]
    pub region: Option<String>,

    /// Filter instances by tag (format: Key=Value)
    #[arg(short = 't', long)]
    pub tag_filter: Vec<String>,

    /// Only show running instances
    #[arg(long, default_value = "true")]
    pub running_only: bool,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "info", env = "IJ_LOG_LEVEL")]
    pub log_level: String,

    /// Port forwarding spec (e.g., 80, 8080:80, host:3306, 3306:host:3306)
    #[arg(short = 'L', long = "forward", value_name = "SPEC")]
    pub forward: Option<String>,
}

/// Application configuration derived from CLI args.
#[derive(Debug, Clone)]
pub struct Config {
    pub profile: Option<String>,
    pub region: Option<String>,
    pub tag_filters: Vec<String>,
    pub running_only: bool,
    pub log_level: String,
    pub forward: Option<String>,
}

impl Config {
    /// Create config from CLI arguments.
    pub fn from_args(args: Args) -> Self {
        let profile = args
            .profile
            .or(args.profile_arg)
            .or_else(|| std::env::var("AWS_PROFILE").ok());

        Self {
            profile,
            region: args.region,
            tag_filters: args.tag_filter,
            running_only: args.running_only,
            log_level: args.log_level,
            forward: args.forward,
        }
    }

    /// Get profile display name for UI.
    pub fn profile_display(&self) -> &str {
        self.profile.as_deref().unwrap_or("default")
    }
}

/// AWS regions to scan.
pub const AWS_REGIONS: &[&str] = &[
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "ap-south-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-east-1",
    "ca-central-1",
    "eu-central-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-south-1",
    "eu-north-1",
    "me-south-1",
    "sa-east-1",
    "af-south-1",
];
