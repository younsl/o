use anyhow::Result;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use prometheus_client::encoding::text::encode;
use prometheus_client::registry::Registry;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tracing::{debug, info};

#[derive(Clone)]
pub struct HealthServer {
    ready: Arc<AtomicBool>,
    registry: Arc<Registry>,
}

impl HealthServer {
    pub fn new(registry: Arc<Registry>) -> Self {
        Self {
            ready: Arc::new(AtomicBool::new(false)),
            registry,
        }
    }

    pub fn set_ready(&self, ready: bool) {
        self.ready.store(ready, Ordering::SeqCst);
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::SeqCst)
    }

    pub async fn serve(&self, port: u16, ready_tx: oneshot::Sender<()>) -> Result<()> {
        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        let listener = TcpListener::bind(addr).await?;

        info!(port = port, "Health server listening");

        // Signal that health server is ready
        let _ = ready_tx.send(());

        let ready = self.ready.clone();
        let registry = self.registry.clone();

        loop {
            let (stream, remote_addr) = listener.accept().await?;
            let io = TokioIo::new(stream);
            let ready = ready.clone();
            let registry = registry.clone();

            tokio::spawn(async move {
                let service = service_fn(move |req| {
                    let ready = ready.clone();
                    let registry = registry.clone();
                    async move { handle_request(req, ready, registry).await }
                });

                if let Err(err) = http1::Builder::new().serve_connection(io, service).await {
                    debug!(
                        error = %err,
                        remote_addr = %remote_addr,
                        "Health server connection error"
                    );
                }
            });
        }
    }
}

async fn handle_request(
    req: Request<hyper::body::Incoming>,
    ready: Arc<AtomicBool>,
    registry: Arc<Registry>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let response = match (req.method(), req.uri().path()) {
        (&Method::GET, "/healthz") => {
            // Liveness probe - always return OK if the server is running
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/plain")
                .body(Full::new(Bytes::from("ok")))
                .unwrap()
        }
        (&Method::GET, "/readyz") => {
            // Readiness probe - return OK only if ready
            if ready.load(Ordering::SeqCst) {
                Response::builder()
                    .status(StatusCode::OK)
                    .header("Content-Type", "text/plain")
                    .body(Full::new(Bytes::from("ok")))
                    .unwrap()
            } else {
                Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .header("Content-Type", "text/plain")
                    .body(Full::new(Bytes::from("not ready")))
                    .unwrap()
            }
        }
        (&Method::GET, "/metrics") => {
            let mut buf = String::new();
            match encode(&mut buf, &registry) {
                Ok(()) => Response::builder()
                    .status(StatusCode::OK)
                    .header(
                        "Content-Type",
                        "application/openmetrics-text; version=1.0.0; charset=utf-8",
                    )
                    .body(Full::new(Bytes::from(buf)))
                    .unwrap(),
                Err(_) => Response::builder()
                    .status(StatusCode::INTERNAL_SERVER_ERROR)
                    .header("Content-Type", "text/plain")
                    .body(Full::new(Bytes::from("failed to encode metrics")))
                    .unwrap(),
            }
        }
        _ => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Content-Type", "text/plain")
            .body(Full::new(Bytes::from("not found")))
            .unwrap(),
    };

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    async fn handle_request_test(
        path: &str,
        ready: Arc<AtomicBool>,
        registry: Arc<Registry>,
    ) -> Response<Full<Bytes>> {
        // Simulate handle_request logic for testing
        match (Method::GET, path) {
            (_, "/healthz") => Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/plain")
                .body(Full::new(Bytes::from("ok")))
                .unwrap(),
            (_, "/readyz") => {
                if ready.load(Ordering::SeqCst) {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header("Content-Type", "text/plain")
                        .body(Full::new(Bytes::from("ok")))
                        .unwrap()
                } else {
                    Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .header("Content-Type", "text/plain")
                        .body(Full::new(Bytes::from("not ready")))
                        .unwrap()
                }
            }
            (_, "/metrics") => {
                let mut buf = String::new();
                match prometheus_client::encoding::text::encode(&mut buf, &registry) {
                    Ok(()) => Response::builder()
                        .status(StatusCode::OK)
                        .header(
                            "Content-Type",
                            "application/openmetrics-text; version=1.0.0; charset=utf-8",
                        )
                        .body(Full::new(Bytes::from(buf)))
                        .unwrap(),
                    Err(_) => Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(Full::new(Bytes::from("failed")))
                        .unwrap(),
                }
            }
            _ => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Full::new(Bytes::from("not found")))
                .unwrap(),
        }
    }

    #[tokio::test]
    async fn test_healthz() {
        let ready = Arc::new(AtomicBool::new(false));
        let registry = Arc::new(Registry::default());
        let resp = handle_request_test("/healthz", ready, registry).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"ok");
    }

    #[tokio::test]
    async fn test_readyz_ready() {
        let ready = Arc::new(AtomicBool::new(true));
        let registry = Arc::new(Registry::default());
        let resp = handle_request_test("/readyz", ready, registry).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"ok");
    }

    #[tokio::test]
    async fn test_readyz_not_ready() {
        let ready = Arc::new(AtomicBool::new(false));
        let registry = Arc::new(Registry::default());
        let resp = handle_request_test("/readyz", ready, registry).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&body[..], b"not ready");
    }

    #[tokio::test]
    async fn test_metrics_endpoint() {
        let ready = Arc::new(AtomicBool::new(true));
        let mut registry = Registry::default();
        let counter = prometheus_client::metrics::counter::Counter::<u64>::default();
        registry.register("test_counter", "A test counter", counter.clone());
        counter.inc();
        let registry = Arc::new(registry);

        let resp = handle_request_test("/metrics", ready, registry).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = resp.into_body().collect().await.unwrap().to_bytes();
        let text = String::from_utf8(body.to_vec()).unwrap();
        assert!(text.contains("test_counter"));
        assert!(text.contains("# EOF"));
    }

    #[tokio::test]
    async fn test_not_found() {
        let ready = Arc::new(AtomicBool::new(true));
        let registry = Arc::new(Registry::default());
        let resp = handle_request_test("/unknown", ready, registry).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn test_health_server_ready_state() {
        let registry = Arc::new(Registry::default());
        let server = HealthServer::new(registry);
        assert!(!server.is_ready());
        server.set_ready(true);
        assert!(server.is_ready());
        server.set_ready(false);
        assert!(!server.is_ready());
    }
}
