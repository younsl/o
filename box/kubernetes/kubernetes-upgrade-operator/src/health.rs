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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_health_state_initial() {
        let state = HealthState::new();
        assert!(!state.is_ready());
    }

    #[test]
    fn test_health_state_set_ready() {
        let state = HealthState::new();
        state.set_ready(true);
        assert!(state.is_ready());
    }

    #[test]
    fn test_health_state_set_not_ready() {
        let state = HealthState::new();
        state.set_ready(true);
        assert!(state.is_ready());
        state.set_ready(false);
        assert!(!state.is_ready());
    }

    #[test]
    fn test_health_state_clone_shares_state() {
        let state = HealthState::new();
        let cloned = state.clone();
        state.set_ready(true);
        assert!(cloned.is_ready());
    }
}
