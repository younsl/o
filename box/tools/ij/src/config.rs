//! Application configuration.

use clap::{Parser, Subcommand};

use crate::file_config::FileConfig;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const COMMIT: &str = env!("BUILD_COMMIT");
const BUILD_DATE: &str = env!("BUILD_DATE");

/// Subcommands.
#[derive(Subcommand, Debug, Clone, PartialEq)]
pub enum Command {
    /// Initialize configuration file interactively
    Init,
    /// Find and remove unused AMIs and associated EBS snapshots (TUI)
    AmiCleanup(crate::ami_cleanup::AmiCleanupArgs),
}

/// CLI arguments.
#[derive(Parser, Debug, Clone)]
#[command(name = "ij")]
#[command(about = "EC2 operations CLI for SSM connect and AMI cleanup")]
#[command(version = const_format::formatcp!(
    "{} (commit: {}, build date: {})",
    VERSION, COMMIT, BUILD_DATE
))]
pub struct Args {
    /// Subcommand (e.g., init)
    #[command(subcommand)]
    pub command: Option<Command>,

    /// AWS profile name (e.g., 'ij dev' or 'ij stg')
    #[arg(value_name = "PROFILE")]
    pub profile_arg: Option<String>,

    /// AWS profile to use (overrides positional argument)
    #[arg(short, long, env = "AWS_PROFILE")]
    pub profile: Option<String>,

    /// Custom AWS CLI config file path (overrides default ~/.aws/config)
    #[arg(long, env = "AWS_CONFIG_FILE")]
    pub aws_config_file: Option<String>,

    /// Specific AWS region (if not set, searches all regions)
    #[arg(short, long, env = "AWS_REGION")]
    pub region: Option<String>,

    /// Filter instances by tag (format: Key=Value)
    #[arg(short = 't', long)]
    pub tag_filter: Vec<String>,

    /// Only show running instances
    #[arg(long, num_args = 0..=1, default_missing_value = "true")]
    pub running_only: Option<bool>,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, env = "IJ_LOG_LEVEL")]
    pub log_level: Option<String>,

    /// Port forwarding spec (e.g., 80, 8080:80, host:3306, 3306:host:3306)
    #[arg(short = 'L', long = "forward", value_name = "SPEC")]
    pub forward: Option<String>,

    /// Shell command to execute on connect, use multiple -s for multiple commands
    #[arg(short = 's', long)]
    pub shell_commands: Vec<String>,
}

/// Application configuration derived from CLI args + file config.
#[derive(Debug, Clone)]
pub struct Config {
    pub profile: Option<String>,
    pub aws_config_file: Option<String>,
    pub region: Option<String>,
    pub scan_regions: Vec<String>,
    pub tag_filters: Vec<String>,
    pub running_only: bool,
    pub log_level: String,
    pub forward: Option<String>,
    pub shell_commands: Vec<String>,
}

impl Config {
    /// Create config by merging CLI arguments with file config.
    ///
    /// Priority: CLI flags > file config > hardcoded defaults.
    pub fn from_args_and_file(args: Args, file_config: Option<FileConfig>) -> Self {
        let fc = file_config.unwrap_or_default();

        let profile = args
            .profile
            .or(args.profile_arg)
            .or_else(|| std::env::var("AWS_PROFILE").ok())
            .or(fc.aws_profile);

        let aws_config_file = args.aws_config_file.or_else(|| {
            let path = &fc.aws_config_file;
            if path == "~/.aws/config" {
                None
            } else {
                Some(path.clone())
            }
        });

        let tag_filters = if args.tag_filter.is_empty() {
            fc.tag_filters
        } else {
            args.tag_filter
        };

        let running_only = args.running_only.or(fc.running_only).unwrap_or(true);

        let log_level = args
            .log_level
            .or(fc.log_level)
            .unwrap_or_else(|| "info".to_string());

        let scan_regions = fc.scan_regions;

        let shell_commands = if !args.shell_commands.is_empty() {
            // CLI flags override everything
            args.shell_commands
        } else if fc.shell_commands.enabled {
            fc.shell_commands.commands
        } else {
            Vec::new()
        };

        Self {
            profile,
            aws_config_file,
            region: args.region,
            scan_regions,
            tag_filters,
            running_only,
            log_level,
            forward: args.forward,
            shell_commands,
        }
    }

    /// Get profile display name for UI.
    pub fn profile_display(&self) -> &str {
        self.profile.as_deref().unwrap_or("default")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to build Args with all fields set to None/empty defaults.
    fn empty_args() -> Args {
        Args {
            command: None,
            profile_arg: None,
            profile: None,
            aws_config_file: None,
            region: None,
            tag_filter: Vec::new(),
            running_only: None,
            log_level: None,
            forward: None,
            shell_commands: Vec::new(),
        }
    }

    #[test]
    fn defaults_when_no_args_no_file() {
        let config = Config::from_args_and_file(empty_args(), None);
        assert_eq!(config.profile, None);
        assert_eq!(config.aws_config_file, None);
        assert_eq!(config.region, None);
        assert!(config.scan_regions.is_empty());
        assert!(config.tag_filters.is_empty());
        assert!(config.running_only);
        assert_eq!(config.log_level, "info");
        assert_eq!(config.forward, None);
    }

    #[test]
    fn file_config_provides_defaults() {
        let fc = FileConfig {
            aws_profile: Some("file-profile".into()),
            aws_config_file: "/custom/path".into(),
            scan_regions: vec!["eu-west-1".into()],
            tag_filters: vec!["Team=sre".into()],
            running_only: Some(false),
            log_level: Some("debug".into()),
            shell_commands: crate::file_config::ShellCommands::default(),
        };
        let config = Config::from_args_and_file(empty_args(), Some(fc));
        assert_eq!(config.profile.as_deref(), Some("file-profile"));
        assert_eq!(config.aws_config_file.as_deref(), Some("/custom/path"));
        assert_eq!(config.scan_regions, vec!["eu-west-1"]);
        assert_eq!(config.tag_filters, vec!["Team=sre"]);
        assert!(!config.running_only);
        assert_eq!(config.log_level, "debug");
    }

    #[test]
    fn cli_args_override_file_config() {
        let fc = FileConfig {
            aws_profile: Some("file-profile".into()),
            aws_config_file: "/file/path".into(),
            scan_regions: vec!["eu-west-1".into()],
            tag_filters: vec!["Team=sre".into()],
            running_only: Some(false),
            log_level: Some("debug".into()),
            shell_commands: crate::file_config::ShellCommands::default(),
        };
        let mut args = empty_args();
        args.profile = Some("cli-profile".into());
        args.aws_config_file = Some("/cli/path".into());
        args.tag_filter = vec!["Env=prod".into()];
        args.running_only = Some(true);
        args.log_level = Some("error".into());
        args.region = Some("us-east-1".into());

        let config = Config::from_args_and_file(args, Some(fc));
        assert_eq!(config.profile.as_deref(), Some("cli-profile"));
        assert_eq!(config.aws_config_file.as_deref(), Some("/cli/path"));
        assert_eq!(config.tag_filters, vec!["Env=prod"]);
        assert!(config.running_only);
        assert_eq!(config.log_level, "error");
        assert_eq!(config.region.as_deref(), Some("us-east-1"));
    }

    #[test]
    fn profile_arg_used_when_no_profile_flag() {
        let mut args = empty_args();
        args.profile_arg = Some("positional-profile".into());
        let config = Config::from_args_and_file(args, None);
        assert_eq!(config.profile.as_deref(), Some("positional-profile"));
    }

    #[test]
    fn profile_flag_overrides_positional() {
        let mut args = empty_args();
        args.profile_arg = Some("positional".into());
        args.profile = Some("flag".into());
        let config = Config::from_args_and_file(args, None);
        assert_eq!(config.profile.as_deref(), Some("flag"));
    }

    #[test]
    fn default_aws_config_file_filtered_to_none() {
        let fc = FileConfig {
            aws_config_file: "~/.aws/config".into(),
            ..FileConfig::default()
        };
        let config = Config::from_args_and_file(empty_args(), Some(fc));
        assert_eq!(config.aws_config_file, None);
    }

    #[test]
    fn custom_aws_config_file_preserved() {
        let fc = FileConfig {
            aws_config_file: "/opt/aws/config".into(),
            ..FileConfig::default()
        };
        let config = Config::from_args_and_file(empty_args(), Some(fc));
        assert_eq!(config.aws_config_file.as_deref(), Some("/opt/aws/config"));
    }

    #[test]
    fn profile_display_with_profile() {
        let mut args = empty_args();
        args.profile = Some("dev".into());
        let config = Config::from_args_and_file(args, None);
        assert_eq!(config.profile_display(), "dev");
    }

    #[test]
    fn profile_display_without_profile() {
        let config = Config::from_args_and_file(empty_args(), None);
        assert_eq!(config.profile_display(), "default");
    }

    #[test]
    fn shell_commands_enabled_passes_commands() {
        let fc = FileConfig {
            shell_commands: crate::file_config::ShellCommands {
                enabled: true,
                commands: vec!["sudo su -".into()],
            },
            ..FileConfig::default()
        };
        let config = Config::from_args_and_file(empty_args(), Some(fc));
        assert_eq!(config.shell_commands, vec!["sudo su -"]);
    }

    #[test]
    fn shell_commands_disabled_returns_empty() {
        let fc = FileConfig {
            shell_commands: crate::file_config::ShellCommands {
                enabled: false,
                commands: vec!["sudo su -".into()],
            },
            ..FileConfig::default()
        };
        let config = Config::from_args_and_file(empty_args(), Some(fc));
        assert!(config.shell_commands.is_empty());
    }

    #[test]
    fn cli_shell_commands_override_disabled_config() {
        let fc = FileConfig {
            shell_commands: crate::file_config::ShellCommands {
                enabled: false,
                commands: vec!["sudo su -".into()],
            },
            ..FileConfig::default()
        };
        let mut args = empty_args();
        args.shell_commands = vec!["whoami".into()];
        let config = Config::from_args_and_file(args, Some(fc));
        assert_eq!(config.shell_commands, vec!["whoami"]);
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
