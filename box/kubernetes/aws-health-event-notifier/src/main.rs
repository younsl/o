mod aws;
mod config;
mod dedup;
mod error;
mod filter;
mod health;
mod interactive;
mod k8s;
mod notify;
mod observability;
mod poller;
mod server;
mod slack;

use anyhow::Context;
use clap::Parser;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

use crate::config::{Cli, Command, RunArgs};

#[derive(clap::Parser)]
struct DefaultRunArgs {
    #[command(flatten)]
    run: RunArgs,
}

const BUILD_COMMIT: &str = env!("VERGEN_GIT_SHA");
const BUILD_DATE: &str = env!("VERGEN_BUILD_DATE");
const RUSTC_VERSION: &str = env!("VERGEN_RUSTC_SEMVER");

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Both `ring` and `aws-lc-rs` end up linked (reqwest/kube vs the AWS SDK),
    // so rustls 0.23 cannot auto-select a process-level provider and panics on
    // first TLS use. Install one explicitly before any client is built. The
    // only error case is "already installed", which is harmless.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let cli = Cli::parse();
    init_tracing(&cli);

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        commit = BUILD_COMMIT,
        built = BUILD_DATE,
        rustc = RUSTC_VERSION,
        "starting aws-health-event-notifier"
    );

    let Cli { slack, command, .. } = cli;
    match command {
        Some(Command::Send(args)) => interactive::run(slack, *args)
            .await
            .context("send subcommand failed"),
        Some(Command::Run(args)) => server::run(slack, *args)
            .await
            .context("run subcommand failed"),
        None => {
            let DefaultRunArgs { run: args } =
                DefaultRunArgs::parse_from(std::iter::once("aws-health-event-notifier"));
            server::run(slack, args)
                .await
                .context("run (default) failed")
        }
    }
}

fn init_tracing(cli: &Cli) {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(cli.logging.log_level.as_str()));

    let registry = tracing_subscriber::registry().with(filter);
    if cli.logging.log_json {
        registry
            .with(fmt::layer().json().flatten_event(true))
            .init();
    } else {
        registry
            .with(fmt::layer().with_writer(std::io::stderr).with_target(false))
            .init();
    }
}
