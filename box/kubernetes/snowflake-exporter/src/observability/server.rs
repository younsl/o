use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use axum::{Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};

use crate::observability::metrics::Metrics;

#[derive(Clone)]
pub struct AppState {
    pub metrics: Arc<Metrics>,
    pub ready: Arc<AtomicBool>,
}

async fn metrics_handler(State(state): State<AppState>) -> impl IntoResponse {
    let body = state.metrics.encode();
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
}

async fn healthz_handler() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn readyz_handler(State(state): State<AppState>) -> impl IntoResponse {
    if state.ready.load(Ordering::Relaxed) {
        (StatusCode::OK, "ready")
    } else {
        (StatusCode::SERVICE_UNAVAILABLE, "warming up")
    }
}

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/metrics", get(metrics_handler))
        .route("/healthz", get(healthz_handler))
        .route("/readyz", get(readyz_handler))
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state(ready: bool) -> AppState {
        AppState {
            metrics: Arc::new(Metrics::new().unwrap()),
            ready: Arc::new(AtomicBool::new(ready)),
        }
    }

    #[tokio::test]
    async fn test_healthz_ok() {
        let app = create_router(test_state(true));
        let req = Request::builder()
            .uri("/healthz")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_readyz_warming_up() {
        let app = create_router(test_state(false));
        let req = Request::builder()
            .uri("/readyz")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn test_readyz_ready() {
        let app = create_router(test_state(true));
        let req = Request::builder()
            .uri("/readyz")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_metrics_endpoint() {
        let state = test_state(true);
        state.metrics.up.set(1.0);
        let app = create_router(state);
        let req = Request::builder()
            .uri("/metrics")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let body_str = String::from_utf8(body.to_vec()).unwrap();
        assert!(body_str.contains("snowflake_up 1"));
    }
}
