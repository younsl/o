mod ami_cleanup;
mod config;
mod ec2;
mod error;
mod file_config;
mod forward;
mod session;
mod ssm_connect;
mod tabs;
mod ui;
mod wizard;

use clap::Parser;
use colored::Colorize;

use config::{Args, Command, Config};
use error::Error;
use file_config::FileConfig;
use forward::PortForward;
use session::SessionManager;
use tabs::TabResult;

fn init_logging(config: &Config) {
    let filter = format!("error,ij={}", config.log_level);
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(&filter)),
        )
        .with_target(false)
        .init();
}

#[tokio::main]
async fn main() {
    let args = Args::parse();

    // Handle subcommands
    match args.command {
        Some(Command::Init) => {
            if let Err(e) = wizard::run_wizard() {
                match e {
                    Error::Cancelled => {
                        println!("\n{}", "Configuration cancelled.".yellow());
                    }
                    _ => {
                        eprintln!("{} {}", "Error:".red().bold(), e);
                        std::process::exit(1);
                    }
                }
            }
            return;
        }
        Some(Command::AmiCleanup(ami_args)) => {
            if let Err(e) = ami_cleanup::run(ami_args).await {
                eprintln!("{} {}", "Error:".red().bold(), e);
                std::process::exit(1);
            }
            return;
        }
        None => {}
    }

    // Load file config and build config
    let file_config = FileConfig::load_default().ok().flatten();
    let config = Config::from_args_and_file(args, file_config);
    init_logging(&config);

    // Parse port forward spec early to fail fast
    let port_forward = config
        .forward
        .as_deref()
        .map(PortForward::parse)
        .transpose();
    let port_forward = match port_forward {
        Ok(pf) => pf,
        Err(e) => {
            eprintln!("{} {}", "Error:".red().bold(), e);
            std::process::exit(1);
        }
    };

    // Run tabbed TUI
    match tabs::run_tabbed(config.clone()).await {
        Ok(TabResult::Connect(instance)) => {
            // Print selection info
            println!(
                "{} {} ({})",
                "Selected:".bright_blue(),
                instance.name.bright_cyan().bold(),
                instance.az.bright_blue()
            );

            let session =
                SessionManager::new(config.profile.clone(), config.shell_commands.clone());

            if let Some(ref pf) = port_forward {
                println!(
                    "{} {}",
                    "Port forwarding:".bright_blue(),
                    pf.display_info().bright_yellow().bold(),
                );
                println!(
                    "{} {} ({})",
                    "Via:".bright_blue(),
                    instance.name.bright_cyan(),
                    instance.instance_id.bright_blue(),
                );
                println!("{}", "Press Ctrl+C to stop the tunnel.".bright_black());
                if let Err(e) = session.port_forward(&instance, pf) {
                    eprintln!("{} {}", "Error:".red().bold(), e);
                    std::process::exit(1);
                }
            } else if let Err(e) = session.connect(&instance) {
                eprintln!("{} {}", "Error:".red().bold(), e);
                std::process::exit(1);
            }
        }
        Ok(TabResult::Quit) => {
            println!("\n{}", "Exiting.".yellow());
        }
        Err(e) => {
            eprintln!("{} {}", "Error:".red().bold(), e);
            std::process::exit(1);
        }
    }
}
