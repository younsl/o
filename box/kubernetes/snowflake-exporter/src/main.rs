mod config;
mod error;
mod observability;
mod snowflake;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::config::{Args, Config};
use crate::observability::metrics::Metrics;
use crate::observability::server::{AppState, create_router};
use crate::snowflake::client::{SnowflakeClient, load_token};
use crate::snowflake::collector::{Collector, QueryExecutor};

const VERSION: &str = env!("CARGO_PKG_VERSION");
const COMMIT: &str = env!("BUILD_COMMIT");
const BUILD_DATE: &str = env!("BUILD_DATE");

#[tokio::main]
async fn main() {
    if let Err(e) = rustls::crypto::aws_lc_rs::default_provider().install_default() {
        eprintln!("Failed to install default CryptoProvider: {e:?}");
        std::process::exit(1);
    }

    let args = Args::parse();

    let config = match Config::load(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to load config: {e}");
            std::process::exit(1);
        }
    };

    init_logging(&config.logging);

    tracing::info!(
        version = VERSION,
        commit = COMMIT,
        build_date = BUILD_DATE,
        config_path = %args.config.display(),
        "Starting snowflake-exporter"
    );

    tracing::info!(
        account = %config.snowflake.account,
        role = %config.snowflake.role,
        warehouse = %config.snowflake.warehouse,
        database = %config.snowflake.database,
        interval_seconds = config.collection.interval_seconds,
        exclude_deleted_tables = config.collection.exclude_deleted_tables,
        query_timeout_seconds = config.collection.query_timeout_seconds,
        "Loaded configuration"
    );

    let token_path = match &config.snowflake.token_path {
        Some(p) => p.clone(),
        None => {
            tracing::error!("snowflake.token_path is required");
            std::process::exit(1);
        }
    };

    let token = match load_token(&token_path) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(path = %token_path.display(), error = %e, "Failed to load PAT");
            std::process::exit(1);
        }
    };

    let client = match SnowflakeClient::new(
        &config.snowflake.account,
        config.snowflake.role.clone(),
        config.snowflake.warehouse.clone(),
        config.snowflake.database.clone(),
        token,
        Duration::from_secs(config.snowflake.request_timeout_seconds),
    ) {
        Ok(c) => {
            let c: Arc<dyn QueryExecutor> = Arc::new(c);
            c
        }
        Err(e) => {
            tracing::error!(error = %e, "Failed to initialize Snowflake client");
            std::process::exit(1);
        }
    };

    let metrics = match Metrics::new() {
        Ok(m) => Arc::new(m),
        Err(e) => {
            tracing::error!(error = %e, "Failed to register Prometheus metrics");
            std::process::exit(1);
        }
    };

    let collector = Arc::new(Collector::new(
        client.clone(),
        config.collection.query_timeout_seconds,
        config.collection.exclude_deleted_tables,
        config.collection.enable_serverless_detail,
    ));

    let ready = Arc::new(AtomicBool::new(false));

    let loop_metrics = metrics.clone();
    let loop_collector = collector.clone();
    let loop_ready = ready.clone();
    let loop_interval = config.collection.interval_seconds;
    tokio::spawn(async move {
        collection_loop(loop_collector, loop_metrics, loop_ready, loop_interval).await;
    });

    let state = AppState { metrics, ready };
    let app = create_router(state);

    let listener = match tokio::net::TcpListener::bind(&config.server.listen_address).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(
                error = %e,
                address = %config.server.listen_address,
                "Failed to bind TCP listener"
            );
            std::process::exit(1);
        }
    };

    tracing::info!(
        address = %config.server.listen_address,
        endpoints = "/metrics, /healthz, /readyz",
        "HTTP server started"
    );

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
    {
        tracing::error!(error = %e, "HTTP server error");
        std::process::exit(1);
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

async fn collection_loop(
    collector: Arc<Collector>,
    metrics: Arc<Metrics>,
    ready: Arc<AtomicBool>,
    interval_seconds: u64,
) {
    let mut cycle: u64 = 0;
    loop {
        cycle += 1;
        let start = std::time::Instant::now();
        tracing::info!(cycle, "Collection cycle started");

        let ok = collector.run(&metrics).await;
        let duration = start.elapsed();

        metrics.scrape_duration_seconds.set(duration.as_secs_f64());
        metrics.up.set(if ok { 1.0 } else { 0.0 });

        if ok {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            metrics.last_success_timestamp_seconds.set(ts);
            ready.store(true, Ordering::Relaxed);
        }

        tracing::info!(
            cycle,
            duration_ms = duration.as_millis() as u64,
            up = ok,
            "Collection cycle completed"
        );

        tokio::time::sleep(Duration::from_secs(interval_seconds)).await;
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::error!(error = %e, "Failed to install CTRL+C handler");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(e) => {
                tracing::error!(error = %e, "Failed to install SIGTERM handler");
            }
        }
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
