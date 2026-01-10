use anyhow::{Context, Result};
use futures::StreamExt;
use kube::{
    api::Api,
    runtime::watcher::{watcher, Config as WatcherConfig, Event},
    Client,
};
use std::sync::Arc;
use tracing::{debug, error, info, warn};

use crate::collector::sender::ReportSender;
use crate::collector::types::{ReportEventType, SbomReport, VulnerabilityReport};

pub struct K8sWatcher {
    client: Client,
    sender: Arc<ReportSender>,
    namespaces: Vec<String>,
    collect_vuln: bool,
    collect_sbom: bool,
}

impl K8sWatcher {
    pub async fn new(
        sender: Arc<ReportSender>,
        namespaces: Vec<String>,
        collect_vuln: bool,
        collect_sbom: bool,
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

            let handle = tokio::spawn(async move {
                watch_vulnerability_reports(client, sender, namespaces, shutdown_rx).await
            });
            handles.push(handle);
        }

        if self.collect_sbom {
            let client = self.client.clone();
            let sender = self.sender.clone();
            let namespaces = self.namespaces.clone();
            let shutdown_rx = shutdown.clone();

            let handle = tokio::spawn(async move {
                watch_sbom_reports(client, sender, namespaces, shutdown_rx).await
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

async fn watch_vulnerability_reports(
    client: Client,
    sender: Arc<ReportSender>,
    namespaces: Vec<String>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let api: Api<VulnerabilityReport> = if namespaces.is_empty() {
        Api::all(client)
    } else {
        // For simplicity, watch all namespaces and filter
        // In production, you might want to create separate watchers per namespace
        Api::all(client)
    };

    let watcher_config = WatcherConfig::default();
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
                        if let Err(e) = handle_vuln_event(&sender, ev, &namespaces, &mut sync_count, &mut is_initial_sync, &mut sync_start_time).await {
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
) -> Result<()> {
    // Watch all namespaces and filter later
    let api: Api<SbomReport> = Api::all(client);

    let watcher_config = WatcherConfig::default();
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
                        if let Err(e) = handle_sbom_event(&sender, ev, &namespaces, &mut sync_count, &mut is_initial_sync, &mut sync_start_time).await {
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
) -> Result<()> {
    match event {
        Event::Apply(report) => {
            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            // Filter by namespace if specified
            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data = serde_json::to_value(&report)?;
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
                    data,
                    ReportEventType::Apply,
                )
                .await?;
        }
        Event::InitApply(report) => {
            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            // Filter by namespace if specified
            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data = serde_json::to_value(&report)?;
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
                    data,
                    ReportEventType::Apply,
                )
                .await?;

            *sync_count += 1;
        }
        Event::Delete(report) => {
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
                    serde_json::json!({}),
                    ReportEventType::Delete,
                )
                .await?;
        }
        Event::Init => {
            *is_initial_sync = true;
            *sync_count = 0;
            *sync_start_time = Some(std::time::Instant::now());
            debug!("VulnerabilityReport initial sync started");
        }
        Event::InitDone => {
            *is_initial_sync = false;
            let elapsed_ms = sync_start_time
                .map(|t| t.elapsed().as_millis())
                .unwrap_or(0);
            info!(
                reports_synced = *sync_count,
                elapsed_ms = elapsed_ms,
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
) -> Result<()> {
    match event {
        Event::Apply(report) => {
            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data = serde_json::to_value(&report)?;
            // Apply after initial sync - log at info level
            info!(
                namespace = %namespace,
                name = %name,
                components = report.report.summary.components_count,
                "SbomReport updated"
            );

            sender
                .send_report("sbomreport", namespace, name, data, ReportEventType::Apply)
                .await?;
        }
        Event::InitApply(report) => {
            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data = serde_json::to_value(&report)?;
            // Initial sync - log at debug level
            debug!(
                namespace = %namespace,
                name = %name,
                components = report.report.summary.components_count,
                "Syncing SbomReport"
            );

            sender
                .send_report("sbomreport", namespace, name, data, ReportEventType::Apply)
                .await?;

            *sync_count += 1;
        }
        Event::Delete(report) => {
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
                    serde_json::json!({}),
                    ReportEventType::Delete,
                )
                .await?;
        }
        Event::Init => {
            *is_initial_sync = true;
            *sync_count = 0;
            *sync_start_time = Some(std::time::Instant::now());
            debug!("SbomReport initial sync started");
        }
        Event::InitDone => {
            *is_initial_sync = false;
            let elapsed_ms = sync_start_time
                .map(|t| t.elapsed().as_millis())
                .unwrap_or(0);
            info!(
                reports_synced = *sync_count,
                elapsed_ms = elapsed_ms,
                "SbomReport initial sync completed"
            );
        }
    }

    Ok(())
}
