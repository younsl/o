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

    let listener = TcpListener::bind(format!("0.0.0.0:{port}")).await?;
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

    #[tokio::test]
    async fn test_healthz_returns_ok() {
        let result = healthz().await;
        assert_eq!(result, StatusCode::OK);
    }

    #[tokio::test]
    async fn test_readyz_not_ready() {
        let state = HealthState::new();
        let result = readyz(axum::extract::State(state)).await;
        assert_eq!(result, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn test_readyz_ready() {
        let state = HealthState::new();
        state.set_ready(true);
        let result = readyz(axum::extract::State(state)).await;
        assert_eq!(result, StatusCode::OK);
    }

    #[tokio::test]
    async fn test_serve_healthz_and_readyz() {
        let state = HealthState::new();
        let state_clone = state.clone();

        // Start server on a random available port
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let app = Router::new()
            .route("/healthz", get(healthz))
            .route("/readyz", get(readyz))
            .with_state(state_clone);

        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = reqwest::Client::new();

        // healthz should always be 200
        let resp = client
            .get(format!("http://127.0.0.1:{port}/healthz"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);

        // readyz should be 503 when not ready
        let resp = client
            .get(format!("http://127.0.0.1:{port}/readyz"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 503);

        // Set ready and check again
        state.set_ready(true);
        let resp = client
            .get(format!("http://127.0.0.1:{port}/readyz"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 200);
    }

    #[tokio::test]
    async fn test_readyz_toggled() {
        let state = HealthState::new();
        state.set_ready(true);
        assert_eq!(
            readyz(axum::extract::State(state.clone())).await,
            StatusCode::OK
        );
        state.set_ready(false);
        assert_eq!(
            readyz(axum::extract::State(state)).await,
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
