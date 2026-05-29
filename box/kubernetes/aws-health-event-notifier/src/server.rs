use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::{Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use tokio::signal;
use tokio::sync::watch;
use tokio::task::JoinSet;

use crate::aws::account::AccountIdentity;
use crate::aws::health::HealthClient;
use crate::config::{RunArgs, SlackArgs};
use crate::filter::{EventFilter, validate_filters};
use crate::k8s::client::{K8sEventClient, PodIdentity};
use crate::notify::{Notifier, SlackOpts};
use crate::observability::metrics::Metrics;
use crate::poller::{Poller, PollerCfg};
use crate::slack::client::SlackClient;

pub async fn run(slack_cfg: SlackArgs, run_cfg: RunArgs) -> anyhow::Result<()> {
    let metrics = Metrics::new();

    let slack = SlackClient::new(
        slack_cfg.slack_webhook_url.clone(),
        Duration::from_secs(slack_cfg.slack_timeout_secs),
    )
    .context("failed to construct Slack client")?;

    let filter = EventFilter::new(
        &run_cfg.allow_categories,
        &run_cfg.deny_categories,
        &run_cfg.allow_services,
        &run_cfg.deny_services,
    );
    tracing::info!(
        allow_categories = ?run_cfg.allow_categories,
        deny_categories = ?run_cfg.deny_categories,
        allow_services = ?run_cfg.allow_services,
        deny_services = ?run_cfg.deny_services,
        "filter configured"
    );

    let aws = HealthClient::from_env(run_cfg.event_locale.clone())
        .await
        .context("failed to construct AWS Health client")?;

    let admin = Router::new()
        .route("/healthz", get(|| async { StatusCode::OK }))
        .route("/readyz", get(|| async { StatusCode::OK }))
        .route("/metrics", get(metrics_handler))
        .with_state(metrics.clone());

    let admin_listener = tokio::net::TcpListener::bind(&run_cfg.admin_addr)
        .await
        .with_context(|| format!("bind admin addr {}", run_cfg.admin_addr))?;
    tracing::info!(addr = %run_cfg.admin_addr, "admin server listening");

    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Bind admin listener before validation so liveness probes succeed
    // while the (potentially slow) AWS Health catalog fetch is running.
    let mut tasks = JoinSet::new();
    let admin_rx = shutdown_rx.clone();
    tasks.spawn(async move {
        axum::serve(admin_listener, admin)
            .with_graceful_shutdown(async move {
                let mut rx = admin_rx;
                let _ = rx.changed().await;
            })
            .await
            .map_err(|e| anyhow::anyhow!("admin server: {e}"))
    });

    validate_against_catalog(&aws, &run_cfg).await?;

    let account = AccountIdentity::resolve().await;
    tracing::info!(
        account_id = account.account_id.as_deref().unwrap_or("?"),
        alias = account.alias.as_deref().unwrap_or("?"),
        "resolved AWS account identity"
    );

    let k8s = build_k8s_client(&run_cfg).await;
    let notifier = Notifier::new(
        slack,
        SlackOpts {
            channel: slack_cfg.slack_channel.clone(),
            username: slack_cfg.slack_username.clone(),
            icon_emoji: slack_cfg.slack_icon_emoji.clone(),
            account_label: account.display(),
        },
        k8s,
        metrics.clone(),
    );

    let poller = Arc::new(Poller::new(
        aws,
        notifier,
        filter,
        metrics,
        PollerCfg {
            interval: Duration::from_secs(run_cfg.poll_interval_secs),
            initial_lookback: Duration::from_secs(run_cfg.initial_lookback_secs),
            cold_start_suppress: run_cfg.cold_start_suppress,
            services: run_cfg.allow_services.clone(),
            categories: run_cfg.allow_categories.clone(),
            reminder_offsets_hours: run_cfg.reminder_offsets_hours.clone(),
        },
    ));

    let poller_rx = shutdown_rx.clone();
    let poller_clone = poller.clone();
    tasks.spawn(async move { poller_clone.run(poller_rx).await });

    tasks.spawn(async move {
        wait_for_signal().await;
        let _ = shutdown_tx.send(true);
        Ok(())
    });

    while let Some(res) = tasks.join_next().await {
        res.context("task panicked")??;
    }
    Ok(())
}

async fn validate_against_catalog(aws: &HealthClient, run_cfg: &RunArgs) -> anyhow::Result<()> {
    // Query only the service codes the user actually configured, instead of
    // paginating the full AWS Health catalog (thousands of event types).
    let mut to_query: Vec<String> = run_cfg
        .allow_services
        .iter()
        .chain(run_cfg.deny_services.iter())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect();
    to_query.sort();
    to_query.dedup();

    let started = std::time::Instant::now();
    let service_catalog = aws
        .lookup_service_codes(&to_query)
        .await
        .context("failed to look up AWS Health service codes for filter validation")?;
    let elapsed_ms = started.elapsed().as_millis();
    let report = validate_filters(
        &run_cfg.allow_categories,
        &run_cfg.deny_categories,
        &run_cfg.allow_services,
        &run_cfg.deny_services,
        &service_catalog,
    );

    tracing::info!(
        elapsed_ms,
        queried_count = to_query.len(),
        catalog_size = service_catalog.len(),
        allow_services_valid_count = report.allow_services.valid.len(),
        allow_services_valid = ?report.allow_services.valid,
        allow_services_invalid_count = report.allow_services.invalid.len(),
        allow_services_invalid = ?report.allow_services.invalid,
        deny_services_valid_count = report.deny_services.valid.len(),
        deny_services_valid = ?report.deny_services.valid,
        deny_services_invalid_count = report.deny_services.invalid.len(),
        deny_services_invalid = ?report.deny_services.invalid,
        "filter service validation result"
    );

    if !report.is_ok() {
        let invalid = report.all_invalid();
        tracing::error!(
            invalid_count = invalid.len(),
            invalid = ?invalid,
            "filter validation failed: unknown service codes detected, please check service codes again; aborting startup"
        );
        anyhow::bail!(
            "filter validation failed: {} unknown value(s): {}; please check service codes again",
            invalid.len(),
            invalid.join(", ")
        );
    }
    tracing::info!("filter validation passed");
    Ok(())
}

/// Construct the K8s Event client. Activates automatically when the pod
/// identity is present (Downward API). Non-fatal: any failure logs a clear
/// reason and returns `None` so the poller simply skips emission — Slack
/// (the primary sink) must never be taken down by a K8s problem.
async fn build_k8s_client(run_cfg: &RunArgs) -> Option<K8sEventClient> {
    let (Some(name), Some(namespace)) = (
        run_cfg.k8s.pod_name.clone(),
        run_cfg.k8s.pod_namespace.clone(),
    ) else {
        tracing::info!(
            "Kubernetes Event emission DISABLED: POD_NAME/POD_NAMESPACE not set (not running in-cluster)."
        );
        return None;
    };
    let client = match K8sEventClient::connect(PodIdentity {
        name: name.clone(),
        namespace: namespace.clone(),
        uid: run_cfg.k8s.pod_uid.clone(),
    })
    .await
    {
        Ok(client) => client,
        Err(e) => {
            tracing::warn!(
                error = format!("{e:#}"),
                "Kubernetes Event emission DISABLED: could not initialize the in-cluster Kubernetes client."
            );
            return None;
        }
    };

    // Preflight the RBAC so a missing Role/RoleBinding is reported now, not
    // silently on every poll cycle.
    match client.can_create_events().await {
        Ok(true) => {
            tracing::info!(
                pod = %name,
                namespace = %namespace,
                "Kubernetes Event emission ENABLED: Kubernetes Events will be recorded on this pod."
            );
            Some(client)
        }
        Ok(false) => {
            tracing::warn!(
                namespace = %namespace,
                "Kubernetes Event emission DISABLED: ServiceAccount lacks RBAC to create Kubernetes Events (need verb=create on events.k8s.io/events in this namespace). Apply the chart RBAC (rbac.create=true)."
            );
            None
        }
        Err(e) => {
            tracing::warn!(
                error = format!("{e:#}"),
                "Kubernetes Event emission DISABLED: could not verify RBAC permissions (SelfSubjectAccessReview failed)."
            );
            None
        }
    }
}

async fn metrics_handler(State(metrics): State<Metrics>) -> impl IntoResponse {
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        metrics.render(),
    )
}

async fn wait_for_signal() {
    let ctrl_c = async {
        let _ = signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = signal::unix::signal(signal::unix::SignalKind::terminate()) {
            sig.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
