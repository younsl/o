//! CLI configuration and argument parsing.

use clap::{Parser, Subcommand};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("BUILD_COMMIT");
pub const BUILD_DATE: &str = env!("BUILD_DATE");

/// Karpenter NodePool consolidation manager CLI tool.
///
/// View NodePool disruption status, pause/resume consolidation,
/// and display schedule-based disruption budget timetables.
#[derive(Parser, Debug, Clone)]
#[command(name = "karc")]
#[command(about = "Karpenter NodePool consolidation manager CLI tool")]
#[command(version = const_format::formatcp!(
    "{} (commit: {}, build date: {})",
    VERSION, COMMIT, BUILD_DATE
))]
pub struct Args {
    /// Kubernetes context to use
    #[arg(long, global = true, env = "KUBECONFIG_CONTEXT")]
    pub context: Option<String>,

    /// Show planned changes without executing
    #[arg(long, global = true, default_value = "false")]
    pub dry_run: bool,

    /// Skip confirmation prompts
    #[arg(short, long, global = true, default_value = "false")]
    pub yes: bool,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, global = true, default_value = "warn", env = "KARC_LOG_LEVEL")]
    pub log_level: String,

    /// Timezone for schedule display (e.g., Asia/Seoul, US/Eastern) [default: auto-detect]
    #[arg(long, global = true)]
    pub timezone: Option<String>,

    #[command(subcommand)]
    pub command: Command,
}

/// Available subcommands.
#[derive(Subcommand, Debug, Clone)]
pub enum Command {
    /// Show NodePool consolidation status and disruption schedules
    Status {
        /// Show only a specific NodePool
        #[arg(value_name = "NODEPOOL")]
        nodepool: Option<String>,
    },

    /// Pause consolidation for a NodePool (use 'all' to pause all)
    #[command(after_help = r#"Examples:
  karc pause <NODEPOOL>   Pause a specific NodePool
  karc pause all          Pause all NodePools"#)]
    Pause {
        /// NodePool name to pause (use 'all' for all NodePools)
        #[arg(value_name = "NODEPOOL|all")]
        nodepool: String,
    },

    /// Resume consolidation for a NodePool (use 'all' to resume all)
    #[command(after_help = r#"Examples:
  karc resume <NODEPOOL>  Resume a specific NodePool
  karc resume all         Resume all NodePools"#)]
    Resume {
        /// NodePool name to resume (use 'all' for all NodePools)
        #[arg(value_name = "NODEPOOL|all")]
        nodepool: String,
    },
}

/// Application configuration derived from CLI args.
#[derive(Debug, Clone)]
pub struct Config {
    pub context: Option<String>,
    pub dry_run: bool,
    pub yes: bool,
    pub log_level: String,
    pub timezone: String,
    pub command: Command,
}

impl Config {
    /// Create config from CLI arguments.
    pub fn from_args(args: Args) -> Self {
        let timezone = args.timezone.unwrap_or_else(detect_local_timezone);

        Self {
            context: args.context,
            dry_run: args.dry_run,
            yes: args.yes,
            log_level: args.log_level,
            timezone,
            command: args.command,
        }
    }
}

/// Detect the local IANA timezone (e.g., "Asia/Seoul").
/// Falls back to "UTC" if detection fails.
fn detect_local_timezone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_config(command: Command) -> Config {
        Config {
            context: None,
            dry_run: false,
            yes: false,
            log_level: "warn".to_string(),
            timezone: "UTC".to_string(),
            command,
        }
    }

    #[test]
    fn test_config_status_command() {
        let config = create_test_config(Command::Status { nodepool: None });
        assert!(matches!(config.command, Command::Status { nodepool: None }));
        assert!(!config.dry_run);
        assert_eq!(config.timezone, "UTC");
    }

    #[test]
    fn test_config_pause_all() {
        let config = create_test_config(Command::Pause {
            nodepool: "all".to_string(),
        });
        if let Command::Pause { nodepool } = &config.command {
            assert_eq!(nodepool, "all");
        } else {
            panic!("Expected Pause command");
        }
    }

    #[test]
    fn test_config_resume_specific() {
        let config = create_test_config(Command::Resume {
            nodepool: "gpu-pool".to_string(),
        });
        if let Command::Resume { nodepool } = &config.command {
            assert_eq!(nodepool, "gpu-pool");
        } else {
            panic!("Expected Resume command");
        }
    }

    #[test]
    fn test_config_with_context() {
        let config = Config {
            context: Some("my-cluster".to_string()),
            dry_run: true,
            yes: false,
            log_level: "debug".to_string(),
            timezone: "Asia/Seoul".to_string(),
            command: Command::Status { nodepool: None },
        };
        assert_eq!(config.context.as_deref(), Some("my-cluster"));
        assert!(config.dry_run);
        assert_eq!(config.timezone, "Asia/Seoul");
    }

    #[test]
    fn test_detect_local_timezone() {
        let tz = detect_local_timezone();
        // Should return a valid IANA timezone, not empty
        assert!(!tz.is_empty());
        // Should be parseable by chrono-tz
        assert!(tz.parse::<chrono_tz::Tz>().is_ok());
    }
}
