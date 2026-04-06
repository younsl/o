mod aws;
mod config;
mod error;
mod k8s;
mod observability;
mod types;

use std::sync::Arc;

use clap::Parser;
use tokio::sync::RwLock;
use tracing_subscriber::EnvFilter;

use crate::aws::collector::AwsPiCollector;
use crate::aws::discovery::AwsRdsDiscoverer;
use crate::config::{Args, Config};
use crate::k8s::leader::LeaderElector;
use crate::observability::metrics::Metrics;
use crate::observability::server::{AppState, create_router};
use crate::types::AuroraInstance;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const COMMIT: &str = env!("BUILD_COMMIT");
const BUILD_DATE: &str = env!("BUILD_DATE");

#[tokio::main]
async fn main() {
    rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .expect("Failed to install default CryptoProvider");

    let init_start = std::time::Instant::now();
    let args = Args::parse();

    // Load config
    let config = match Config::load(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to load config: {e}");
            std::process::exit(1);
        }
    };

    // Initialize logging
    init_logging(&config.logging);

    tracing::info!(
        version = VERSION,
        commit = COMMIT,
        build_date = BUILD_DATE,
        config_path = %args.config.display(),
        "Starting aurora-database-insights-exporter"
    );

    tracing::info!(
        region = %config.aws.region,
        engine = %config.discovery.engine,
        require_pi_enabled = config.discovery.require_pi_enabled,
        discovery_interval_seconds = config.discovery.interval_seconds,
        collection_interval_seconds = config.collection.interval_seconds,
        top_sql_limit = config.collection.top_sql_limit,
        top_host_limit = config.collection.top_host_limit,
        max_concurrent_api_calls = config.collection.max_concurrent_api_calls,
        exported_tags = ?config.discovery.exported_tags,
        "Loaded configuration"
    );

    // Initialize AWS SDK
    tracing::info!(region = %config.aws.region, "Initializing AWS SDK");

    let aws_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(aws_config::Region::new(config.aws.region.clone()))
        .load()
        .await;

    let rds_client = aws_sdk_rds::Client::new(&aws_config);
    let pi_client = aws_sdk_pi::Client::new(&aws_config);

    tracing::info!("Initialized RDS and Performance Insights API clients");

    let discoverer = Arc::new(AwsRdsDiscoverer::new(rds_client));
    let pi_collector = Arc::new(AwsPiCollector::new(pi_client));

    // Shared state
    let instances_state: Arc<RwLock<Vec<AuroraInstance>>> = Arc::new(RwLock::new(Vec::new()));
    let metrics = Arc::new(Metrics::new(&config.discovery.exported_tags));
    let ready_flag = Arc::new(RwLock::new(false));
    let is_leader = Arc::new(RwLock::new(!config.leader_election.enabled)); // true if LE disabled

    tracing::info!(
        metrics_count = 14,
        exported_tag_labels = config.discovery.exported_tags.len(),
        "Registered Prometheus metrics"
    );

    // Leader election
    let leader_elector: Option<Arc<LeaderElector>> = if config.leader_election.enabled {
        tracing::info!(
            lease_name = %config.leader_election.lease_name,
            lease_namespace = %config.leader_election.lease_namespace,
            lease_duration_seconds = config.leader_election.lease_duration_seconds,
            "Initializing leader election"
        );
        match LeaderElector::new(config.leader_election.clone(), is_leader.clone()).await {
            Ok(le) => {
                let le = Arc::new(le);
                let le_run = le.clone();
                tokio::spawn(async move { le_run.run().await });
                tracing::info!("Started leader election loop");
                Some(le)
            }
            Err(e) => {
                tracing::error!(error = %e, "Leader election initialization failed");
                std::process::exit(1);
            }
        }
    } else {
        tracing::info!("Leader election disabled. This instance is always active");
        None
    };

    // Spawn discovery loop
    let disc_state = instances_state.clone();
    let disc_config = config.discovery.clone();
    let disc_metrics = metrics.clone();
    let disc_region = config.aws.region.clone();
    let disc_leader = is_leader.clone();
    tokio::spawn(async move {
        discovery_loop(
            discoverer,
            disc_config,
            disc_state,
            disc_metrics,
            disc_region,
            disc_leader,
        )
        .await;
    });

    // Spawn collection loop
    let coll_state = instances_state.clone();
    let coll_config = config.collection.clone();
    let coll_metrics = metrics.clone();
    let coll_ready = ready_flag.clone();
    let coll_region = config.aws.region.clone();
    let coll_leader = is_leader.clone();
    tokio::spawn(async move {
        collection_loop_with_leader(
            pi_collector,
            coll_state,
            coll_region,
            coll_config,
            coll_metrics,
            coll_ready,
            coll_leader,
        )
        .await;
    });

    tracing::info!(
        discovery_interval_seconds = config.discovery.interval_seconds,
        collection_interval_seconds = config.collection.interval_seconds,
        "Started background loops for discovery and collection"
    );

    // Start HTTP server
    let state = AppState {
        metrics,
        ready: ready_flag,
    };
    let app = create_router(state);

    let listener = tokio::net::TcpListener::bind(&config.server.listen_address)
        .await
        .expect("Failed to bind TCP listener");

    tracing::info!(
        address = %config.server.listen_address,
        endpoints = "/metrics, /healthz, /readyz",
        "HTTP server started"
    );

    tracing::info!(
        duration_ms = init_start.elapsed().as_millis() as u64,
        "Initialization complete. Waiting for first discovery cycle"
    );

    // Graceful shutdown on SIGTERM
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("HTTP server error");

    // Release lease on shutdown
    if let Some(le) = &leader_elector {
        le.release().await;
    }

    tracing::info!("Shutdown complete");
}

fn init_logging(config: &config::LoggingConfig) {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(&config.level));

    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_target(true);

    if config.format == "json" {
        subscriber.json().init();
    } else {
        subscriber.init();
    }
}

async fn discovery_loop(
    discoverer: Arc<AwsRdsDiscoverer>,
    config: config::DiscoveryConfig,
    state: Arc<RwLock<Vec<AuroraInstance>>>,
    metrics: Arc<Metrics>,
    region: String,
    is_leader: Arc<RwLock<bool>>,
) {
    let mut cycle: u64 = 0;

    loop {
        if !*is_leader.read().await {
            tracing::debug!(
                cycle = cycle + 1,
                "Skipping discovery because this instance is not the leader"
            );
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }

        cycle += 1;

        tracing::info!(cycle, "Discovery cycle started");
        let start = std::time::Instant::now();

        match aws::discovery::run_discovery_cycle(&*discoverer, &config, &state).await {
            Ok(result) => {
                let duration = start.elapsed();

                metrics.discovery_instances_total.set(result.total as f64);
                metrics
                    .discovery_duration_seconds
                    .set(duration.as_secs_f64());

                tracing::info!(
                    cycle,
                    instances_found = result.total,
                    instances_added = result.added,
                    instances_removed = result.removed_instances.len(),
                    duration_ms = duration.as_millis() as u64,
                    "Discovery cycle completed"
                );

                // Clean stale metrics for removed instances
                for removed_inst in &result.removed_instances {
                    let labels = types::InstanceLabels::from_instance(removed_inst, &region);
                    metrics.remove_instance(&labels);
                    tracing::info!(
                        instance = %removed_inst.db_instance_identifier,
                        resource_id = %removed_inst.dbi_resource_id,
                        "Removed instance and cleaned stale metrics"
                    );
                }
            }
            Err(e) => {
                let duration = start.elapsed();
                metrics
                    .discovery_duration_seconds
                    .set(duration.as_secs_f64());

                let count = state.read().await.len();
                tracing::warn!(
                    cycle,
                    error = %e,
                    previous_instance_count = count,
                    "Discovery cycle failed. Retaining previous instance list"
                );
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(config.interval_seconds)).await;
    }
}

async fn collection_loop_with_leader(
    pi: Arc<AwsPiCollector>,
    instances_state: Arc<RwLock<Vec<AuroraInstance>>>,
    region: String,
    config: config::CollectionConfig,
    metrics: Arc<Metrics>,
    ready_flag: Arc<RwLock<bool>>,
    is_leader: Arc<RwLock<bool>>,
) {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(config.max_concurrent_api_calls));
    let mut cycle: u64 = 0;

    loop {
        if !*is_leader.read().await {
            tracing::debug!(
                cycle = cycle + 1,
                "Skipping collection because this instance is not the leader"
            );
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }

        let instances = instances_state.read().await.clone();
        if instances.is_empty() {
            tracing::debug!(cycle = cycle + 1, "No instances discovered. Skipping collection");
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            continue;
        }

        cycle += 1;

        tracing::info!(
            cycle,
            instances = instances.len(),
            "Collection cycle started"
        );
        let start = std::time::Instant::now();

        let (collected, failed) = aws::collector::run_collection_cycle(
            &*pi, &instances, &region, &config, &metrics, &semaphore,
        )
        .await;

        let duration = start.elapsed();
        metrics.scrape_duration_seconds.set(duration.as_secs_f64());

        tracing::info!(
            cycle,
            instances_collected = collected,
            instances_failed = failed,
            total_duration_ms = duration.as_millis() as u64,
            "Collection cycle completed"
        );

        // Enable readiness after first successful collection
        let mut ready = ready_flag.write().await;
        if !*ready && collected > 0 {
            *ready = true;
            tracing::info!("Readiness probe enabled after first successful collection");
        }

        tokio::time::sleep(std::time::Duration::from_secs(config.interval_seconds)).await;
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Failed to install CTRL+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {
            tracing::info!("Received SIGINT. Initiating graceful shutdown");
        },
        () = terminate => {
            tracing::info!("Received SIGTERM. Initiating graceful shutdown");
        },
    }
}
