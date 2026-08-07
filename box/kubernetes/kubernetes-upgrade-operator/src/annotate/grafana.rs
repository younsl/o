//! Grafana HTTP API client for posting annotations.
//!
//! Annotations are posted to `POST /api/annotations`. They are tag-based and
//! global (no `dashboardUID`), so any dashboard that subscribes to the
//! configured tags through a `-- Grafana --` annotation query renders the
//! markers. This module is the transport only: it knows nothing about upgrades.
//! What to say and when to say it lives in the parent module.

use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use chrono::{DateTime, Utc};
use secrecy::{ExposeSecret, SecretString};
use serde::Serialize;

/// Endpoint for posting annotations.
const ANNOTATIONS_PATH: &str = "/api/annotations";

/// Endpoint used by the startup preflight check.
const HEALTH_PATH: &str = "/api/health";

/// Timeout applied to every Grafana request.
///
/// Fixed rather than configurable. Annotating sits on the reconcile path, so the
/// only question worth answering about a slow Grafana is how fast to give up on
/// it, and three seconds is long enough for a healthy in-cluster Grafana while
/// staying short enough that a hung one is never noticeable in a phase
/// transition.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);

/// Bytes of a non-2xx response body kept for the error message.
const ERROR_BODY_LIMIT: usize = 512;

/// A failed Grafana request.
///
/// The HTTP status is kept separate from the transport failure so callers can
/// tell a rejected token (401/403, a fix the operator must make) from an
/// unreachable Grafana (a transient condition worth no more than a warning).
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("request to {endpoint} failed: {source}")]
    Transport {
        endpoint: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("Grafana returned {status} for {endpoint}: {body}")]
    Status {
        endpoint: String,
        status: reqwest::StatusCode,
        body: String,
    },
}

impl Error {
    /// Whether Grafana rejected the service account token itself.
    ///
    /// `401` means the token is invalid or expired, `403` that it is valid but
    /// lacks `annotations:create`, which is what the Viewer basic role looks
    /// like. Either way no retry will help until the token is changed.
    #[must_use]
    pub const fn is_permission_denied(&self) -> bool {
        match self {
            Self::Status { status, .. } => {
                matches!(
                    *status,
                    reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
                )
            }
            Self::Transport { .. } => false,
        }
    }

    /// Whether the request exceeded [`REQUEST_TIMEOUT`] rather than getting an
    /// answer. This is the one failure worth retrying: Grafana was too slow at
    /// that instant, which says nothing about the next attempt.
    #[must_use]
    pub fn is_timeout(&self) -> bool {
        match self {
            Self::Transport { source, .. } => source.is_timeout(),
            Self::Status { .. } => false,
        }
    }

    /// The HTTP status Grafana answered with, or `None` when the request never
    /// got an answer. Callers log it alongside the latency so a failure line
    /// carries the same two facts as a successful one.
    #[must_use]
    pub const fn status_code(&self) -> Option<u16> {
        match self {
            Self::Status { status, .. } => Some(status.as_u16()),
            Self::Transport { .. } => None,
        }
    }

    /// Whether the endpoint could not be reached at all: DNS did not resolve,
    /// the connection was refused, or TLS failed. Distinguished from any HTTP
    /// answer because the remedy is a network one (URL, Service, namespace,
    /// `NetworkPolicy`) rather than anything to do with Grafana itself.
    #[must_use]
    pub fn is_unreachable(&self) -> bool {
        match self {
            Self::Transport { source, .. } => source.is_connect(),
            Self::Status { .. } => false,
        }
    }
}

/// A single annotation to post.
///
/// `time_end` set makes this a region annotation spanning `time..time_end`,
/// which Grafana draws as a shaded band. Left unset it is a point annotation,
/// drawn as a single vertical line.
#[derive(Clone, Debug)]
pub struct Annotation {
    pub text: String,
    pub tags: Vec<String>,
    pub time: DateTime<Utc>,
    pub time_end: Option<DateTime<Utc>>,
}

/// Wire shape of a Grafana annotation. Both timestamps are epoch milliseconds;
/// `timeEnd` is omitted entirely for a point annotation.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireAnnotation<'a> {
    time: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    time_end: Option<i64>,
    tags: &'a [String],
    text: &'a str,
}

/// Grafana annotations client.
pub struct Client {
    annotations_endpoint: String,
    health_endpoint: String,
    token: SecretString,
    http: reqwest::Client,
    base_tags: Vec<String>,
}

impl Client {
    /// Build a client targeting `base_url` (e.g. `http://grafana.monitoring:3000`).
    ///
    /// `token` is a Grafana service account token sent as a Bearer credential.
    /// `base_tags` are merged ahead of each annotation's own tags and are what
    /// dashboards subscribe to. Every request is bounded by
    /// [`REQUEST_TIMEOUT`].
    pub fn new(base_url: &str, token: SecretString, base_tags: Vec<String>) -> Result<Self> {
        let base = base_url.trim_end_matches('/');
        if base.is_empty() {
            bail!("Grafana base URL is empty");
        }
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .context("failed to build the Grafana HTTP client")?;
        Ok(Self {
            annotations_endpoint: format!("{base}{ANNOTATIONS_PATH}"),
            health_endpoint: format!("{base}{HEALTH_PATH}"),
            token,
            http,
            base_tags,
        })
    }

    /// The annotations endpoint this client posts to.
    #[must_use]
    pub fn endpoint(&self) -> &str {
        &self.annotations_endpoint
    }

    /// The health endpoint the preflight check probes.
    #[must_use]
    pub fn health_endpoint(&self) -> &str {
        &self.health_endpoint
    }

    /// Base tags merged into every annotation.
    #[must_use]
    pub fn base_tags(&self) -> &[String] {
        &self.base_tags
    }

    /// One-time health check, returning the HTTP status. Never mutates state.
    ///
    /// The token is sent so the request also exercises the auth path, though
    /// `/api/health` itself does not require authentication; an invalid token is
    /// only rejected at the first annotation write.
    pub async fn preflight(&self) -> Result<u16, Error> {
        let resp = self
            .http
            .get(&self.health_endpoint)
            .bearer_auth(self.token.expose_secret())
            .send()
            .await
            .map_err(|source| Error::Transport {
                endpoint: self.health_endpoint.clone(),
                source,
            })?;
        let status = resp.status();
        if !status.is_success() {
            return Err(status_error(&self.health_endpoint, status, resp).await);
        }
        Ok(status.as_u16())
    }

    /// Post one annotation, merging the client's base tags ahead of its own, and
    /// return the HTTP status Grafana answered with.
    ///
    /// Returns the error for the caller to log; delivery policy (best-effort,
    /// never failing a reconcile) is the caller's decision, not this layer's.
    pub async fn post(&self, annotation: &Annotation) -> Result<u16, Error> {
        let mut tags = Vec::with_capacity(self.base_tags.len() + annotation.tags.len());
        tags.extend_from_slice(&self.base_tags);
        tags.extend_from_slice(&annotation.tags);

        let payload = WireAnnotation {
            time: annotation.time.timestamp_millis(),
            time_end: annotation.time_end.as_ref().map(DateTime::timestamp_millis),
            tags: &tags,
            text: &annotation.text,
        };

        let resp = self
            .http
            .post(&self.annotations_endpoint)
            .bearer_auth(self.token.expose_secret())
            .json(&payload)
            .send()
            .await
            .map_err(|source| Error::Transport {
                endpoint: self.annotations_endpoint.clone(),
                source,
            })?;

        let status = resp.status();
        if !status.is_success() {
            return Err(status_error(&self.annotations_endpoint, status, resp).await);
        }
        Ok(status.as_u16())
    }
}

/// Build an [`Error::Status`] from a non-2xx response, keeping a bounded slice
/// of the body so a Grafana error page cannot flood the log.
async fn status_error(
    endpoint: &str,
    status: reqwest::StatusCode,
    resp: reqwest::Response,
) -> Error {
    let body = resp.text().await.unwrap_or_default();
    Error::Status {
        endpoint: endpoint.to_string(),
        status,
        body: truncate(body.trim(), ERROR_BODY_LIMIT).to_string(),
    }
}

/// Truncate `s` to at most `limit` bytes, respecting char boundaries.
fn truncate(s: &str, limit: usize) -> &str {
    if s.len() <= limit {
        return s;
    }
    let mut end = limit;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client(base_url: &str) -> Client {
        Client::new(
            base_url,
            SecretString::from("token"),
            vec!["event:eks-upgrade".to_string()],
        )
        .unwrap()
    }

    #[test]
    fn test_new_builds_endpoints() {
        let c = client("http://grafana.monitoring:3000");
        assert_eq!(
            c.endpoint(),
            "http://grafana.monitoring:3000/api/annotations"
        );
        assert_eq!(
            c.health_endpoint(),
            "http://grafana.monitoring:3000/api/health"
        );
    }

    #[test]
    fn test_new_trims_trailing_slashes() {
        let c = client("http://grafana.monitoring:3000///");
        assert_eq!(
            c.endpoint(),
            "http://grafana.monitoring:3000/api/annotations"
        );
    }

    #[test]
    fn test_new_rejects_empty_url() {
        let err = Client::new("///", SecretString::from("t"), vec![]);
        assert!(err.is_err());
    }

    #[test]
    fn test_base_tags_exposed() {
        let c = client("http://grafana:3000");
        assert_eq!(c.base_tags(), ["event:eks-upgrade".to_string()]);
    }

    #[test]
    fn test_wire_annotation_region_serialization() {
        let time = DateTime::parse_from_rfc3339("2026-07-29T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let end = time + chrono::Duration::seconds(90);
        let tags = vec!["a:1".to_string()];
        let wire = WireAnnotation {
            time: time.timestamp_millis(),
            time_end: Some(end.timestamp_millis()),
            tags: &tags,
            text: "hello",
        };
        let json = serde_json::to_value(&wire).unwrap();
        // Epoch milliseconds, which is the unit the Grafana API expects.
        assert_eq!(json["time"], 1_785_319_200_000_i64);
        assert_eq!(json["timeEnd"], 1_785_319_290_000_i64);
        assert_eq!(json["tags"][0], "a:1");
        assert_eq!(json["text"], "hello");
    }

    #[test]
    fn test_wire_annotation_point_omits_time_end() {
        let tags: Vec<String> = vec![];
        let wire = WireAnnotation {
            time: 1,
            time_end: None,
            tags: &tags,
            text: "point",
        };
        let json = serde_json::to_value(&wire).unwrap();
        assert!(json.get("timeEnd").is_none());
    }

    #[test]
    fn test_is_permission_denied_only_for_401_and_403() {
        let status = |code: u16| Error::Status {
            endpoint: "http://grafana:3000/api/annotations".to_string(),
            status: reqwest::StatusCode::from_u16(code).unwrap(),
            body: "denied".to_string(),
        };
        assert_eq!(status(403).status_code(), Some(403));
        assert!(status(401).is_permission_denied());
        assert!(status(403).is_permission_denied());
        assert!(!status(404).is_permission_denied());
        assert!(!status(500).is_permission_denied());
    }

    #[test]
    fn test_status_error_message_names_endpoint_and_status() {
        let err = Error::Status {
            endpoint: "http://grafana:3000/api/annotations".to_string(),
            status: reqwest::StatusCode::FORBIDDEN,
            body: "annotations:create required".to_string(),
        };
        let msg = err.to_string();
        assert!(msg.contains("403"));
        assert!(msg.contains("/api/annotations"));
        assert!(msg.contains("annotations:create required"));
    }

    #[test]
    fn test_truncate_respects_limit_and_char_boundaries() {
        assert_eq!(truncate("short", 512), "short");
        assert_eq!(truncate("abcdef", 3), "abc");
        // A 3-byte character straddling the limit is dropped whole rather than
        // sliced into invalid UTF-8.
        assert_eq!(truncate("가나다", 4), "가");
    }

    /// A stub Grafana serving a fixed status, capturing what it was sent.
    ///
    /// Exercising the real request path is the only way to confirm the wire
    /// contract this module promises: bearer auth on both endpoints, epoch
    /// milliseconds in the body, and base tags merged ahead of per-annotation
    /// ones.
    struct StubGrafana {
        port: u16,
        received: std::sync::Arc<tokio::sync::Mutex<Vec<(String, serde_json::Value)>>>,
    }

    impl StubGrafana {
        async fn start(status: u16) -> Self {
            use axum::extract::State;
            use axum::http::HeaderMap;
            use axum::routing::{get, post};

            type Captured = std::sync::Arc<tokio::sync::Mutex<Vec<(String, serde_json::Value)>>>;

            let received: Captured = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
            let code = axum::http::StatusCode::from_u16(status).unwrap();

            let annotations = {
                let received = received.clone();
                move |headers: HeaderMap, body: String| async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or_default()
                        .to_string();
                    let json = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                    received.lock().await.push((auth, json));
                    (code, "denied")
                }
            };

            let app = axum::Router::new()
                .route("/api/annotations", post(annotations))
                .route(
                    "/api/health",
                    get(|State(code): State<axum::http::StatusCode>| async move {
                        (code, "{\"database\":\"ok\"}")
                    }),
                )
                .with_state(code);

            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });

            Self { port, received }
        }

        fn client(&self) -> Client {
            Client::new(
                &format!("http://127.0.0.1:{}", self.port),
                SecretString::from("s3cr3t"),
                vec!["event:eks-upgrade".to_string()],
            )
            .unwrap()
        }
    }

    fn annotation() -> Annotation {
        let time = DateTime::parse_from_rfc3339("2026-07-29T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        Annotation {
            text: "phase started".to_string(),
            tags: vec!["phase:Planning".to_string()],
            time,
            time_end: None,
        }
    }

    #[tokio::test]
    async fn test_post_sends_bearer_auth_and_merged_tags() {
        let stub = StubGrafana::start(200).await;
        stub.client().post(&annotation()).await.unwrap();

        let (auth, body) = {
            let received = stub.received.lock().await;
            received.first().cloned().unwrap()
        };
        assert_eq!(auth, "Bearer s3cr3t");
        assert_eq!(body["text"], "phase started");
        assert_eq!(body["time"], 1_785_319_200_000_i64);
        assert!(body.get("timeEnd").is_none());
        // Base tags come first, then the annotation's own.
        assert_eq!(body["tags"][0], "event:eks-upgrade");
        assert_eq!(body["tags"][1], "phase:Planning");
    }

    #[tokio::test]
    async fn test_post_forbidden_is_a_permission_error() {
        let stub = StubGrafana::start(403).await;
        let err = stub.client().post(&annotation()).await.unwrap_err();
        assert!(err.is_permission_denied());
        assert!(err.to_string().contains("denied"));
    }

    #[tokio::test]
    async fn test_post_server_error_is_not_a_permission_error() {
        let stub = StubGrafana::start(500).await;
        let err = stub.client().post(&annotation()).await.unwrap_err();
        assert!(!err.is_permission_denied());
    }

    #[tokio::test]
    async fn test_preflight_succeeds_against_a_healthy_grafana() {
        let stub = StubGrafana::start(200).await;
        let status = stub.client().preflight().await.unwrap();
        assert_eq!(status, 200);
    }

    #[tokio::test]
    async fn test_preflight_unauthorized_is_a_permission_error() {
        let stub = StubGrafana::start(401).await;
        let err = stub.client().preflight().await.unwrap_err();
        assert!(err.is_permission_denied());
    }

    #[tokio::test]
    async fn test_a_slow_grafana_is_classified_as_a_timeout() {
        // Proves REQUEST_TIMEOUT is actually applied and that the resulting
        // error is what the caller's retry predicate keys off. Costs one
        // REQUEST_TIMEOUT of wall clock, which is why only one test does it.
        let app = axum::Router::new().route(
            "/api/annotations",
            axum::routing::post(|| async {
                tokio::time::sleep(REQUEST_TIMEOUT + Duration::from_secs(2)).await;
                "never returned in time"
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = Client::new(
            &format!("http://127.0.0.1:{port}"),
            SecretString::from("t"),
            vec![],
        )
        .unwrap();
        let err = client.post(&annotation()).await.unwrap_err();
        assert!(err.is_timeout());
        assert!(!err.is_permission_denied());
    }

    #[tokio::test]
    async fn test_a_status_error_is_never_a_timeout() {
        let stub = StubGrafana::start(500).await;
        let err = stub.client().post(&annotation()).await.unwrap_err();
        assert!(!err.is_timeout());
        assert!(!err.is_unreachable());
    }

    #[tokio::test]
    async fn test_transport_failure_is_reported_with_its_endpoint() {
        // Port 1 on loopback has nothing listening, so the connection is
        // refused before any status exists.
        let client = Client::new("http://127.0.0.1:1", SecretString::from("t"), vec![]).unwrap();
        let err = client.post(&annotation()).await.unwrap_err();
        assert!(!err.is_permission_denied());
        assert!(!err.is_timeout());
        // A refused connection is a reachability problem, not a Grafana one,
        // and carries no HTTP status because no response ever arrived.
        assert!(err.is_unreachable());
        assert_eq!(err.status_code(), None);
        assert!(
            err.to_string()
                .contains("http://127.0.0.1:1/api/annotations")
        );
    }
}
