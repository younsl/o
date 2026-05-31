mod command;
mod config;
mod ops;
mod redis_client;
mod tty;

use anyhow::{Context, Result};
use clap::Parser;
use colored::Colorize;
use command::Command;
use config::Config;
use ops::{Connector, RealConnector, RedisOps};
use rustyline::DefaultEditor;
use rustyline::error::ReadlineError;
use std::path::PathBuf;
use tabled::{Table, Tabled};
use tokio::time::{Duration, timeout};
use tty::tty_writeln;

const BANNER: &str = r#"
    ____           ___          ______                       __
   / __ \___  ____/ (_)____    / ____/___  ____  _________  / /__
  / /_/ / _ \/ __  / / ___/   / /   / __ \/ __ \/ ___/ __ \/ / _ \
 / _, _/  __/ /_/ / (__  )   / /___/ /_/ / / / (__  ) /_/ / /  __/
/_/ |_|\___/\__,_/_/____/    \____/\____/_/ /_/____/\____/_/\___/
    "#;

#[derive(Parser, Debug)]
#[command(
    name = "redis-console",
    version,
    about = "Interactive CLI for managing multiple Redis clusters"
)]
struct Args {
    /// Configuration file path
    #[arg(short, long)]
    config: Option<PathBuf>,
}

#[derive(Tabled)]
struct ClusterRow {
    #[tabled(rename = "ID")]
    id: usize,
    #[tabled(rename = "Alias")]
    alias: String,
    #[tabled(rename = "Host")]
    host: String,
    #[tabled(rename = "Port")]
    port: u16,
    #[tabled(rename = "Engine")]
    engine: String,
    #[tabled(rename = "Version")]
    version: String,
    #[tabled(rename = "Mode")]
    mode: String,
    #[tabled(rename = "TLS")]
    tls: String,
    #[tabled(rename = "Status")]
    status: String,
}

/// Control flow signal returned by command handling.
#[derive(Debug, PartialEq, Eq)]
enum Flow {
    Continue,
    Quit,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();

    // Load configuration
    let config = if let Some(config_path) = args.config {
        Config::load_from_file(&config_path)
            .with_context(|| format!("Failed to load config from {config_path:?}"))?
    } else {
        Config::load().context("Failed to load configuration")?
    };

    for line in banner_lines() {
        let _ = tty_writeln(&line);
    }

    run_repl(config, &RealConnector).await
}

/// Render the startup banner lines.
fn banner_lines() -> Vec<String> {
    vec![
        BANNER.bright_cyan().bold().to_string(),
        format!(
            "Interactive CLI for managing multiple Redis clusters - v{}",
            env!("CARGO_PKG_VERSION")
        )
        .bright_cyan()
        .to_string(),
        String::new(),
    ]
}

/// Detect whether an interactive TTY is available.
fn detect_tty_status() -> &'static str {
    if std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .is_ok()
    {
        "tty"
    } else {
        "no-tty"
    }
}

/// Build the REPL prompt string.
fn build_prompt(tty_status: &str, connected_alias: Option<&str>) -> String {
    match connected_alias {
        Some(alias) => format!("{tty_status}.redis-console [{alias}]> "),
        None => format!("{tty_status}.redis-console> "),
    }
}

async fn run_repl<Cn: Connector>(config: Config, connector: &Cn) -> Result<()> {
    let mut rl = DefaultEditor::new()?;
    let mut current_cluster: Option<(usize, Cn::Client)> = None;
    let tty_status = detect_tty_status();

    for line in help_lines() {
        let _ = tty_writeln(&line);
    }
    let _ = tty_writeln("");

    loop {
        let prompt = build_prompt(
            tty_status,
            current_cluster
                .as_ref()
                .map(|(idx, _)| config.clusters[*idx].alias.as_str()),
        );

        match rl.readline(&prompt) {
            Ok(line) => {
                let cmd = command::parse(&line);
                if cmd == Command::Empty {
                    continue;
                }
                let _ = rl.add_history_entry(line.trim());

                let (output, flow) =
                    handle_command(cmd, &config, connector, &mut current_cluster).await;
                for entry in output {
                    let _ = tty_writeln(&entry);
                }
                if flow == Flow::Quit {
                    break;
                }
            }
            Err(ReadlineError::Interrupted) => {
                let _ = tty_writeln(&"CTRL-C".yellow().to_string());
                continue;
            }
            Err(ReadlineError::Eof) => {
                let _ = tty_writeln(&"CTRL-D".yellow().to_string());
                break;
            }
            Err(err) => {
                // Critical error - keep in stdout for kubectl logs
                println!("{}", format!("Error: {err:?}").red());
                break;
            }
        }

        let _ = tty_writeln("");
    }

    Ok(())
}

/// Handle a single parsed command, returning output lines and a control signal.
async fn handle_command<Cn: Connector>(
    cmd: Command,
    config: &Config,
    connector: &Cn,
    current_cluster: &mut Option<(usize, Cn::Client)>,
) -> (Vec<String>, Flow) {
    match cmd {
        Command::Help => (help_lines(), Flow::Continue),
        Command::List => (check_health(config, connector).await, Flow::Continue),
        Command::Connect(None) => (
            vec!["Usage: connect <cluster-id or name>".red().to_string()],
            Flow::Continue,
        ),
        Command::Connect(Some(identifier)) => {
            let (lines, connected) = connect_cluster(config, connector, &identifier).await;
            if let Some(connected) = connected {
                *current_cluster = Some(connected);
            }
            (lines, Flow::Continue)
        }
        Command::Info => {
            if let Some((_, client)) = current_cluster.as_mut() {
                (execute_info(client).await, Flow::Continue)
            } else {
                (
                    vec!["Not connected. Use 'connect <id>' first".red().to_string()],
                    Flow::Continue,
                )
            }
        }
        Command::Quit => {
            if let Some((idx, _)) = current_cluster.take() {
                (
                    vec![
                        format!("Disconnected from {}", config.clusters[idx].alias)
                            .yellow()
                            .to_string(),
                    ],
                    Flow::Continue,
                )
            } else {
                (vec!["Goodbye!".bright_cyan().to_string()], Flow::Quit)
            }
        }
        Command::Redis(line) => {
            if let Some((_, client)) = current_cluster.as_mut() {
                (execute_redis_command(client, &line).await, Flow::Continue)
            } else {
                (
                    vec![
                        "Unknown command. Type 'help' for available commands"
                            .red()
                            .to_string(),
                    ],
                    Flow::Continue,
                )
            }
        }
        Command::Empty => (Vec::new(), Flow::Continue),
    }
}

/// Build the help message lines.
fn help_lines() -> Vec<String> {
    vec![
        "Available Commands:".bright_yellow().bold().to_string(),
        format!("  {}  - Show this help message", "help, h".green()),
        format!(
            "  {}  - List all clusters with health status",
            "list, ls, l".green()
        ),
        format!(
            "  {}  - Connect to a cluster by ID or name",
            "connect <id|name>, c".green()
        ),
        format!(
            "  {}  - Show Redis server info (when connected)",
            "info".green()
        ),
        format!(
            "  {}  - Disconnect (if connected) or exit",
            "quit, exit, q".green()
        ),
        String::new(),
        "When connected, you can execute any Redis command directly:"
            .bright_yellow()
            .to_string(),
        "  Example: GET mykey".to_string(),
        "  Example: SET mykey value".to_string(),
        "  Example: KEYS *".to_string(),
    ]
}

/// Resolve a cluster identifier (numeric id or alias) to an index.
fn resolve_cluster_index(config: &Config, identifier: &str) -> Option<usize> {
    if let Ok(id) = identifier.parse::<usize>() {
        (id < config.clusters.len()).then_some(id)
    } else {
        config
            .clusters
            .iter()
            .position(|c| c.alias.eq_ignore_ascii_case(identifier))
    }
}

async fn check_health<Cn: Connector>(config: &Config, connector: &Cn) -> Vec<String> {
    let mut output = vec![
        format!(
            "Checking {} clusters from {}",
            config.clusters.len(),
            config.source_description()
        )
        .bright_cyan()
        .to_string(),
    ];

    let mut rows = Vec::new();

    for (i, cluster) in config.clusters.iter().enumerate() {
        let (status, engine, version, mode) =
            match timeout(Duration::from_secs(2), connector.connect(cluster.clone())).await {
                Ok(Ok(mut client)) => match client.server_info().await {
                    Ok((e, v, m)) => ("Healthy".to_string(), e, v, m),
                    Err(_) => (
                        "Healthy".to_string(),
                        "unknown".to_string(),
                        "unknown".to_string(),
                        "unknown".to_string(),
                    ),
                },
                Ok(Err(e)) => (
                    format!("Unhealthy: {e}"),
                    "-".to_string(),
                    "-".to_string(),
                    "-".to_string(),
                ),
                Err(_) => (
                    "Timeout".to_string(),
                    "-".to_string(),
                    "-".to_string(),
                    "-".to_string(),
                ),
            };

        rows.push(ClusterRow {
            id: i,
            alias: cluster.alias.clone(),
            host: cluster.host.clone(),
            port: cluster.port,
            engine,
            version,
            mode,
            tls: if cluster.tls { "Yes" } else { "No" }.to_string(),
            status,
        });
    }

    output.push(Table::new(rows).to_string());
    output
}

async fn connect_cluster<Cn: Connector>(
    config: &Config,
    connector: &Cn,
    identifier: &str,
) -> (Vec<String>, Option<(usize, Cn::Client)>) {
    let Some(idx) = resolve_cluster_index(config, identifier) else {
        return (
            vec![
                format!("Cluster '{identifier}' not found")
                    .red()
                    .to_string(),
            ],
            None,
        );
    };

    let cluster = config.clusters[idx].clone();
    let alias = cluster.alias.clone();
    let mut lines = vec![
        format!("Connecting to {alias}...")
            .bright_cyan()
            .to_string(),
    ];

    match connector.connect(cluster).await {
        Ok(client) => {
            lines.push(format!("Connected to {alias}").green().to_string());
            (lines, Some((idx, client)))
        }
        Err(e) => {
            lines.push(format!("Failed to connect: {e}").red().to_string());
            (lines, None)
        }
    }
}

async fn execute_info<C: RedisOps>(client: &mut C) -> Vec<String> {
    match client.info().await {
        Ok(info) => vec![
            "Redis Server Info:".bright_yellow().bold().to_string(),
            info,
        ],
        Err(e) => vec![format!("Error getting info: {e}").red().to_string()],
    }
}

async fn execute_redis_command<C: RedisOps>(client: &mut C, command: &str) -> Vec<String> {
    match client.execute_command(command).await {
        Ok(output) => {
            if output.is_empty() {
                vec!["(nil)".bright_black().to_string()]
            } else {
                vec![output]
            }
        }
        Err(e) => vec![format!("Error: {e}").red().to_string()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ClusterConfig, ConfigSource};

    fn cluster(alias: &str) -> ClusterConfig {
        ClusterConfig {
            alias: alias.to_string(),
            host: "localhost".to_string(),
            port: 6379,
            password: None,
            tls: false,
            cluster_mode: false,
            description: None,
        }
    }

    fn config_with(aliases: &[&str]) -> Config {
        Config {
            clusters: aliases.iter().map(|a| cluster(a)).collect(),
            aws_region: None,
            source: ConfigSource::Empty,
        }
    }

    /// In-memory fake client.
    struct FakeClient {
        fail: bool,
        exec_output: String,
    }

    impl RedisOps for FakeClient {
        async fn info(&mut self) -> Result<String> {
            if self.fail {
                anyhow::bail!("info failed");
            }
            Ok("redis_version:7.0.0".to_string())
        }

        async fn server_info(&mut self) -> Result<(String, String, String)> {
            if self.fail {
                anyhow::bail!("server_info failed");
            }
            Ok((
                "redis".to_string(),
                "7.0.0".to_string(),
                "standalone".to_string(),
            ))
        }

        async fn execute_command(&mut self, _cmd: &str) -> Result<String> {
            if self.fail {
                anyhow::bail!("command failed");
            }
            Ok(self.exec_output.clone())
        }
    }

    /// Connector behaviour selector for tests.
    enum FakeMode {
        Ok,
        ConnectError,
        ServerError,
        EmptyExec,
    }

    struct FakeConnector {
        mode: FakeMode,
    }

    impl Connector for FakeConnector {
        type Client = FakeClient;

        async fn connect(&self, _config: ClusterConfig) -> Result<FakeClient> {
            match self.mode {
                FakeMode::ConnectError => anyhow::bail!("connect failed"),
                FakeMode::ServerError => Ok(FakeClient {
                    fail: true,
                    exec_output: String::new(),
                }),
                FakeMode::EmptyExec => Ok(FakeClient {
                    fail: false,
                    exec_output: String::new(),
                }),
                FakeMode::Ok => Ok(FakeClient {
                    fail: false,
                    exec_output: "value".to_string(),
                }),
            }
        }
    }

    fn ok_connector() -> FakeConnector {
        FakeConnector { mode: FakeMode::Ok }
    }

    fn joined(lines: &[String]) -> String {
        lines.join("\n")
    }

    #[test]
    fn prompt_reflects_connection_state() {
        assert_eq!(build_prompt("tty", None), "tty.redis-console> ");
        assert_eq!(
            build_prompt("no-tty", Some("prod")),
            "no-tty.redis-console [prod]> "
        );
    }

    #[test]
    fn help_and_banner_are_non_empty() {
        assert!(
            help_lines()
                .iter()
                .any(|l| l.contains("Available Commands"))
        );
        assert!(banner_lines().iter().any(|l| l.contains("Interactive CLI")));
    }

    #[test]
    fn detect_tty_status_returns_known_value() {
        assert!(matches!(detect_tty_status(), "tty" | "no-tty"));
    }

    #[test]
    fn resolve_index_by_id_and_alias() {
        let config = config_with(&["prod", "staging"]);
        assert_eq!(resolve_cluster_index(&config, "0"), Some(0));
        assert_eq!(resolve_cluster_index(&config, "1"), Some(1));
        assert_eq!(resolve_cluster_index(&config, "5"), None);
        assert_eq!(resolve_cluster_index(&config, "PROD"), Some(0));
        assert_eq!(resolve_cluster_index(&config, "staging"), Some(1));
        assert_eq!(resolve_cluster_index(&config, "missing"), None);
    }

    #[tokio::test]
    async fn handle_help_and_list_and_empty() {
        let config = config_with(&["prod"]);
        let connector = ok_connector();
        let mut current = None;

        let (out, flow) = handle_command(Command::Help, &config, &connector, &mut current).await;
        assert_eq!(flow, Flow::Continue);
        assert!(joined(&out).contains("Available Commands"));

        let (out, _) = handle_command(Command::List, &config, &connector, &mut current).await;
        assert!(joined(&out).contains("Checking 1 clusters"));
        assert!(joined(&out).contains("prod"));

        let (out, flow) = handle_command(Command::Empty, &config, &connector, &mut current).await;
        assert!(out.is_empty());
        assert_eq!(flow, Flow::Continue);
    }

    #[tokio::test]
    async fn handle_connect_success_then_info_and_redis() {
        let config = config_with(&["prod"]);
        let connector = ok_connector();
        let mut current = None;

        let (out, _) = handle_command(
            Command::Connect(Some("prod".to_string())),
            &config,
            &connector,
            &mut current,
        )
        .await;
        assert!(joined(&out).contains("Connected to prod"));
        assert!(current.is_some());

        let (out, _) = handle_command(Command::Info, &config, &connector, &mut current).await;
        assert!(joined(&out).contains("Redis Server Info"));

        let (out, _) = handle_command(
            Command::Redis("GET k".to_string()),
            &config,
            &connector,
            &mut current,
        )
        .await;
        assert!(joined(&out).contains("value"));
    }

    #[tokio::test]
    async fn handle_connect_missing_arg_and_unknown_cluster_and_failure() {
        let config = config_with(&["prod"]);
        let mut current = None;

        let (out, _) = handle_command(
            Command::Connect(None),
            &config,
            &ok_connector(),
            &mut current,
        )
        .await;
        assert!(joined(&out).contains("Usage: connect"));

        let (out, _) = handle_command(
            Command::Connect(Some("nope".to_string())),
            &config,
            &ok_connector(),
            &mut current,
        )
        .await;
        assert!(joined(&out).contains("not found"));
        assert!(current.is_none());

        let failing = FakeConnector {
            mode: FakeMode::ConnectError,
        };
        let (out, _) = handle_command(
            Command::Connect(Some("prod".to_string())),
            &config,
            &failing,
            &mut current,
        )
        .await;
        assert!(joined(&out).contains("Failed to connect"));
        assert!(current.is_none());
    }

    #[tokio::test]
    async fn handle_info_and_redis_without_connection() {
        let config = config_with(&["prod"]);
        let connector = ok_connector();
        let mut current = None;

        let (out, _) = handle_command(Command::Info, &config, &connector, &mut current).await;
        assert!(joined(&out).contains("Not connected"));

        let (out, _) = handle_command(
            Command::Redis("GET k".to_string()),
            &config,
            &connector,
            &mut current,
        )
        .await;
        assert!(joined(&out).contains("Unknown command"));
    }

    #[tokio::test]
    async fn handle_quit_disconnects_then_quits() {
        let config = config_with(&["prod"]);
        let connector = ok_connector();
        let mut current = None;

        // Connect first.
        handle_command(
            Command::Connect(Some("prod".to_string())),
            &config,
            &connector,
            &mut current,
        )
        .await;

        // First quit while connected -> disconnect, keep running.
        let (out, flow) = handle_command(Command::Quit, &config, &connector, &mut current).await;
        assert!(joined(&out).contains("Disconnected from prod"));
        assert_eq!(flow, Flow::Continue);
        assert!(current.is_none());

        // Second quit while disconnected -> quit.
        let (out, flow) = handle_command(Command::Quit, &config, &connector, &mut current).await;
        assert!(joined(&out).contains("Goodbye"));
        assert_eq!(flow, Flow::Quit);
    }

    #[tokio::test]
    async fn redis_command_empty_output_is_nil() {
        let mut client = FakeClient {
            fail: false,
            exec_output: String::new(),
        };
        let out = execute_redis_command(&mut client, "GET missing").await;
        assert!(joined(&out).contains("(nil)"));
    }

    #[tokio::test]
    async fn info_and_command_errors_are_reported() {
        let mut client = FakeClient {
            fail: true,
            exec_output: String::new(),
        };
        assert!(joined(&execute_info(&mut client).await).contains("Error getting info"));
        assert!(joined(&execute_redis_command(&mut client, "GET k").await).contains("Error:"));
    }

    #[tokio::test]
    async fn check_health_covers_connect_and_server_errors() {
        let config = config_with(&["a", "b"]);

        let healthy = check_health(&config, &ok_connector()).await;
        assert!(joined(&healthy).contains("Healthy"));

        let connect_err = check_health(
            &config,
            &FakeConnector {
                mode: FakeMode::ConnectError,
            },
        )
        .await;
        assert!(joined(&connect_err).contains("Unhealthy"));

        let server_err = check_health(
            &config,
            &FakeConnector {
                mode: FakeMode::ServerError,
            },
        )
        .await;
        // server_info error still reports Healthy with unknown details.
        assert!(joined(&server_err).contains("Healthy"));

        let empty = check_health(
            &config,
            &FakeConnector {
                mode: FakeMode::EmptyExec,
            },
        )
        .await;
        assert!(joined(&empty).contains("Healthy"));
    }
}
