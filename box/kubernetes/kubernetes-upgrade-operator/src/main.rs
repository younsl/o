//! kuo - Kubernetes Upgrade Operator for EKS clusters.
//!
//! Watches `EKSUpgrade` CRD resources and performs declarative EKS cluster upgrades
//! with sequential control plane upgrades, add-on updates, and managed node group
//! rolling updates.

mod annotate;
mod aws;
mod controller;
mod crd;
mod eks;
mod error;
mod k8s;
mod notify;
mod phases;
mod render;
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
        version = VERSION,
        commit = COMMIT,
        build_date = BUILD_DATE,
        rustc_version = RUSTC_VERSION,
        arch = ARCH,
        "Starting kuo"
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

    // Probe /version so the API server reachability, its version and the round
    // trip latency land in the startup log as queryable fields.
    let started = std::time::Instant::now();
    match client.apiserver_version().await {
        Ok(v) => info!(
            // Minor release, matching the spec.targetVersion format so the two
            // compare directly. The build string keeps the API server's own name
            // for it, gitVersion.
            k8s_version = %format!("{}.{}", v.major, v.minor),
            k8s_git_version = %v.git_version,
            latency_ms = started.elapsed().as_millis(),
            "Connected to Kubernetes API server"
        ),
        Err(e) => warn!(
            latency_ms = started.elapsed().as_millis(),
            "Connected to Kubernetes API server but the version lookup failed, {e}"
        ),
    }

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

    // Initialize the Grafana annotator (if annotating is enabled). A
    // half-configured annotator is fatal here rather than silently dropping
    // every marker at runtime; a disabled one is simply absent.
    let grafana = if let Some(config) = annotate::Config::from_env()? {
        let annotator = Arc::new(annotate::Annotator::new(config)?);
        annotator.preflight().await;
        Some(annotator)
    } else {
        info!("Grafana annotations disabled");
        None
    };

    // Set up the controller
    let api: Api<EKSUpgrade> = Api::all(client.clone());

    // Startup pre-check: for each Karpenter-enabled EKSUpgrade, confirm its
    // cluster's NodeClaims are queryable (connectivity + RBAC), one line each.
    precheck_karpenter_nodeclaims(&api, &client).await;

    let ctx = Arc::new(Context {
        kube_client: client.clone(),
        metrics,
        slack,
        grafana,
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
async fn precheck_karpenter_nodeclaims(api: &Api<EKSUpgrade>, in_cluster: &kube::Client) {
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
        match probe_nodeclaims(spec, in_cluster).await {
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
///
/// Resolves the target client the same way the reconcile path does, so a spec
/// without `assumeRoleArn` probes through the in-cluster `ServiceAccount` instead
/// of an STS-signed EKS token the cluster has no access entry for.
async fn probe_nodeclaims(
    spec: &EKSUpgradeSpec,
    in_cluster: &kube::Client,
) -> Result<(usize, bool)> {
    let aws = aws::client::AwsClients::new(&spec.region, spec.assume_role_arn.as_deref()).await?;
    let eks = eks::client::EksClient::new(aws.eks.clone(), aws.region.clone());
    let kube_client = k8s::client::resolve_client(
        in_cluster,
        &eks,
        &spec.cluster_name,
        spec.assume_role_arn.as_deref(),
    )
    .await?;
    let count = k8s::karpenter::count_nodeclaims(&kube_client).await?;
    let can_delete = k8s::karpenter::can_delete_nodeclaims(&kube_client).await?;
    Ok((count, can_delete))
}
