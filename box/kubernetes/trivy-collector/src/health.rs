use anyhow::Result;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
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
}

impl HealthServer {
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

    pub async fn serve(&self, port: u16, ready_tx: oneshot::Sender<()>) -> Result<()> {
        let addr = SocketAddr::from(([0, 0, 0, 0], port));
        let listener = TcpListener::bind(addr).await?;

        info!(port = port, "Health server listening");

        // Signal that health server is ready
        let _ = ready_tx.send(());

        let ready = self.ready.clone();

        loop {
            let (stream, remote_addr) = listener.accept().await?;
            let io = TokioIo::new(stream);
            let ready = ready.clone();

            tokio::spawn(async move {
                let service = service_fn(move |req| {
                    let ready = ready.clone();
                    async move { handle_request(req, ready).await }
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

impl Default for HealthServer {
    fn default() -> Self {
        Self::new()
    }
}

async fn handle_request(
    req: Request<hyper::body::Incoming>,
    ready: Arc<AtomicBool>,
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
        _ => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .header("Content-Type", "text/plain")
            .body(Full::new(Bytes::from("not found")))
            .unwrap(),
    };

    Ok(response)
}
