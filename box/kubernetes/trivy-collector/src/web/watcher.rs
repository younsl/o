//! Local Kubernetes watcher for Trivy reports

use anyhow::{Context, Result};
use futures::StreamExt;
use kube::{
    Client,
    api::Api,
    runtime::watcher::{Config as WatcherConfig, Event, watcher},
};
use std::sync::Arc;
use tracing::{debug, error, info, warn};

use crate::collector::types::{ReportPayload, SbomReport, VulnerabilityReport};
use crate::storage::Database;

use super::state::WatcherStatus;

pub struct LocalWatcher {
    client: Client,
    db: Arc<Database>,
    cluster_name: String,
    namespaces: Vec<String>,
    watcher_status: Arc<WatcherStatus>,
}

impl LocalWatcher {
    pub async fn new(
        db: Arc<Database>,
        cluster_name: String,
        namespaces: Vec<String>,
        watcher_status: Arc<WatcherStatus>,
    ) -> Result<Self> {
        let client = Client::try_default()
            .await
            .context("Failed to create Kubernetes client")?;

        Ok(Self {
            client,
            db,
            cluster_name,
            namespaces,
            watcher_status,
        })
    }

    pub async fn run(&self, mut shutdown: tokio::sync::watch::Receiver<bool>) -> Result<()> {
        info!(
            cluster = %self.cluster_name,
            "Starting local Kubernetes watcher"
        );

        let client_vuln = self.client.clone();
        let client_sbom = self.client.clone();
        let db_vuln = self.db.clone();
        let db_sbom = self.db.clone();
        let cluster_vuln = self.cluster_name.clone();
        let cluster_sbom = self.cluster_name.clone();
        let namespaces_vuln = self.namespaces.clone();
        let namespaces_sbom = self.namespaces.clone();
        let shutdown_vuln = shutdown.clone();
        let shutdown_sbom = shutdown.clone();
        let watcher_status_vuln = self.watcher_status.clone();
        let watcher_status_sbom = self.watcher_status.clone();

        let vuln_handle = tokio::spawn(async move {
            watch_vulnerability_reports(
                client_vuln,
                db_vuln,
                cluster_vuln,
                namespaces_vuln,
                shutdown_vuln,
                watcher_status_vuln,
            )
            .await
        });

        let sbom_handle = tokio::spawn(async move {
            watch_sbom_reports(
                client_sbom,
                db_sbom,
                cluster_sbom,
                namespaces_sbom,
                shutdown_sbom,
                watcher_status_sbom,
            )
            .await
        });

        tokio::select! {
            _ = shutdown.changed() => {
                info!("Local watcher shutdown signal received");
            }
            result = vuln_handle => {
                if let Err(e) = result {
                    error!(error = %e, "VulnerabilityReport watcher failed");
                }
            }
            result = sbom_handle => {
                if let Err(e) = result {
                    error!(error = %e, "SbomReport watcher failed");
                }
            }
        }

        Ok(())
    }
}

async fn watch_vulnerability_reports(
    client: Client,
    db: Arc<Database>,
    cluster_name: String,
    namespaces: Vec<String>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    watcher_status: Arc<WatcherStatus>,
) -> Result<()> {
    let api: Api<VulnerabilityReport> = Api::all(client);
    let watcher_config = WatcherConfig::default();
    let mut stream = watcher(api, watcher_config).boxed();

    watcher_status.set_vuln_running(true);
    info!("VulnerabilityReport watcher started");

    let mut sync_state = SyncState::new();

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                info!("VulnerabilityReport watcher shutting down");
                watcher_status.set_vuln_running(false);
                break;
            }
            event = stream.next() => {
                match event {
                    Some(Ok(ev)) => {
                        if let Err(e) = handle_vuln_event(&db, &cluster_name, ev, &namespaces, &watcher_status, &mut sync_state).await {
                            error!(error = %e, "Failed to handle VulnerabilityReport event");
                        }
                    }
                    Some(Err(e)) => {
                        error!(error = %e, "VulnerabilityReport watcher error");
                    }
                    None => {
                        warn!("VulnerabilityReport watcher stream ended");
                        watcher_status.set_vuln_running(false);
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
    db: Arc<Database>,
    cluster_name: String,
    namespaces: Vec<String>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    watcher_status: Arc<WatcherStatus>,
) -> Result<()> {
    let api: Api<SbomReport> = Api::all(client);
    // Use smaller page size for SBOM reports since they can be very large
    let watcher_config = WatcherConfig::default().page_size(50);
    let mut stream = watcher(api, watcher_config).boxed();

    watcher_status.set_sbom_running(true);
    info!("SbomReport watcher started");

    let mut sync_state = SyncState::new();

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                info!("SbomReport watcher shutting down");
                watcher_status.set_sbom_running(false);
                break;
            }
            event = stream.next() => {
                match event {
                    Some(Ok(ev)) => {
                        if let Err(e) = handle_sbom_event(&db, &cluster_name, ev, &namespaces, &watcher_status, &mut sync_state).await {
                            error!(error = %e, "Failed to handle SbomReport event");
                        }
                    }
                    Some(Err(e)) => {
                        error!(error = %e, "SbomReport watcher error");
                    }
                    None => {
                        warn!("SbomReport watcher stream ended");
                        watcher_status.set_sbom_running(false);
                        break;
                    }
                }
            }
        }
    }

    Ok(())
}

struct SyncState {
    count: u64,
    start_time: Option<std::time::Instant>,
}

impl SyncState {
    fn new() -> Self {
        Self {
            count: 0,
            start_time: None,
        }
    }

    fn start(&mut self) {
        self.count = 0;
        self.start_time = Some(std::time::Instant::now());
    }

    fn increment(&mut self) {
        self.count += 1;
    }

    fn elapsed_secs(&self) -> f64 {
        self.start_time
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0)
    }
}

async fn handle_vuln_event(
    db: &Database,
    cluster_name: &str,
    event: Event<VulnerabilityReport>,
    namespaces: &[String],
    watcher_status: &WatcherStatus,
    sync_state: &mut SyncState,
) -> Result<()> {
    match event {
        Event::Apply(report) | Event::InitApply(report) => {
            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data = serde_json::to_value(&report)?;

            let payload = ReportPayload {
                cluster: cluster_name.to_string(),
                report_type: "vulnerabilityreport".to_string(),
                namespace: namespace.to_string(),
                name: name.to_string(),
                data,
                received_at: chrono::Utc::now(),
            };

            db.upsert_report(&payload)?;

            info!(
                cluster = %cluster_name,
                namespace = %namespace,
                name = %name,
                critical = report.report.summary.critical_count,
                high = report.report.summary.high_count,
                "VulnerabilityReport stored"
            );

            sync_state.increment();
        }
        Event::Delete(report) => {
            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                return Ok(());
            }

            db.delete_report(cluster_name, namespace, name, "vulnerabilityreport")?;

            info!(
                cluster = %cluster_name,
                namespace = %namespace,
                name = %name,
                "VulnerabilityReport deleted"
            );
        }
        Event::Init => {
            sync_state.start();
            info!("VulnerabilityReport initial sync started");
        }
        Event::InitDone => {
            watcher_status.set_vuln_sync_done(true);
            info!(
                reports_synced = sync_state.count,
                elapsed_secs = format!("{:.2}", sync_state.elapsed_secs()),
                "VulnerabilityReport initial sync completed"
            );
        }
    }

    Ok(())
}

async fn handle_sbom_event(
    db: &Database,
    cluster_name: &str,
    event: Event<SbomReport>,
    namespaces: &[String],
    watcher_status: &WatcherStatus,
    sync_state: &mut SyncState,
) -> Result<()> {
    match event {
        Event::Apply(report) | Event::InitApply(report) => {
            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                debug!(namespace = %namespace, "Skipping report from non-watched namespace");
                return Ok(());
            }

            let data = serde_json::to_value(&report)?;

            let payload = ReportPayload {
                cluster: cluster_name.to_string(),
                report_type: "sbomreport".to_string(),
                namespace: namespace.to_string(),
                name: name.to_string(),
                data,
                received_at: chrono::Utc::now(),
            };

            db.upsert_report(&payload)?;

            info!(
                cluster = %cluster_name,
                namespace = %namespace,
                name = %name,
                components = report.report.summary.components_count,
                "SbomReport stored"
            );

            sync_state.increment();
        }
        Event::Delete(report) => {
            let namespace = report.metadata.namespace.as_deref().unwrap_or("default");
            let name = report.metadata.name.as_deref().unwrap_or("unknown");

            if !namespaces.is_empty() && !namespaces.iter().any(|ns| ns == namespace) {
                return Ok(());
            }

            db.delete_report(cluster_name, namespace, name, "sbomreport")?;

            info!(
                cluster = %cluster_name,
                namespace = %namespace,
                name = %name,
                "SbomReport deleted"
            );
        }
        Event::Init => {
            sync_state.start();
            info!("SbomReport initial sync started");
        }
        Event::InitDone => {
            watcher_status.set_sbom_sync_done(true);
            info!(
                reports_synced = sync_state.count,
                elapsed_secs = format!("{:.2}", sync_state.elapsed_secs()),
                "SbomReport initial sync completed"
            );
        }
    }

    Ok(())
}
