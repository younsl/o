//! Bearer token authentication for the MCP endpoint.
//!
//! A single static token shared with kagent. The handler reads the mounted
//! token file on every request, so a rotated Secret takes effect as soon as
//! the kubelet refreshes the mount, without a Pod restart. The received value
//! is never logged, including on failures.

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
use axum::http::{Request, StatusCode, header};
use axum::middleware::Next;
use axum::response::Response;
use tracing::warn;

/// Shared state for the auth middleware: where the expected token lives.
#[derive(Clone, Debug)]
pub struct TokenFile(pub Arc<PathBuf>);

/// Axum middleware enforcing `Authorization: Bearer <token>`.
///
/// Rejections carry no body detail beyond the status: 401 for a missing or
/// wrong credential, 500 when the token file itself cannot be read (a broken
/// mount is a server fault, not a caller fault).
pub async fn require_bearer(
    State(token_file): State<TokenFile>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let presented = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim);

    let Some(presented) = presented else {
        warn!("MCP request rejected, missing or malformed Authorization header");
        return Err(StatusCode::UNAUTHORIZED);
    };

    let expected = match tokio::fs::read_to_string(token_file.0.as_path()).await {
        Ok(raw) => raw.trim().to_string(),
        Err(e) => {
            warn!(
                "MCP token file {} is unreadable, {e}",
                token_file.0.display()
            );
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        }
    };

    if expected.is_empty() {
        warn!("MCP token file {} is empty", token_file.0.display());
        return Err(StatusCode::INTERNAL_SERVER_ERROR);
    }

    if !constant_time_eq(presented.as_bytes(), expected.as_bytes()) {
        warn!("MCP request rejected, bearer token mismatch");
        return Err(StatusCode::UNAUTHORIZED);
    }

    Ok(next.run(request).await)
}

/// Compare two byte strings without an early exit on the first difference.
///
/// Length is compared up front; leaking the token's length is accepted, since
/// the token is a fixed-format random string whose length is not a secret.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::routing::get;
    use tokio::net::TcpListener;

    #[test]
    fn test_constant_time_eq() {
        assert!(constant_time_eq(b"secret", b"secret"));
        assert!(!constant_time_eq(b"secret", b"secreT"));
        assert!(!constant_time_eq(b"secret", b"secret2"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    async fn serve_with_token(path: &std::path::Path) -> u16 {
        let state = TokenFile(Arc::new(path.to_path_buf()));
        let router = Router::new()
            .route("/mcp", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(state, require_bearer));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        port
    }

    async fn status_for(port: u16, auth: Option<&str>) -> u16 {
        let client = reqwest::Client::new();
        let mut request = client.get(format!("http://127.0.0.1:{port}/mcp"));
        if let Some(value) = auth {
            request = request.header("authorization", value);
        }
        request.send().await.unwrap().status().as_u16()
    }

    #[tokio::test]
    async fn test_require_bearer() {
        let dir = std::env::temp_dir().join(format!("kuo-mcp-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let token_path = dir.join("token");
        std::fs::write(&token_path, "s3cret\n").unwrap();

        let port = serve_with_token(&token_path).await;

        // No header.
        assert_eq!(status_for(port, None).await, 401);

        // Wrong scheme.
        assert_eq!(status_for(port, Some("Basic s3cret")).await, 401);

        // Wrong token.
        assert_eq!(status_for(port, Some("Bearer nope")).await, 401);

        // Correct token, trailing newline in the file is trimmed.
        assert_eq!(status_for(port, Some("Bearer s3cret")).await, 200);

        // Unreadable token file -> server fault, not caller fault.
        let missing = serve_with_token(&dir.join("missing")).await;
        assert_eq!(status_for(missing, Some("Bearer s3cret")).await, 500);

        std::fs::remove_dir_all(&dir).ok();
    }
}
