//! kuo - Kubernetes Upgrade Operator for EKS clusters.
//!
//! Watches `EKSUpgrade` CRD resources and performs declarative EKS cluster upgrades
//! with sequential control plane upgrades, add-on updates, and managed node group
//! rolling updates.

mod aws;
mod controller;
mod crd;
mod eks;
mod error;
mod k8s;
mod notify;
mod phases;
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
use crd::EKSUpgrade;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("BUILD_COMMIT");
pub const BUILD_DATE: &str = env!("BUILD_DATE");

#[tokio::main]
async fn main() {
    // Initialize logging
    if let Err(e) = init_tracing() {
        eprintln!("Failed to initialize logging: {e}");
        std::process::exit(1);
    }

    info!(
        "Starting kuo v{} (commit: {}, build: {})",
        VERSION, COMMIT, BUILD_DATE
    );

    if let Err(e) = run().await {
        error!("Operator failed: {}", e);
        std::process::exit(1);
    }
}

/// Initialize tracing subscriber with JSON format for production.
fn init_tracing() -> Result<()> {
    use tracing_subscriber::{EnvFilter, fmt};

    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info"))
        .map_err(|e| anyhow::anyhow!("Failed to initialize log filter: {e}"))?;

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

    // Initialize Slack notifier (if webhook URL is configured)
    let slack = std::env::var("SLACK_WEBHOOK_URL")
        .ok()
        .filter(|url| !url.is_empty())
        .map(|url| {
            info!("Slack notifications enabled");
            Arc::new(notify::SlackNotifier::new(url))
        });

    // Set up the controller
    let api: Api<EKSUpgrade> = Api::all(client.clone());

    let ctx = Arc::new(Context {
        kube_client: client.clone(),
        metrics,
        slack,
    });

    // Mark as ready once controller starts
    health_state.set_ready(true);

    info!("Starting EKSUpgrade controller");
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
