mod abi;
mod events;
mod health;
mod loader;
mod metrics;

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Parser;
use tokio::signal::unix::{SignalKind, signal};
use tokio::task::JoinHandle;
use tracing::{error, info, warn};

use crate::events::NodeContext;
use crate::loader::{DroppedCounter, Mode, ProgramLoader};
use crate::metrics::Metrics;

#[derive(Parser, Debug)]
#[command(
    name = "copyfail-guard",
    version,
    about = "Blocks AF_ALG socket creation to mitigate CVE-2026-31431 (Copy.Fail)"
)]
struct Args {
    /// Force a specific mode instead of auto-detecting BPF LSM availability.
    #[arg(long, env = "COPYFAIL_MODE", value_enum, default_value_t = ModeArg::Auto)]
    mode: ModeArg,

    /// Address for /healthz and /readyz HTTP endpoints.
    #[arg(long, env = "HEALTH_ADDR", default_value = "0.0.0.0:8080")]
    health_addr: String,

    /// Address for /metrics Prometheus endpoint.
    #[arg(long, env = "METRICS_ADDR", default_value = "0.0.0.0:8081")]
    metrics_addr: String,

    /// Log format: json or pretty.
    #[arg(long, env = "LOG_FORMAT", default_value = "json")]
    log_format: String,

    /// Log level (trace|debug|info|warn|error).
    #[arg(long, env = "LOG_LEVEL", default_value = "info")]
    log_level: String,

    /// Periodic alive log interval in seconds.
    #[arg(long, env = "HEARTBEAT_SECS", default_value_t = 300)]
    heartbeat_secs: u64,

    /// Drop-counter polling interval in seconds.
    #[arg(long, env = "DROP_POLL_SECS", default_value_t = 30)]
    drop_poll_secs: u64,
}

#[derive(clap::ValueEnum, Debug, Clone, Copy)]
enum ModeArg {
    Auto,
    Lsm,
    Tracepoint,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    init_logging(&args.log_format, &args.log_level)?;

    let node = std::env::var("NODE_NAME").unwrap_or_else(|_| "unknown".into());
    let pod = std::env::var("POD_NAME").unwrap_or_else(|_| "unknown".into());

    info!(
        version = env!("CARGO_PKG_VERSION"),
        git_sha = env!("GIT_SHA"),
        built_at = env!("BUILD_TIMESTAMP"),
        node = %node,
        pod = %pod,
        "starting copyfail-guard"
    );

    raise_memlock_rlimit();

    let metrics = Arc::new(Metrics::new().context("init prometheus metrics")?);

    let detected = loader::detect_mode();
    let mode = match args.mode {
        ModeArg::Lsm => Mode::Lsm,
        ModeArg::Tracepoint => Mode::Tracepoint,
        ModeArg::Auto => detected,
    };
    if !matches!(args.mode, ModeArg::Auto) && mode != detected {
        warn!(
            forced = ?mode,
            detected = ?detected,
            "user-forced mode disagrees with detected kernel capability; load may fail"
        );
    }
    info!(?mode, ?detected, "selected enforcement mode");
    metrics.set_mode(mode);

    let mut program = match ProgramLoader::load(mode) {
        Ok(p) => p,
        Err(e) => {
            error!(error = %e, ?mode, node = %node, "failed to load eBPF program");
            return Err(e);
        }
    };
    if let Err(e) = program.attach() {
        error!(error = %e, ?mode, node = %node, "failed to attach eBPF program");
        return Err(e);
    }
    info!(?mode, "eBPF program attached");

    let events_map = program.events_map().context("take ringbuf events map")?;
    let dropped_map = program
        .dropped_map()
        .context("take per-cpu dropped counter map")?;

    let node_ctx = NodeContext {
        node: node.clone(),
        pod: pod.clone(),
    };

    let health = tokio::spawn(health::serve(args.health_addr.clone()));
    let metrics_srv = tokio::spawn(metrics::serve(args.metrics_addr.clone(), metrics.clone()));
    let event_loop = tokio::spawn(events::run(events_map, metrics.clone(), node_ctx));
    let drop_poller = spawn_drop_poller(dropped_map, metrics.clone(), args.drop_poll_secs);
    let heartbeat = spawn_heartbeat(metrics.clone(), node.clone(), mode, args.heartbeat_secs);

    let mut sigterm = signal(SignalKind::terminate())?;
    let mut sigint = signal(SignalKind::interrupt())?;

    let shutdown_reason = tokio::select! {
        _ = sigterm.recv() => "SIGTERM",
        _ = sigint.recv() => "SIGINT",
        res = await_or_log(health, "health") => return Err(res),
        res = await_or_log(metrics_srv, "metrics") => return Err(res),
        res = await_or_log(event_loop, "event-loop") => return Err(res),
    };

    log_final_stats(&metrics, &node, mode, shutdown_reason);
    drop_poller.abort();
    heartbeat.abort();
    Ok(())
}

fn spawn_heartbeat(
    metrics: Arc<Metrics>,
    node: String,
    mode: Mode,
    interval_secs: u64,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if interval_secs == 0 {
            return;
        }
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
        ticker.tick().await; // skip immediate first tick
        loop {
            ticker.tick().await;
            info!(
                node = %node,
                ?mode,
                blocked = metrics.blocked_total(),
                killed = metrics.killed_total(),
                dropped = metrics.dropped_total(),
                "alive"
            );
        }
    })
}

fn spawn_drop_poller(
    counter: DroppedCounter,
    metrics: Arc<Metrics>,
    interval_secs: u64,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if interval_secs == 0 {
            return;
        }
        let mut ticker = tokio::time::interval(Duration::from_secs(interval_secs));
        let mut last = 0u64;
        loop {
            ticker.tick().await;
            match counter.total() {
                Ok(total) => {
                    metrics.set_dropped(total);
                    if total > last {
                        warn!(
                            new_drops = total - last,
                            total_drops = total,
                            "ring buffer overflowed; events lost"
                        );
                        last = total;
                    }
                }
                Err(e) => warn!(error = %e, "failed to read DROPPED map"),
            }
        }
    })
}

async fn await_or_log<T>(handle: JoinHandle<Result<T>>, name: &'static str) -> anyhow::Error {
    match handle.await {
        Ok(Ok(_)) => anyhow::anyhow!("{name} task exited unexpectedly"),
        Ok(Err(e)) => {
            error!(task = name, error = %e, "background task failed");
            e
        }
        Err(e) => {
            error!(task = name, error = %e, "background task panicked or was cancelled");
            anyhow::anyhow!("{name} task join error: {e}")
        }
    }
}

fn log_final_stats(metrics: &Metrics, node: &str, mode: Mode, reason: &str) {
    info!(
        reason,
        node,
        ?mode,
        blocked = metrics.blocked_total(),
        killed = metrics.killed_total(),
        dropped = metrics.dropped_total(),
        "shutting down"
    );
}

fn init_logging(format: &str, level: &str) -> Result<()> {
    use tracing_subscriber::{EnvFilter, fmt, prelude::*};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(format!("info,copyfail_guard={}", level)));

    let registry = tracing_subscriber::registry().with(filter);
    if format == "pretty" {
        registry.with(fmt::layer().with_target(false)).init();
    } else {
        registry
            .with(fmt::layer().json().flatten_event(true))
            .init();
    }
    Ok(())
}

fn raise_memlock_rlimit() {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    let _ = unsafe { libc::getrlimit(libc::RLIMIT_MEMLOCK, &mut current) };

    let rlim = libc::rlimit {
        rlim_cur: libc::RLIM_INFINITY,
        rlim_max: libc::RLIM_INFINITY,
    };
    let ret = unsafe { libc::setrlimit(libc::RLIMIT_MEMLOCK, &rlim) };
    if ret != 0 {
        warn!(
            current_soft = current.rlim_cur,
            current_hard = current.rlim_max,
            requested = "infinity",
            errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0),
            "setrlimit(RLIMIT_MEMLOCK) failed; eBPF map allocation may hit the limit"
        );
    }
}
