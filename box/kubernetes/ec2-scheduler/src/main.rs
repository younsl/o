//! ec2-scheduler - Kubernetes controller for scheduling EC2 instance start/stop.
//!
//! Watches `EC2Schedule` CRD resources and performs declarative EC2 instance
//! start/stop actions based on cron schedules with IANA timezone support.

mod aws;
mod controller;
mod crd;
mod error;
mod scheduler;
mod status;
mod telemetry;

use std::sync::Arc;

use anyhow::Result;
use futures::StreamExt;
use kube::Api;
use kube::runtime::Controller;
use kube::runtime::watcher::Config;
use tracing::{error, info};

use controller::Context;
use crd::EC2Schedule;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("BUILD_COMMIT");
pub const BUILD_DATE: &str = env!("BUILD_DATE");
pub const RUSTC: &str = env!("BUILD_RUSTC");

#[tokio::main]
async fn main() {
    // Handle --version flag before initializing logging
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("ec2-scheduler v{VERSION} (commit: {COMMIT}, build: {BUILD_DATE}, {RUSTC})");
        return;
    }

    // Parse --log-level flag (default: info)
    let log_level = parse_log_level();

    // Initialize logging
    if let Err(e) = init_tracing(&log_level) {
        eprintln!("Failed to initialize logging: {e}");
        std::process::exit(1);
    }

    info!(
        "Starting ec2-scheduler v{} (commit: {}, build: {})",
        VERSION, COMMIT, BUILD_DATE
    );

    if let Err(e) = run().await {
        error!("Operator failed: {}", e);
        std::process::exit(1);
    }
}

/// Parse `--log-level` flag from CLI args. Falls back to `RUST_LOG` env, then `info`.
fn parse_log_level() -> String {
    let mut args = std::env::args();
    while let Some(arg) = args.next() {
        if arg == "--log-level" {
            if let Some(level) = args.next() {
                return level;
            }
        } else if let Some(level) = arg.strip_prefix("--log-level=") {
            return level.to_string();
        }
    }
    std::env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string())
}

/// Initialize tracing subscriber with JSON format for production.
fn init_tracing(level: &str) -> Result<()> {
    use tracing_subscriber::{EnvFilter, fmt};

    let filter = EnvFilter::try_new(level)
        .map_err(|e| anyhow::anyhow!("Invalid log level '{level}': {e}"))?;

    fmt()
        .with_env_filter(filter)
        .json()
        .with_target(true)
        .init();

    Ok(())
}

/// Main operator loop.
async fn run() -> Result<()> {
    // Build in-cluster Kubernetes client
    let client = kube::Client::try_default().await?;
    info!("Connected to Kubernetes API server");

    // Initialize Prometheus metrics
    let mut registry = prometheus_client::registry::Registry::default();
    let metrics = Arc::new(telemetry::metrics::Metrics::new(&mut registry));
    let registry = Arc::new(registry);

    // Start health server (port 8080)
    let health_state = telemetry::health::HealthState::new();
    let health_state_clone = health_state.clone();
    tokio::spawn(async move {
        if let Err(e) = telemetry::health::serve(8080, health_state_clone).await {
            error!("Health server failed: {}", e);
        }
    });

    // Start metrics server (port 8081)
    let registry_clone = registry.clone();
    tokio::spawn(async move {
        if let Err(e) = telemetry::metrics::serve(8081, registry_clone).await {
            error!("Metrics server failed: {}", e);
        }
    });

    // Set up the controller
    let api: Api<EC2Schedule> = Api::all(client.clone());

    let ctx = Arc::new(Context {
        kube_client: client.clone(),
        metrics,
    });

    // Mark as ready once controller starts
    health_state.set_ready(true);

    info!("Starting EC2Schedule controller");
    Controller::new(api, Config::default())
        .run(controller::reconcile, controller::error_policy, ctx)
        .for_each(|res| async move {
            match res {
                Ok(o) => info!("Reconciled: {:?}", o),
                Err(e) => error!("Reconcile failed: {:?}", e),
            }
        })
        .await;

    Ok(())
}
