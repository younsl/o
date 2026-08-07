//! File-based configuration for ij.
//!
//! Loads and saves YAML configuration from `$XDG_CONFIG_HOME/ij/config.yaml`
//! (defaults to `~/.config/ij/config.yaml`).

use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize};

use crate::error::{Error, Result};

/// Field documentation: (yaml_key, type_label, description).
const FIELD_DOCS: &[(&str, &str, &str)] = &[
    ("aws_profile", "string", "AWS profile name"),
    ("aws_config_file", "string", "AWS CLI config file path"),
    (
        "scan_regions",
        "list<string>",
        "Regions to scan, empty means all regions",
    ),
    (
        "tag_filters",
        "list<string>",
        "Tag filters in Key=Value format",
    ),
    ("running_only", "bool", "Only show running instances"),
    (
        "log_level",
        "string",
        "Log level: trace, debug, info, warn, error",
    ),
    (
        "shell_commands",
        "",
        "Shell commands executed on SSM connect",
    ),
    ("enabled", "bool", "Enable shell commands"),
    (
        "commands",
        "list<string>",
        "Commands to execute, joined with \";\"",
    ),
];

/// Insert `# (type) description` comments above matching YAML keys.
fn insert_comments(yaml: &str) -> String {
    let mut out = String::new();
    for line in yaml.lines() {
        let trimmed = line.trim_start();
        if let Some(&(_, typ, desc)) = trimmed
            .split(':')
            .next()
            .and_then(|key| FIELD_DOCS.iter().find(|(k, _, _)| *k == key))
        {
            let indent = &line[..line.len() - trimmed.len()];
            if typ.is_empty() {
                out.push_str(&format!("{indent}# {desc}\n"));
            } else {
                out.push_str(&format!("{indent}# ({typ}) {desc}\n"));
            }
        }
        // Indent root-level list items
        if !line.starts_with(' ') && trimmed.starts_with('-') {
            out.push_str("  ");
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Deserialize a field that can be either a string or a list of strings.
fn string_or_vec<'de, D>(deserializer: D) -> std::result::Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrVec {
        String(String),
        Vec(Vec<String>),
    }

    match StringOrVec::deserialize(deserializer)? {
        StringOrVec::String(s) => Ok(vec![s]),
        StringOrVec::Vec(v) => Ok(v),
    }
}

/// Shell commands configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ShellCommands {
    /// Whether shell commands are enabled.
    #[serde(default)]
    pub enabled: bool,

    /// Commands to execute on connect (joined with ";").
    #[serde(default, deserialize_with = "string_or_vec")]
    pub commands: Vec<String>,
}

/// File-based configuration.
/// Default AWS CLI config file path.
const DEFAULT_AWS_CONFIG_FILE: &str = "~/.aws/config";

fn default_aws_config_file() -> String {
    DEFAULT_AWS_CONFIG_FILE.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileConfig {
    /// Default AWS profile name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aws_profile: Option<String>,

    /// AWS CLI config file path.
    #[serde(default = "default_aws_config_file")]
    pub aws_config_file: String,

    /// Regions to scan (empty = all 22 regions).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scan_regions: Vec<String>,

    /// Default tag filters (Key=Value format).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tag_filters: Vec<String>,

    /// Only show running instances.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub running_only: Option<bool>,

    /// Log level (trace, debug, info, warn, error).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log_level: Option<String>,

    /// Shell commands configuration.
    #[serde(default)]
    pub shell_commands: ShellCommands,
}

impl Default for FileConfig {
    fn default() -> Self {
        Self {
            aws_profile: None,
            aws_config_file: default_aws_config_file(),
            scan_regions: Vec::new(),
            tag_filters: Vec::new(),
            running_only: None,
            log_level: None,
            shell_commands: ShellCommands::default(),
        }
    }
}

/// Resolve config base directory from an optional XDG path and home directory.
///
/// Pure function: no env var or filesystem access.
pub fn resolve_config_path(
    xdg_config_home: Option<&str>,
    home_dir: Option<PathBuf>,
) -> Result<PathBuf> {
    let base = match xdg_config_home {
        Some(xdg) if !xdg.is_empty() => PathBuf::from(xdg),
        _ => home_dir
            .ok_or_else(|| Error::Config("could not determine home directory".into()))?
            .join(".config"),
    };
    Ok(base.join("ij").join("config.yaml"))
}

impl FileConfig {
    /// Return default config file path.
    ///
    /// Uses `$XDG_CONFIG_HOME/ij/config.yaml`, falling back to `~/.config/ij/config.yaml`.
    pub fn default_path() -> Result<PathBuf> {
        resolve_config_path(
            std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
            dirs::home_dir(),
        )
    }

    /// Load config from the default path. Returns `Ok(None)` if the file does not exist.
    pub fn load_default() -> Result<Option<Self>> {
        Self::load_if_exists(&Self::default_path()?)
    }

    /// Load config from a path if it exists. Returns `Ok(None)` if the file does not exist.
    pub fn load_if_exists(path: &PathBuf) -> Result<Option<Self>> {
        if !path.exists() {
            return Ok(None);
        }
        Self::load(path).map(Some)
    }

    /// Load config from a specific path.
    pub fn load(path: &PathBuf) -> Result<Self> {
        let contents = std::fs::read_to_string(path)?;
        let config: FileConfig = serde_yaml::from_str(&contents)?;
        Ok(config)
    }

    /// Save config to the default path.
    pub fn save_default(&self) -> Result<PathBuf> {
        let path = Self::default_path()?;
        self.save(&path)?;
        Ok(path)
    }

    /// Save config to a specific path, creating parent directories as needed.
    pub fn save(&self, path: &PathBuf) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let yaml = serde_yaml::to_string(self)?;
        let content = format!(
            "# ij configuration file\n# Generated by `ij init`\n\n{}",
            insert_comments(&yaml)
        );
        std::fs::write(path, content)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn default_has_expected_values() {
        let fc = FileConfig::default();
        assert_eq!(fc.aws_profile, None);
        assert_eq!(fc.aws_config_file, "~/.aws/config");
        assert!(fc.scan_regions.is_empty());
        assert!(fc.tag_filters.is_empty());
        assert_eq!(fc.running_only, None);
        assert_eq!(fc.log_level, None);
    }

    #[test]
    fn serialize_full_config() {
        let fc = FileConfig {
            aws_profile: Some("prod".into()),
            aws_config_file: "/custom/aws/config".into(),
            scan_regions: vec!["us-east-1".into(), "ap-northeast-2".into()],
            tag_filters: vec!["Environment=production".into()],
            running_only: Some(true),
            log_level: Some("debug".into()),
            shell_commands: ShellCommands {
                enabled: true,
                commands: vec!["sudo su -".into()],
            },
        };
        let yaml = serde_yaml::to_string(&fc).unwrap();
        assert!(yaml.contains("aws_profile: prod"));
        assert!(yaml.contains("aws_config_file: /custom/aws/config"));
        assert!(yaml.contains("us-east-1"));
        assert!(yaml.contains("ap-northeast-2"));
        assert!(yaml.contains("Environment=production"));
        assert!(yaml.contains("running_only: true"));
        assert!(yaml.contains("log_level: debug"));
    }

    #[test]
    fn serialize_default_omits_optional_fields() {
        let fc = FileConfig::default();
        let yaml = serde_yaml::to_string(&fc).unwrap();
        // aws_config_file is always present
        assert!(yaml.contains("aws_config_file:"));
        // Optional None fields are skipped
        assert!(!yaml.contains("aws_profile:"));
        assert!(!yaml.contains("running_only:"));
        assert!(!yaml.contains("log_level:"));
        // Empty vecs are skipped
        assert!(!yaml.contains("scan_regions:"));
        assert!(!yaml.contains("tag_filters:"));
    }

    #[test]
    fn deserialize_full_yaml() {
        let yaml = r#"
aws_profile: dev
aws_config_file: /tmp/aws-config
scan_regions:
  - us-west-2
tag_filters:
  - Team=platform
running_only: false
log_level: warn
"#;
        let fc: FileConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(fc.aws_profile.as_deref(), Some("dev"));
        assert_eq!(fc.aws_config_file, "/tmp/aws-config");
        assert_eq!(fc.scan_regions, vec!["us-west-2"]);
        assert_eq!(fc.tag_filters, vec!["Team=platform"]);
        assert_eq!(fc.running_only, Some(false));
        assert_eq!(fc.log_level.as_deref(), Some("warn"));
    }

    #[test]
    fn deserialize_empty_yaml_uses_defaults() {
        let yaml = "{}";
        let fc: FileConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(fc.aws_profile, None);
        assert_eq!(fc.aws_config_file, "~/.aws/config");
        assert!(fc.scan_regions.is_empty());
        assert!(fc.tag_filters.is_empty());
        assert_eq!(fc.running_only, None);
        assert_eq!(fc.log_level, None);
    }

    #[test]
    fn deserialize_partial_yaml() {
        let yaml = "aws_profile: staging\n";
        let fc: FileConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(fc.aws_profile.as_deref(), Some("staging"));
        assert_eq!(fc.aws_config_file, "~/.aws/config");
        assert!(fc.scan_regions.is_empty());
    }

    #[test]
    fn roundtrip_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");

        let original = FileConfig {
            aws_profile: Some("test-profile".into()),
            aws_config_file: "/opt/aws/config".into(),
            scan_regions: vec!["eu-west-1".into()],
            tag_filters: vec!["Env=test".into()],
            running_only: Some(false),
            log_level: Some("trace".into()),
            shell_commands: ShellCommands::default(),
        };
        original.save(&path).unwrap();

        let loaded = FileConfig::load(&path).unwrap();
        assert_eq!(loaded.aws_profile, original.aws_profile);
        assert_eq!(loaded.aws_config_file, original.aws_config_file);
        assert_eq!(loaded.scan_regions, original.scan_regions);
        assert_eq!(loaded.tag_filters, original.tag_filters);
        assert_eq!(loaded.running_only, original.running_only);
        assert_eq!(loaded.log_level, original.log_level);
    }

    #[test]
    fn save_creates_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("dir").join("config.yaml");

        let fc = FileConfig::default();
        fc.save(&path).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn save_includes_comment_header() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");

        FileConfig::default().save(&path).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("# ij configuration file\n# Generated by `ij init`\n"));
    }

    #[test]
    fn load_nonexistent_file_returns_io_error() {
        let path = PathBuf::from("/tmp/ij-test-nonexistent-12345/config.yaml");
        let result = FileConfig::load(&path);
        assert!(result.is_err());
    }

    // --- resolve_config_path tests (pure function, no env var manipulation) ---

    #[test]
    fn resolve_config_path_with_xdg() {
        let path = resolve_config_path(Some("/tmp/xdg"), None).unwrap();
        assert_eq!(path, PathBuf::from("/tmp/xdg/ij/config.yaml"));
    }

    #[test]
    fn resolve_config_path_empty_xdg_falls_back_to_home() {
        let home = PathBuf::from("/home/testuser");
        let path = resolve_config_path(Some(""), Some(home)).unwrap();
        assert_eq!(path, PathBuf::from("/home/testuser/.config/ij/config.yaml"));
    }

    #[test]
    fn resolve_config_path_none_xdg_falls_back_to_home() {
        let home = PathBuf::from("/Users/testuser");
        let path = resolve_config_path(None, Some(home)).unwrap();
        assert_eq!(
            path,
            PathBuf::from("/Users/testuser/.config/ij/config.yaml")
        );
    }

    #[test]
    fn resolve_config_path_no_xdg_no_home_returns_error() {
        let result = resolve_config_path(None, None);
        assert!(result.is_err());
    }

    #[test]
    fn default_path_returns_valid_path() {
        let path = FileConfig::default_path().unwrap();
        assert!(path.ends_with("ij/config.yaml"));
    }

    #[test]
    fn load_default_does_not_error() {
        // load_default should return Ok regardless of whether the config file exists
        let result = FileConfig::load_default();
        assert!(result.is_ok());
    }

    #[test]
    fn load_if_exists_returns_none_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nonexistent.yaml");
        let result = FileConfig::load_if_exists(&path).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn load_if_exists_returns_some_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        FileConfig::default().save(&path).unwrap();
        let result = FileConfig::load_if_exists(&path).unwrap();
        assert!(result.is_some());
    }

    #[test]
    fn save_and_load_via_explicit_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ij").join("config.yaml");

        let config = FileConfig {
            aws_profile: Some("test".into()),
            ..FileConfig::default()
        };
        config.save(&path).unwrap();

        // Simulate what load_default does: check exists, then load
        assert!(path.exists());
        let loaded = FileConfig::load(&path).unwrap();
        assert_eq!(loaded.aws_profile.as_deref(), Some("test"));
    }

    // --- ShellCommands deserialize tests ---

    #[test]
    fn deserialize_shell_commands_struct() {
        let yaml = r#"
shell_commands:
  enabled: true
  commands:
    - "sudo su -"
    - "whoami"
"#;
        let fc: FileConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(fc.shell_commands.enabled);
        assert_eq!(fc.shell_commands.commands, vec!["sudo su -", "whoami"]);
    }

    #[test]
    fn deserialize_shell_commands_disabled() {
        let yaml = r#"
shell_commands:
  enabled: false
  commands:
    - "sudo su -"
"#;
        let fc: FileConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(!fc.shell_commands.enabled);
        assert_eq!(fc.shell_commands.commands, vec!["sudo su -"]);
    }

    #[test]
    fn deserialize_shell_commands_missing_defaults() {
        let yaml = "{}";
        let fc: FileConfig = serde_yaml::from_str(yaml).unwrap();
        assert!(!fc.shell_commands.enabled);
        assert!(fc.shell_commands.commands.is_empty());
    }

    #[test]
    fn deserialize_shell_commands_single_string() {
        let yaml = r#"
shell_commands:
  enabled: true
  commands: "sudo su -"
"#;
        let fc: FileConfig = serde_yaml::from_str(yaml).unwrap();
        assert_eq!(fc.shell_commands.commands, vec!["sudo su -"]);
    }

    // --- insert_comments tests ---

    #[test]
    fn insert_comments_adds_type_annotations() {
        let yaml = "aws_profile: default\nrunning_only: true\n";
        let result = insert_comments(yaml);
        assert!(result.contains("# (string) AWS profile name\naws_profile: default"));
        assert!(result.contains("# (bool) Only show running instances\nrunning_only: true"));
    }

    #[test]
    fn insert_comments_shell_commands_section() {
        let yaml = "shell_commands:\n  enabled: true\n  commands:\n  - sudo su -\n";
        let result = insert_comments(yaml);
        assert!(result.contains("# Shell commands executed on SSM connect\nshell_commands:"));
        assert!(result.contains("  # (bool) Enable shell commands\n  enabled: true"));
        assert!(result.contains("  # (list<string>) Commands to execute"));
    }

    #[test]
    fn insert_comments_indents_root_list_items() {
        let yaml = "scan_regions:\n- ap-northeast-2\n- us-east-1\n";
        let result = insert_comments(yaml);
        assert!(result.contains("  - ap-northeast-2"));
        assert!(result.contains("  - us-east-1"));
    }

    #[test]
    fn save_generates_commented_yaml() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.yaml");

        let fc = FileConfig {
            aws_profile: Some("prod".into()),
            scan_regions: vec!["us-east-1".into()],
            shell_commands: ShellCommands {
                enabled: true,
                commands: vec!["sudo su -".into()],
            },
            ..FileConfig::default()
        };
        fc.save(&path).unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.starts_with("# ij configuration file"));
        assert!(content.contains("# (string) AWS profile name\naws_profile: prod"));
        assert!(content.contains("# (bool) Enable shell commands"));
        assert!(content.contains("  - us-east-1"));
    }

    #[test]
    fn load_invalid_yaml_returns_config_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bad.yaml");
        let mut f = std::fs::File::create(&path).unwrap();
        writeln!(f, "{{{{invalid yaml").unwrap();

        let result = FileConfig::load(&path);
        assert!(result.is_err());
    }
}
