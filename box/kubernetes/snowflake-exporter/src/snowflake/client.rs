//! Snowflake SQL API v2 client authenticated with a Programmatic Access Token (PAT).
//!
//! Reference: <https://docs.snowflake.com/en/developer-guide/sql-api/reference>
//!
//! PAT is a user-bound Bearer token created via
//! `ALTER USER ... ADD PROGRAMMATIC ACCESS TOKEN ...`. The SQL API v2 accepts
//! it when the `X-Snowflake-Authorization-Token-Type` header is set to
//! `PROGRAMMATIC_ACCESS_TOKEN`.

use std::path::Path;
use std::time::Duration;

use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};

/// Rows returned by a query. Each inner `Vec<Value>` is one row, column order
/// matches the SELECT list.
pub type Rows = Vec<Vec<Value>>;

/// Thin async client over the Snowflake SQL API v2.
pub struct SnowflakeClient {
    http: reqwest::Client,
    base_url: String,
    token: String,
    role: String,
    warehouse: String,
    database: String,
}

#[derive(Serialize)]
struct StatementRequest<'a> {
    statement: &'a str,
    timeout: u64,
    database: &'a str,
    warehouse: &'a str,
    role: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    schema: Option<&'a str>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct StatementResponse {
    #[serde(default)]
    data: Vec<Vec<Option<String>>>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

impl SnowflakeClient {
    pub fn new(
        account: &str,
        role: String,
        warehouse: String,
        database: String,
        token: String,
        request_timeout: Duration,
    ) -> Result<Self> {
        let http = reqwest::Client::builder()
            .timeout(request_timeout)
            .user_agent(concat!("snowflake-exporter/", env!("CARGO_PKG_VERSION")))
            .build()?;

        Self::with_client(account, role, warehouse, database, token, http)
    }

    /// Construct a client against an explicit base URL (for tests).
    #[cfg(test)]
    pub(crate) fn new_with_base_url(
        base_url: String,
        role: String,
        warehouse: String,
        database: String,
        token: String,
    ) -> Result<Self> {
        let http = reqwest::Client::builder().build()?;
        Ok(Self {
            http,
            base_url,
            token,
            role,
            warehouse,
            database,
        })
    }

    fn with_client(
        account: &str,
        role: String,
        warehouse: String,
        database: String,
        token: String,
        http: reqwest::Client,
    ) -> Result<Self> {
        let base_url = format!("https://{account}.snowflakecomputing.com");
        Ok(Self {
            http,
            base_url,
            token,
            role,
            warehouse,
            database,
        })
    }

    /// Execute a SQL statement and return rows as raw JSON values.
    pub async fn query(&self, sql: &str, query_timeout_seconds: u64) -> Result<Rows> {
        let url = format!("{}/api/v2/statements", self.base_url);

        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", self.token))
                .map_err(|e| Error::Auth(format!("invalid PAT header: {e}")))?,
        );
        headers.insert(
            "X-Snowflake-Authorization-Token-Type",
            HeaderValue::from_static("PROGRAMMATIC_ACCESS_TOKEN"),
        );
        headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let body = StatementRequest {
            statement: sql,
            timeout: query_timeout_seconds,
            database: &self.database,
            warehouse: &self.warehouse,
            role: &self.role,
            schema: None,
        };

        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(Error::Query {
                query: preview(sql),
                message: format!("HTTP {status}: {text}"),
            });
        }

        let payload: StatementResponse = resp.json().await?;

        if let Some(code) = &payload.code
            && payload.data.is_empty()
            && payload.message.is_some()
            && !code.starts_with("090")
        {
            return Err(Error::Query {
                query: preview(sql),
                message: format!(
                    "{code}: {}",
                    payload.message.as_deref().unwrap_or("unknown error")
                ),
            });
        }

        let rows = payload
            .data
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|cell| match cell {
                        Some(s) => Value::String(s),
                        None => Value::Null,
                    })
                    .collect()
            })
            .collect();

        Ok(rows)
    }
}

/// Load a PAT from a file. Trims surrounding whitespace so the token can be
/// stored with or without a trailing newline.
pub fn load_token(path: &Path) -> Result<String> {
    let raw = std::fs::read_to_string(path)?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(Error::Auth(format!(
            "token file {} is empty",
            path.display()
        )));
    }
    Ok(trimmed.to_string())
}

fn preview(sql: &str) -> String {
    sql.chars().take(80).collect::<String>()
}

/// Parse a Snowflake numeric cell (returned as a string) into f64.
pub fn as_f64(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::String(s) => s.parse::<f64>().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

/// Parse a Snowflake string cell, returning an empty string for null.
pub fn as_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn test_as_f64_parses_string_numbers() {
        assert_eq!(as_f64(&Value::String("1.5".to_string())), Some(1.5));
        assert_eq!(as_f64(&Value::String("42".to_string())), Some(42.0));
        assert_eq!(as_f64(&Value::Null), None);
        assert_eq!(as_f64(&Value::String("abc".to_string())), None);
        assert_eq!(as_f64(&Value::Bool(true)), None);
    }

    #[test]
    fn test_as_str_null_returns_empty() {
        assert_eq!(as_str(&Value::Null), "");
        assert_eq!(as_str(&Value::String("x".to_string())), "x");
        assert_eq!(as_str(&Value::Bool(true)), "true");
    }

    #[test]
    fn test_preview_truncates() {
        let sql = "a".repeat(200);
        assert_eq!(preview(&sql).len(), 80);
        assert_eq!(preview("short"), "short");
    }

    #[test]
    fn test_load_token_trims_whitespace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, "  abc123\n").unwrap();
        assert_eq!(load_token(&path).unwrap(), "abc123");
    }

    #[test]
    fn test_load_token_empty_file_fails() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        std::fs::write(&path, "   \n").unwrap();
        match load_token(&path) {
            Err(Error::Auth(_)) => {}
            other => panic!("expected Auth error, got {other:?}"),
        }
    }

    #[test]
    fn test_load_token_missing_file_returns_io_error() {
        match load_token(std::path::Path::new("/nonexistent-pat-file")) {
            Err(Error::Io(_)) => {}
            other => panic!("expected Io error, got {other:?}"),
        }
    }

    fn build_client(base_url: String, token: &str) -> SnowflakeClient {
        SnowflakeClient::new_with_base_url(
            base_url,
            "METRICS_ROLE".to_string(),
            "METRICS_WH".to_string(),
            "SNOWFLAKE".to_string(),
            token.to_string(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn test_query_sends_pat_headers_and_parses_rows() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/statements"))
            .and(header("authorization", "Bearer test-pat"))
            .and(header(
                "x-snowflake-authorization-token-type",
                "PROGRAMMATIC_ACCESS_TOKEN",
            ))
            .and(header("content-type", "application/json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": "090001",
                "data": [["100", "200", "300"]],
            })))
            .mount(&server)
            .await;

        let client = build_client(server.uri(), "test-pat");
        let rows = client.query("SELECT 1", 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].len(), 3);
        assert_eq!(as_f64(&rows[0][0]), Some(100.0));
        assert_eq!(as_f64(&rows[0][1]), Some(200.0));
        assert_eq!(as_f64(&rows[0][2]), Some(300.0));
    }

    #[tokio::test]
    async fn test_query_nulls_become_json_null() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/statements"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": "090001",
                "data": [[null, "ok"]],
            })))
            .mount(&server)
            .await;

        let client = build_client(server.uri(), "test-pat");
        let rows = client.query("SELECT 1", 10).await.unwrap();
        assert!(matches!(rows[0][0], Value::Null));
        assert_eq!(as_str(&rows[0][1]), "ok");
    }

    #[tokio::test]
    async fn test_query_http_error_surfaces_as_query_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/statements"))
            .respond_with(ResponseTemplate::new(401).set_body_string("token expired"))
            .mount(&server)
            .await;

        let client = build_client(server.uri(), "bad-pat");
        match client.query("SELECT 1", 10).await {
            Err(Error::Query { message, .. }) => {
                assert!(message.contains("401"));
                assert!(message.contains("token expired"));
            }
            other => panic!("expected Query error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_query_error_code_with_no_data_fails() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v2/statements"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "code": "002043",
                "message": "SQL compilation error",
                "data": [],
            })))
            .mount(&server)
            .await;

        let client = build_client(server.uri(), "test-pat");
        match client.query("SELECT garbage", 10).await {
            Err(Error::Query { message, .. }) => {
                assert!(message.contains("002043"));
                assert!(message.contains("SQL compilation error"));
            }
            other => panic!("expected Query error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_new_builds_https_url_from_account() {
        let client = SnowflakeClient::new(
            "xy12345.ap-northeast-2.aws",
            "METRICS_ROLE".to_string(),
            "METRICS_WH".to_string(),
            "SNOWFLAKE".to_string(),
            "test-pat".to_string(),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(
            client.base_url,
            "https://xy12345.ap-northeast-2.aws.snowflakecomputing.com"
        );
    }
}
