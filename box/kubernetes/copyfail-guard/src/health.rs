use anyhow::Result;
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;
use tracing::{error, info};

pub async fn serve(addr: String) -> Result<()> {
    let listener = TcpListener::bind(&addr).await?;
    info!(%addr, "health listener started");
    loop {
        let (stream, _) = listener.accept().await?;
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let svc = service_fn(|req: Request<hyper::body::Incoming>| async move {
                Ok::<_, hyper::Error>(match req.uri().path() {
                    "/healthz" | "/readyz" => Response::new(Full::new(Bytes::from_static(b"ok"))),
                    _ => Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(Full::new(Bytes::from_static(b"not found")))
                        .unwrap(),
                })
            });
            if let Err(e) = hyper::server::conn::http1::Builder::new()
                .serve_connection(io, svc)
                .await
            {
                error!(error = %e, "health connection error");
            }
        });
    }
}
