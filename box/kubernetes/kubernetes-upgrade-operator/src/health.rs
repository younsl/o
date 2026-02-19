//! Health check endpoints (/healthz, /readyz).

use axum::Router;
use axum::http::StatusCode;
use axum::routing::get;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::net::TcpListener;
use tracing::info;

/// Shared readiness state.
#[derive(Clone)]
pub struct HealthState {
    ready: Arc<AtomicBool>,
}

impl HealthState {
    pub fn new() -> Self {
        Self {
            ready: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }
}

async fn healthz() -> StatusCode {
    StatusCode::OK
}

async fn readyz(state: axum::extract::State<HealthState>) -> StatusCode {
    if state.is_ready() {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    }
}

/// Start the health server on the given port.
pub async fn serve(port: u16, state: HealthState) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .with_state(state);

    let listener = TcpListener::bind(format!("0.0.0.0:{}", port)).await?;
    info!("Health server listening on port {}", port);
    axum::serve(listener, app).await?;
    Ok(())
}
