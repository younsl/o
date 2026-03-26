use anyhow::{Context, Result};
use futures::StreamExt;
use kube::{
    Client,
    api::Api,
    runtime::watcher::{Config as WatcherConfig, Event, watcher},
};
use std::sync::Arc;
use tracing::{debug, error, info, warn};

use crate::collector::sender::ReportSender;
use crate::collector::types::{ReportEventType, SbomReport, VulnerabilityReport};
use crate::metrics::{Metrics, WatcherLabels};

pub struct K8sWatcher {
    client: Client,
    sender: Arc<ReportSender>,
    namespaces: Vec<String>,
    collect_vuln: bool,
    collect_sbom: bool,
    metrics: Arc<Metrics>,
}

impl K8sWatcher {
    pub async fn new(
        sender: Arc<ReportSender>,
        namespaces: Vec<String>,
        collect_vuln: bool,
        collect_sbom: bool,
        metrics: Arc<Metrics>,
    ) -> Result<Self> {
        let client = Client::try_default()
            .await
            .context("Failed to create Kubernetes client")?;

        Ok(Self {
            client,
            sender,
            namespaces,
            collect_vuln,
            collect_sbom,
            metrics,
        })
    }

    pub async fn run(&self, mut shutdown: tokio::sync::watch::Receiver<bool>) -> Result<()> {
        info!(
            cluster = %self.sender.cluster_name(),
            namespaces = ?self.namespaces,
            collect_vuln = self.collect_vuln,
            collect_sbom = self.collect_sbom,
            "Starting Kubernetes watcher"
        );

        let mut handles = Vec::new();

        if self.collect_vuln {
            let client = self.client.clone();
            let sender = self.sender.clone();
            let namespaces = self.namespaces.clone();
            let shutdown_rx = shutdown.clone();
            let metrics = self.metrics.clone();

            let handle = tokio::spawn(async move {
                watch_vulnerability_reports(client, sender, namespaces, shutdown_rx, metrics).await
            });
            handles.push(handle);
        }

        if self.collect_sbom {
            let client = self.client.clone();
            let sender = self.sender.clone();
            let namespaces = self.namespaces.clone();
            let shutdown_rx = shutdown.clone();
            let metrics = self.metrics.clone();

            let handle = tokio::spawn(async move {
                watch_sbom_reports(client, sender, namespaces, shutdown_rx, metrics).await
            });
            handles.push(handle);
        }

        // Wait for shutdown signal or any watcher to complete
        tokio::select! {
            _ = shutdown.changed() => {
                info!("Shutdown signal received, stopping watchers");
            }
            _ = async {
                for handle in handles {
                    if let Err(e) = handle.await {
                        error!(error = %e, "Watcher task failed");
                    }
                }
            } => {
                warn!("All watchers completed unexpectedly");
            }
        }

        Ok(())
    }
}

fn record_watcher_event(metrics: &Metrics, report_type: &str, event_type: &str) {
    if let Some(ref counter) = metrics.watcher_events_total {
        counter
            .get_or_create(&WatcherLabels {
                report_type: report_type.to_string(),
                event_type: event_type.to_string(),
            })
            .inc();
    }
}

async fn watch_vulnerability_reports(
    client: Client,
    sender: Arc<ReportSender>,
    namespaces: Vec<String>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    metrics: Arc<Metrics>,
) -> Result<()> {
    let api: Api<VulnerabilityReport> = if namespaces.is_empty() {
        Api::all(client)
    } else {
        // For simplicity, watch all namespaces and filter
        // In production, you might want to create separate watchers per namespace
        Api::all(client)
    };

    // Use smaller page size for memory optimization (default is 500)
    let watcher_config = WatcherConfig::default().page_size(50);
    let mut stream = watcher(api, watcher_config).boxed();

    info!("VulnerabilityReport watcher started");

    let mut sync_count: u64 = 0;
    let mut is_initial_sync = false;
    let mut sync_start_time: Option<std::time::Instant> = None;

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                info!("VulnerabilityReport watcher shutting down");
                break;
            }
            event = stream.next() => {
                match event {
                    Some(Ok(ev)) => {
                        if let Err(e) = handle_vuln_event(&sender, ev, &namespaces, &mut sync_count, &mut is_initial_sync, &mut sync_start_time, &metrics).await {
                            error!(error = %e, "Failed to handle VulnerabilityReport event");
                        }
                    }
                    Some(Err(e)) => {
                        error!(error = %e, "VulnerabilityReport watcher error");
                    }
                    None => {
                        warn!("VulnerabilityReport watcher stream ended");
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

async fn watch_sbom_reports(
    client: Client,
    sender: Arc<ReportSender>,
    namespaces: Vec<String>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    metrics: Arc<Metrics>,
) -> Result<()> {
    // Watch all namespaces and filter later
    let api: Api<SbomReport> = Api::all(client);

    // Use smaller page size for memory optimization (default is 500)
    let watcher_config = WatcherConfig::default().page_size(50);
    let mut stream = watcher(api, watcher_config).boxed();

    info!("SbomReport watcher started");

    let mut sync_count: u64 = 0;
    let mut is_initial_sync = false;
    let mut sync_start_time: Option<std::time::Instant> = None;

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                info!("SbomReport watcher shutting down");
                break;
            }
            event = stream.next() => {
                match event {
                    Some(Ok(ev)) => {
                        if let Err(e) = handle_sbom_event(&sender, ev, &namespaces, &mut sync_count, &mut is_initial_sync, &mut sync_start_time, &metrics).await {
                            error!(error = %e, "Failed to handle SbomReport event");
                        }
                    }
                    Some(Err(e)) => {
                        error!(error = %e, "SbomReport watcher error");
                    }
                    None => {
                        warn!("SbomReport watcher stream ended");
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

async fn handle_vuln_event(
    sender: &ReportSender,
    event: Event<VulnerabilityReport>,
    namespaces: &[String],
    sync_count: &mut u64,
    is_initial_sync: &mut bool,
    sync_start_time: &mut Option<std::time::Instant>,
    metrics: &Metrics,
) -> Result<()> {
    match event {
        Event::Apply(report) => {
            record_watcher_event(metrics, "vulnerabilityreport", "apply");

            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            // Filter by namespace if specified
            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data_json = serde_json::to_string(&report)?;
            // Apply after initial sync - log at info level
            info!(
                namespace = %namespace,
                name = %name,
                critical = report.report.summary.critical_count,
                high = report.report.summary.high_count,
                "VulnerabilityReport updated"
            );

            sender
                .send_report(
                    "vulnerabilityreport",
                    namespace,
                    name,
                    data_json,
                    ReportEventType::Apply,
                )
                .await?;
        }
        Event::InitApply(report) => {
            record_watcher_event(metrics, "vulnerabilityreport", "init_apply");

            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            // Filter by namespace if specified
            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data_json = serde_json::to_string(&report)?;
            // Initial sync - log at debug level
            debug!(
                namespace = %namespace,
                name = %name,
                critical = report.report.summary.critical_count,
                high = report.report.summary.high_count,
                "Syncing VulnerabilityReport"
            );

            sender
                .send_report(
                    "vulnerabilityreport",
                    namespace,
                    name,
                    data_json,
                    ReportEventType::Apply,
                )
                .await?;

            *sync_count += 1;
        }
        Event::Delete(report) => {
            record_watcher_event(metrics, "vulnerabilityreport", "delete");

            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                return Ok(());
            }

            info!(
                namespace = %namespace,
                name = %name,
                "VulnerabilityReport deleted"
            );

            sender
                .send_report(
                    "vulnerabilityreport",
                    namespace,
                    name,
                    "{}".to_string(),
                    ReportEventType::Delete,
                )
                .await?;
        }
        Event::Init => {
            record_watcher_event(metrics, "vulnerabilityreport", "init");
            *is_initial_sync = true;
            *sync_count = 0;
            *sync_start_time = Some(std::time::Instant::now());
            debug!("VulnerabilityReport initial sync started");
        }
        Event::InitDone => {
            record_watcher_event(metrics, "vulnerabilityreport", "init_done");
            *is_initial_sync = false;
            let elapsed_secs = sync_start_time
                .map(|t| t.elapsed().as_secs_f64())
                .unwrap_or(0.0);
            info!(
                reports_synced = *sync_count,
                elapsed_secs = format!("{:.2}", elapsed_secs),
                "VulnerabilityReport initial sync completed"
            );
        }
    }

    Ok(())
}

async fn handle_sbom_event(
    sender: &ReportSender,
    event: Event<SbomReport>,
    namespaces: &[String],
    sync_count: &mut u64,
    is_initial_sync: &mut bool,
    sync_start_time: &mut Option<std::time::Instant>,
    metrics: &Metrics,
) -> Result<()> {
    match event {
        Event::Apply(report) => {
            record_watcher_event(metrics, "sbomreport", "apply");

            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data_json = serde_json::to_string(&report)?;
            // Apply after initial sync - log at info level
            info!(
                namespace = %namespace,
                name = %name,
                components = report.report.summary.components_count,
                "SbomReport updated"
            );

            sender
                .send_report(
                    "sbomreport",
                    namespace,
                    name,
                    data_json,
                    ReportEventType::Apply,
                )
                .await?;
        }
        Event::InitApply(report) => {
            record_watcher_event(metrics, "sbomreport", "init_apply");

            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data_json = serde_json::to_string(&report)?;
            // Initial sync - log at debug level
            debug!(
                namespace = %namespace,
                name = %name,
                components = report.report.summary.components_count,
                "Syncing SbomReport"
            );

            sender
                .send_report(
                    "sbomreport",
                    namespace,
                    name,
                    data_json,
                    ReportEventType::Apply,
                )
                .await?;

            *sync_count += 1;
        }
        Event::Delete(report) => {
            record_watcher_event(metrics, "sbomreport", "delete");

            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                return Ok(());
            }

            info!(
                namespace = %namespace,
                name = %name,
                "SbomReport deleted"
            );

            sender
                .send_report(
                    "sbomreport",
                    namespace,
                    name,
                    "{}".to_string(),
                    ReportEventType::Delete,
                )
                .await?;
        }
        Event::Init => {
            record_watcher_event(metrics, "sbomreport", "init");
            *is_initial_sync = true;
            *sync_count = 0;
            *sync_start_time = Some(std::time::Instant::now());
            debug!("SbomReport initial sync started");
        }
        Event::InitDone => {
            record_watcher_event(metrics, "sbomreport", "init_done");
            *is_initial_sync = false;
            let elapsed_secs = sync_start_time
                .map(|t| t.elapsed().as_secs_f64())
                .unwrap_or(0.0);
            info!(
                reports_synced = *sync_count,
                elapsed_secs = format!("{:.2}", elapsed_secs),
                "SbomReport initial sync completed"
            );
        }
    }

    Ok(())
}
