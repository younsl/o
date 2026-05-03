use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::Result;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use prometheus::{Encoder, IntCounter, IntCounterVec, IntGauge, Registry, TextEncoder};
use tokio::net::TcpListener;
use tracing::{error, info};

use crate::loader::Mode;

pub struct Metrics {
    registry: Registry,
    events_total: IntCounterVec,
    events_dropped: IntCounter,
    mode_gauge: IntGauge,
    blocked: AtomicU64,
    killed: AtomicU64,
}

impl Metrics {
    pub fn new() -> Result<Self> {
        let registry = Registry::new();
        let events_total = IntCounterVec::new(
            prometheus::Opts::new(
                "copyfail_guard_events_total",
                "AF_ALG socket interception events.",
            ),
            &["action"],
        )?;
        let events_dropped = IntCounter::with_opts(prometheus::Opts::new(
            "copyfail_guard_events_dropped_total",
            "Events the kernel program could not push (ringbuf full).",
        ))?;
        let mode_gauge = IntGauge::with_opts(prometheus::Opts::new(
            "copyfail_guard_mode",
            "Active enforcement mode: 1=lsm, 2=tracepoint.",
        ))?;
        registry.register(Box::new(events_total.clone()))?;
        registry.register(Box::new(events_dropped.clone()))?;
        registry.register(Box::new(mode_gauge.clone()))?;
        Ok(Self {
            registry,
            events_total,
            events_dropped,
            mode_gauge,
            blocked: AtomicU64::new(0),
            killed: AtomicU64::new(0),
        })
    }

    pub fn record_event(&self, action: &str) {
        self.events_total.with_label_values(&[action]).inc();
        match action {
            "blocked" => {
                self.blocked.fetch_add(1, Ordering::Relaxed);
            }
            "killed" => {
                self.killed.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }

    pub fn set_dropped(&self, total: u64) {
        let prev = self.events_dropped.get();
        if total > prev {
            self.events_dropped.inc_by(total - prev);
        }
    }

    pub fn set_mode(&self, mode: Mode) {
        self.mode_gauge.set(match mode {
            Mode::Lsm => 1,
            Mode::Tracepoint => 2,
        });
    }

    pub fn blocked_total(&self) -> u64 {
        self.blocked.load(Ordering::Relaxed)
    }

    pub fn killed_total(&self) -> u64 {
        self.killed.load(Ordering::Relaxed)
    }

    pub fn dropped_total(&self) -> u64 {
        self.events_dropped.get()
    }

    fn render(&self) -> Result<Vec<u8>> {
        let mut buf = Vec::new();
        let encoder = TextEncoder::new();
        encoder.encode(&self.registry.gather(), &mut buf)?;
        Ok(buf)
    }
}

pub async fn serve(addr: String, metrics: Arc<Metrics>) -> Result<()> {
    let listener = TcpListener::bind(&addr).await?;
    info!(%addr, "metrics listener started");
    loop {
        let (stream, _) = listener.accept().await?;
        let metrics = metrics.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                let metrics = metrics.clone();
                async move {
                    Ok::<_, hyper::Error>(if req.uri().path() == "/metrics" {
                        match metrics.render() {
                            Ok(body) => Response::new(Full::new(Bytes::from(body))),
                            Err(_) => Response::builder()
                                .status(StatusCode::INTERNAL_SERVER_ERROR)
                                .body(Full::new(Bytes::from_static(b"encode error")))
                                .unwrap(),
                        }
                    } else {
                        Response::builder()
                            .status(StatusCode::NOT_FOUND)
                            .body(Full::new(Bytes::from_static(b"not found")))
                            .unwrap()
                    })
                }
            });
            if let Err(e) = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, svc)
                .await
            {
                error!(error = %e, "metrics connection error");
            }
        });
    }
}
