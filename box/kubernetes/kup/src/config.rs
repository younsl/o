//! CLI configuration and argument parsing.

use clap::Parser;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("BUILD_COMMIT");
pub const BUILD_DATE: &str = env!("BUILD_DATE");

/// EKS cluster upgrade support CLI tool.
///
/// Analyzes API deprecations, recommends upgrade paths, and executes
/// sequential control plane upgrades with add-on and managed node group updates.
#[derive(Parser, Debug, Clone)]
#[command(name = "kup")]
#[command(about = "EKS cluster upgrade support CLI tool")]
#[command(version = const_format::formatcp!(
    "{} (commit: {}, build date: {})",
    VERSION, COMMIT, BUILD_DATE
))]
pub struct Args {
    /// AWS region
    #[arg(short, long, env = "AWS_REGION")]
    pub region: Option<String>,

    /// AWS profile to use
    #[arg(short, long, env = "AWS_PROFILE")]
    pub profile: Option<String>,

    /// Cluster name (non-interactive mode)
    #[arg(short, long)]
    pub cluster: Option<String>,

    /// Target Kubernetes version (e.g., 1.34)
    #[arg(short, long)]
    pub target: Option<String>,

    /// Skip confirmation prompts (non-interactive mode)
    #[arg(short, long, default_value = "false")]
    pub yes: bool,

    /// Show upgrade plan without executing
    #[arg(long, default_value = "false")]
    pub dry_run: bool,

    /// Specific add-on versions (format: ADDON=VERSION, e.g., kube-proxy=v1.34.0-eksbuild.1)
    #[arg(long = "addon-version", value_name = "ADDON=VERSION")]
    pub addon_versions: Vec<String>,

    /// Log level (trace, debug, info, warn, error)
    #[arg(long, default_value = "warn", env = "EKUP_LOG_LEVEL")]
    pub log_level: String,
}

/// Application configuration derived from CLI args.
#[derive(Debug, Clone)]
pub struct Config {
    pub region: Option<String>,
    pub profile: Option<String>,
    pub cluster: Option<String>,
    pub target_version: Option<String>,
    pub yes: bool,
    pub dry_run: bool,
    pub addon_versions: std::collections::HashMap<String, String>,
    pub log_level: String,
}

impl Config {
    /// Create config from CLI arguments.
    pub fn from_args(args: Args) -> Self {
        let addon_versions = args
            .addon_versions
            .iter()
            .filter_map(|s| {
                let parts: Vec<&str> = s.splitn(2, '=').collect();
                if parts.len() == 2 {
                    Some((parts[0].to_string(), parts[1].to_string()))
                } else {
                    None
                }
            })
            .collect();

        Self {
            region: args.region,
            profile: args.profile,
            cluster: args.cluster,
            target_version: args.target,
            yes: args.yes,
            dry_run: args.dry_run,
            addon_versions,
            log_level: args.log_level,
        }
    }

    /// Check if running in interactive mode.
    pub fn is_interactive(&self) -> bool {
        self.cluster.is_none() || self.target_version.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_args(
        cluster: Option<&str>,
        target: Option<&str>,
        addon_versions: Vec<&str>,
    ) -> Args {
        Args {
            region: None,
            profile: None,
            cluster: cluster.map(String::from),
            target: target.map(String::from),
            yes: false,
            dry_run: false,
            addon_versions: addon_versions.iter().map(|s| s.to_string()).collect(),
            log_level: "warn".to_string(),
        }
    }

    #[test]
    fn test_is_interactive_no_args() {
        let args = create_test_args(None, None, vec![]);
        let config = Config::from_args(args);
        assert!(config.is_interactive());
    }

    #[test]
    fn test_is_interactive_cluster_only() {
        let args = create_test_args(Some("my-cluster"), None, vec![]);
        let config = Config::from_args(args);
        assert!(config.is_interactive());
    }

    #[test]
    fn test_is_interactive_target_only() {
        let args = create_test_args(None, Some("1.34"), vec![]);
        let config = Config::from_args(args);
        assert!(config.is_interactive());
    }

    #[test]
    fn test_non_interactive_mode() {
        let args = create_test_args(Some("my-cluster"), Some("1.34"), vec![]);
        let config = Config::from_args(args);
        assert!(!config.is_interactive());
    }

    #[test]
    fn test_addon_version_parsing() {
        let args = create_test_args(
            None,
            None,
            vec!["kube-proxy=v1.34.0-eksbuild.1", "coredns=v1.11.3"],
        );
        let config = Config::from_args(args);

        assert_eq!(config.addon_versions.len(), 2);
        assert_eq!(
            config.addon_versions.get("kube-proxy"),
            Some(&"v1.34.0-eksbuild.1".to_string())
        );
        assert_eq!(
            config.addon_versions.get("coredns"),
            Some(&"v1.11.3".to_string())
        );
    }

    #[test]
    fn test_addon_version_parsing_invalid() {
        let args = create_test_args(None, None, vec!["invalid-format", "valid=version"]);
        let config = Config::from_args(args);

        assert_eq!(config.addon_versions.len(), 1);
        assert_eq!(
            config.addon_versions.get("valid"),
            Some(&"version".to_string())
        );
    }
}
