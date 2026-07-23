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
use tracing::{error, info, warn};

use controller::Context;
use crd::{EKSUpgrade, EKSUpgradeSpec};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const COMMIT: &str = env!("BUILD_COMMIT");
pub const BUILD_DATE: &str = env!("BUILD_DATE");
pub const RUSTC_VERSION: &str = env!("BUILD_RUSTC_VERSION");
pub const ARCH: &str = env!("BUILD_ARCH");

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
    telemetry::metrics::register_build_info(&mut registry, VERSION, COMMIT, RUSTC_VERSION, ARCH);
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

    // Startup pre-check: for each Karpenter-enabled EKSUpgrade, confirm its
    // cluster's NodeClaims are queryable (connectivity + RBAC), one line each.
    precheck_karpenter_nodeclaims(&api).await;

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

/// Startup pre-check for Karpenter node replacement.
///
/// Lists existing `EKSUpgrade` resources and, for those with
/// `karpenterNodePools.enabled`, verifies their cluster's `NodeClaims` are
/// queryable (target-cluster connectivity plus delete/list RBAC readiness).
/// Emits exactly one log line per associated cluster. Best-effort: failures are
/// logged, never fatal, so a missing target does not block operator startup.
async fn precheck_karpenter_nodeclaims(api: &Api<EKSUpgrade>) {
    let items = match api.list(&kube::api::ListParams::default()).await {
        Ok(list) => list.items,
        Err(e) => {
            warn!("Startup precheck skipped, could not list EKSUpgrade resources, {e}");
            return;
        }
    };

    for cr in items {
        let spec = &cr.spec;
        if !spec
            .karpenter_node_pools
            .as_ref()
            .is_some_and(|k| k.enabled)
        {
            continue;
        }
        match probe_nodeclaims(spec).await {
            Ok((count, true)) => info!(
                "Startup precheck passed for cluster {}, {count} NodeClaims are queryable and delete permission is granted",
                spec.cluster_name
            ),
            Ok((count, false)) => warn!(
                "Startup precheck warning for cluster {}, {count} NodeClaims are queryable but delete permission is missing, Karpenter replacement will fail",
                spec.cluster_name
            ),
            Err(e) => warn!(
                "Startup precheck failed for cluster {}, NodeClaim access probe error {e}",
                spec.cluster_name
            ),
        }
    }
}

/// Build a target-cluster client for `spec` and probe `NodeClaim` access.
///
/// Returns the queryable `NodeClaim` count and whether the caller may delete
/// `NodeClaims`, verifying both the read and delete RBAC Karpenter replacement
/// needs on the spoke cluster.
async fn probe_nodeclaims(spec: &EKSUpgradeSpec) -> Result<(usize, bool)> {
    let aws = aws::client::AwsClients::new(&spec.region, spec.assume_role_arn.as_deref()).await?;
    let eks = eks::client::EksClient::new(aws.eks.clone(), aws.region.clone());
    let cluster = eks
        .describe_cluster(&spec.cluster_name)
        .await?
        .ok_or_else(|| anyhow::anyhow!("cluster not found"))?;
    let kube_client =
        k8s::client::build_kube_client(&cluster, eks.region(), spec.assume_role_arn.as_deref())
            .await?;
    let count = k8s::karpenter::count_nodeclaims(&kube_client).await?;
    let can_delete = k8s::karpenter::can_delete_nodeclaims(&kube_client).await?;
    Ok((count, can_delete))
}
