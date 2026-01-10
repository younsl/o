use anyhow::Result;
use tracing::{error, info};

use trivy_collector::config::{Command, Config, Mode};
use trivy_collector::health::HealthServer;
use trivy_collector::{collector, logging, server};

#[tokio::main]
async fn main() -> Result<()> {
    let config = Config::from_args();

    // Handle version subcommand
    if let Some(Command::Version) = &config.command {
        println!(
            "trivy-collector {}, commit: {}, build_date: {}",
            env!("CARGO_PKG_VERSION"),
            env!("VERGEN_GIT_SHA"),
            env!("VERGEN_BUILD_TIMESTAMP"),
        );
        return Ok(());
    }

    // Initialize logging
    logging::init(&config.log_format, &config.log_level);

    info!(
        version = env!("CARGO_PKG_VERSION"),
        commit = env!("VERGEN_GIT_SHA"),
        build_date = env!("VERGEN_BUILD_TIMESTAMP"),
        mode = %config.mode,
        cluster = %config.cluster_name,
        "trivy-collector starting"
    );

    // Validate configuration
    if let Err(e) = config.validate() {
        error!(error = %e, "Configuration validation failed");
        std::process::exit(1);
    }

    // Start health check server
    let health_port = config.health_port;
    let health_server = HealthServer::new();
    let health_server_clone = health_server.clone();

    let (health_ready_tx, health_ready_rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        if let Err(e) = health_server_clone
            .serve(health_port, health_ready_tx)
            .await
        {
            error!(error = %e, "Health check server failed");
        }
    });

    // Wait for health server to be ready
    health_ready_rx.await.ok();
    info!(port = health_port, "Health check server started");

    // Create shutdown channel
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);

    // Run based on mode
    let result = tokio::select! {
        result = run_mode(config, health_server, shutdown_rx) => result,
        _ = tokio::signal::ctrl_c() => {
            info!("Received shutdown signal");
            let _ = shutdown_tx.send(true);
            Ok(())
        }
    };

    if let Err(e) = result {
        error!(error = %e, "Application error");
        std::process::exit(1);
    }

    info!("Shutdown complete");
    Ok(())
}

async fn run_mode(
    config: Config,
    health_server: HealthServer,
    shutdown_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    match config.mode {
        Mode::Collector => {
            info!(
                cluster = %config.get_cluster_name(),
                server_url = %config.get_server_url(),
                "Running in collector mode"
            );
            collector::run(config, health_server, shutdown_rx).await
        }
        Mode::Server => {
            info!(
                port = config.server_port,
                storage_path = %config.storage_path,
                cluster = %config.cluster_name,
                watch_local = config.watch_local,
                "Running in server mode"
            );
            server::run(config, health_server, shutdown_rx).await
        }
    }
}
