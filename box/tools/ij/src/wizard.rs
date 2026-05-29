//! Interactive configuration wizard for `ij init`.

use colored::Colorize;
use dialoguer::console::style;
use dialoguer::{Confirm, Input, MultiSelect, Select};

use crate::config::AWS_REGIONS;
use crate::error::Result;
use crate::file_config::{FileConfig, ShellCommands};

/// Run the interactive configuration wizard.
pub fn run_wizard() -> Result<()> {
    println!(
        "{}\n",
        "Initializing ij configuration...".bright_blue().bold()
    );

    // Load existing config as defaults
    let existing = FileConfig::load_default()?.unwrap_or_default();

    // If config already exists, ask to overwrite
    let config_path = FileConfig::default_path()?;
    if config_path.exists() {
        println!(
            "  Existing config found: {}\n",
            config_path.display().to_string().bright_cyan()
        );
        let overwrite = Confirm::new()
            .with_prompt(
                style("Overwrite existing configuration?")
                    .bold()
                    .to_string(),
            )
            .default(true)
            .interact()
            .map_err(|_| crate::error::Error::Cancelled)?;
        if !overwrite {
            println!("{}", "Cancelled.".yellow());
            return Ok(());
        }
        println!();
    }

    // 1. AWS profile
    let aws_profile: String = Input::new()
        .with_prompt(
            style("Default AWS profile (leave empty for none)")
                .bold()
                .to_string(),
        )
        .default(
            existing
                .aws_profile
                .unwrap_or_else(|| "default".to_string()),
        )
        .allow_empty(true)
        .interact_text()
        .map_err(|_| crate::error::Error::Cancelled)?;
    let aws_profile = if aws_profile.is_empty() {
        None
    } else {
        Some(aws_profile)
    };

    // 2. AWS config file path
    let aws_config_file: String = Input::new()
        .with_prompt(style("AWS CLI config file path").bold().to_string())
        .default(existing.aws_config_file)
        .interact_text()
        .map_err(|_| crate::error::Error::Cancelled)?;

    // 3. Scan regions (multi-select)
    let existing_indices: Vec<bool> = AWS_REGIONS
        .iter()
        .map(|r| existing.scan_regions.contains(&r.to_string()))
        .collect();
    let has_existing_regions = existing_indices.iter().any(|&b| b);

    let defaults = if has_existing_regions {
        &existing_indices[..]
    } else {
        &[] as &[bool]
    };

    let selected_indices = MultiSelect::new()
        .with_prompt(
            style("Select scan regions (Space to select, Enter to confirm; none = all regions)")
                .bold()
                .to_string(),
        )
        .items(AWS_REGIONS)
        .defaults(defaults)
        .interact()
        .map_err(|_| crate::error::Error::Cancelled)?;

    let scan_regions: Vec<String> = selected_indices
        .iter()
        .map(|&i| AWS_REGIONS[i].to_string())
        .collect();

    // 4. Tag filters
    let existing_tags = existing.tag_filters.join(", ");
    let tag_input: String = Input::new()
        .with_prompt(
            style("Default tag filters (comma-separated Key=Value, or empty)")
                .bold()
                .to_string(),
        )
        .default(existing_tags)
        .allow_empty(true)
        .interact_text()
        .map_err(|_| crate::error::Error::Cancelled)?;
    let tag_filters: Vec<String> = if tag_input.is_empty() {
        Vec::new()
    } else {
        tag_input
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };

    // 5. Running instances only
    let running_only = Confirm::new()
        .with_prompt(style("Show only running instances?").bold().to_string())
        .default(existing.running_only.unwrap_or(true))
        .interact()
        .map_err(|_| crate::error::Error::Cancelled)?;

    // 6. Log level
    let log_levels = ["error", "warn", "info", "debug", "trace"];
    let existing_level_idx = existing
        .log_level
        .as_deref()
        .and_then(|l| log_levels.iter().position(|&ll| ll == l))
        .unwrap_or(2); // default: info

    let level_idx = Select::new()
        .with_prompt(style("Default log level").bold().to_string())
        .items(&log_levels)
        .default(existing_level_idx)
        .interact()
        .map_err(|_| crate::error::Error::Cancelled)?;

    // 7. Shell commands
    let existing_sc = existing.shell_commands;

    let shell_enabled = Confirm::new()
        .with_prompt(
            style("Enable shell commands on connect?")
                .bold()
                .to_string(),
        )
        .default(existing_sc.enabled)
        .interact()
        .map_err(|_| crate::error::Error::Cancelled)?;

    let shell_commands = if shell_enabled {
        let shell_input: String = Input::new()
            .with_prompt(
                style("Shell commands (semicolon-separated, e.g., 'sudo su -; cd /var/log')")
                    .bold()
                    .to_string(),
            )
            .default(existing_sc.commands.join("; "))
            .allow_empty(true)
            .interact_text()
            .map_err(|_| crate::error::Error::Cancelled)?;
        let commands: Vec<String> = if shell_input.is_empty() {
            Vec::new()
        } else {
            shell_input
                .split(';')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };
        ShellCommands {
            enabled: true,
            commands,
        }
    } else {
        // Preserve existing commands but disabled
        ShellCommands {
            enabled: false,
            commands: existing_sc.commands,
        }
    };

    let config = FileConfig {
        aws_profile,
        aws_config_file,
        scan_regions,
        tag_filters,
        running_only: Some(running_only),
        log_level: Some(log_levels[level_idx].to_string()),
        shell_commands,
    };

    let saved_path = config.save_default()?;
    println!(
        "\n{} {}",
        "Config saved to".bright_green().bold(),
        saved_path.display().to_string().bright_cyan()
    );

    Ok(())
}
