mod config;
mod ec2;
mod error;
mod forward;
mod session;
mod ui;

use clap::Parser;
use colored::Colorize;
use tracing::debug;

use config::{Args, Config};
use ec2::Scanner;
use error::Error;
use forward::PortForward;
use session::SessionManager;
use ui::Selector;

/// Application entry point.
struct App {
    config: Config,
}

impl App {
    fn new(config: Config) -> Self {
        Self { config }
    }

    async fn run(&self) -> error::Result<()> {
        self.init_logging();

        if let Some(ref profile) = self.config.profile {
            debug!("Using AWS profile: {}", profile);
        }

        // Parse port forward spec early to fail fast
        let port_forward = self
            .config
            .forward
            .as_deref()
            .map(PortForward::parse)
            .transpose()?;

        // Scan for instances
        let scanner = Scanner::new(self.config.clone());
        let instances = scanner.fetch_instances().await?;

        self.print_summary(&instances);

        // Select instance
        let selector = Selector::new(&instances, &self.config);
        let selected = selector.select()?;

        self.print_selection(selected);

        let session = SessionManager::new(self.config.profile.clone());

        if let Some(ref pf) = port_forward {
            self.print_forward_info(selected, pf);
            session.port_forward(selected, pf)?;
        } else {
            session.connect(selected)?;
        }

        Ok(())
    }

    fn init_logging(&self) {
        let filter = format!("error,ij={}", self.config.log_level);
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new(&filter)),
            )
            .with_target(false)
            .init();
    }

    fn print_summary(&self, instances: &[ec2::Instance]) {
        println!(
            "{} {} instances (profile: {})",
            "Found".bright_blue().bold(),
            instances.len().to_string().bright_yellow().bold(),
            self.config.profile_display().bright_cyan()
        );
    }

    fn print_selection(&self, instance: &ec2::Instance) {
        println!(
            "{} {} ({})",
            "Selected:".bright_blue(),
            instance.name.bright_cyan().bold(),
            instance.region.bright_blue()
        );
    }

    fn print_forward_info(&self, instance: &ec2::Instance, pf: &PortForward) {
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
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    let config = Config::from_args(args);
    let app = App::new(config);

    if let Err(e) = app.run().await {
        match e {
            Error::NoInstances => {
                println!("{}", "\nNo instances found.".yellow());
            }
            Error::Cancelled => {
                println!("\n{}", "No instance selected. Exiting.".yellow());
            }
            _ => {
                eprintln!("{} {}", "Error:".red().bold(), e);
                std::process::exit(1);
            }
        }
    }
}
