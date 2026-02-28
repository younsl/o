pub mod health_checker;
pub mod sender;
pub mod types;
pub mod watcher;

use anyhow::Result;
use std::sync::Arc;
use tracing::info;

use crate::config::Config;
use crate::health::HealthServer;
use health_checker::HealthChecker;
use sender::ReportSender;
use watcher::K8sWatcher;

pub async fn run(
    config: Config,
    health_server: HealthServer,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    info!(
        cluster = %config.get_cluster_name(),
        server_url = %config.get_server_url(),
        namespaces = ?config.namespaces,
        health_check_interval_secs = config.health_check_interval_secs,
        "Starting collector mode"
    );

    // Create report sender
    let sender = Arc::new(ReportSender::new(
        config.get_server_url().to_string(),
        config.get_cluster_name().to_string(),
        config.retry_attempts,
        config.retry_delay_secs,
    )?);

    // Create watcher
    let watcher = K8sWatcher::new(
        sender.clone(),
        config.namespaces.clone(),
        config.collect_vulnerability_reports,
        config.collect_sbom_reports,
    )
    .await?;

    // Start health checker task
    let health_checker = HealthChecker::new(
        config.get_server_url().to_string(),
        config.health_check_interval_secs,
    )?;
    let health_shutdown = shutdown.clone();
    tokio::spawn(async move {
        health_checker.run(health_shutdown).await;
    });

    // Mark as ready
    health_server.set_ready(true);
    info!("Collector is ready");

    // Run watcher
    watcher.run(shutdown).await?;

    Ok(())
}
