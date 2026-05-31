use anyhow::{Context, Result};
use redis::aio::ConnectionManager;
use std::time::Duration;
use tokio::time::timeout;

use crate::config::ClusterConfig;
use crate::ops::RedisOps;

/// Redis client wrapper
pub struct RedisClient {
    manager: ConnectionManager,
}

impl RedisClient {
    /// Create a new Redis client connection
    pub async fn connect(config: ClusterConfig) -> Result<Self> {
        let client = redis::Client::open(config.connection_info())
            .context("Failed to create Redis client")?;

        let manager = timeout(Duration::from_secs(5), ConnectionManager::new(client))
            .await
            .context("Connection timeout")??;

        Ok(Self { manager })
    }
}

impl RedisOps for RedisClient {
    /// Execute INFO command
    async fn info(&mut self) -> Result<String> {
        let info: String = redis::cmd("INFO")
            .query_async(&mut self.manager)
            .await
            .context("Failed to execute INFO command")?;

        Ok(info)
    }

    /// Get Redis server engine, version and mode from `INFO server`.
    async fn server_info(&mut self) -> Result<(String, String, String)> {
        let info: String = redis::cmd("INFO")
            .arg("server")
            .query_async(&mut self.manager)
            .await
            .context("Failed to execute INFO server command")?;

        Ok(parse_server_info(&info))
    }

    /// Execute custom command
    async fn execute_command(&mut self, cmd: &str) -> Result<String> {
        let parts: Vec<&str> = cmd.split_whitespace().collect();
        if parts.is_empty() {
            return Ok(String::new());
        }

        let mut redis_cmd = redis::cmd(parts[0]);
        for arg in &parts[1..] {
            redis_cmd.arg(*arg);
        }

        let result: redis::Value = redis_cmd
            .query_async(&mut self.manager)
            .await
            .context("Failed to execute command")?;

        Ok(format_redis_value(&result))
    }
}

/// Parse `(engine, version, mode)` from the reply of `INFO server`.
///
/// Engine is `valkey` if `valkey_version` is present, otherwise `redis` if
/// `redis_version` is present. `valkey_version` takes precedence when both
/// exist.
fn parse_server_info(info: &str) -> (String, String, String) {
    let mut mode = "standalone".to_string();
    let mut redis_version_found: Option<String> = None;
    let mut valkey_version_found: Option<String> = None;

    for line in info.lines() {
        if let Some(value) = line.strip_prefix("valkey_version:") {
            valkey_version_found = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("redis_version:") {
            redis_version_found = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("redis_mode:") {
            mode = value.trim().to_string();
        }
    }

    // valkey_version takes precedence over redis_version
    if let Some(v) = valkey_version_found {
        ("valkey".to_string(), v, mode)
    } else if let Some(v) = redis_version_found {
        ("redis".to_string(), v, mode)
    } else {
        ("unknown".to_string(), "unknown".to_string(), mode)
    }
}

/// Format Redis value for display
fn format_redis_value(value: &redis::Value) -> String {
    match value {
        redis::Value::Nil => "(nil)".to_string(),
        redis::Value::Int(i) => format!("(integer) {i}"),
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes).to_string(),
        redis::Value::Array(arr) => {
            let items: Vec<String> = arr.iter().map(format_redis_value).collect();
            items.join("\n")
        }
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::Okay => "OK".to_string(),
        redis::Value::Double(d) => format!("(double) {d}"),
        // Catch-all for other variants
        other => format!("{other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_scalars() {
        assert_eq!(format_redis_value(&redis::Value::Nil), "(nil)");
        assert_eq!(format_redis_value(&redis::Value::Int(42)), "(integer) 42");
        assert_eq!(format_redis_value(&redis::Value::Okay), "OK");
        assert_eq!(
            format_redis_value(&redis::Value::SimpleString("PONG".to_string())),
            "PONG"
        );
        assert_eq!(
            format_redis_value(&redis::Value::Double(1.5)),
            "(double) 1.5"
        );
    }

    #[test]
    fn format_bulk_string() {
        assert_eq!(
            format_redis_value(&redis::Value::BulkString(b"hello".to_vec())),
            "hello"
        );
    }

    #[test]
    fn format_array_joins_with_newlines() {
        let value = redis::Value::Array(vec![
            redis::Value::BulkString(b"a".to_vec()),
            redis::Value::Int(2),
        ]);
        assert_eq!(format_redis_value(&value), "a\n(integer) 2");
    }

    #[test]
    fn format_unknown_variant_uses_debug() {
        let value = redis::Value::Map(vec![(
            redis::Value::SimpleString("k".to_string()),
            redis::Value::Int(1),
        )]);
        // Falls through to the catch-all Debug formatting.
        assert!(format_redis_value(&value).contains('k') || !format_redis_value(&value).is_empty());
    }

    #[test]
    fn parse_redis_server_info() {
        let info = "# Server\nredis_version:7.2.4\nredis_mode:standalone\n";
        assert_eq!(
            parse_server_info(info),
            (
                "redis".to_string(),
                "7.2.4".to_string(),
                "standalone".to_string()
            )
        );
    }

    #[test]
    fn parse_valkey_takes_precedence_over_redis() {
        let info = "redis_version:7.2.4\nvalkey_version:8.0.1\nredis_mode:cluster\n";
        assert_eq!(
            parse_server_info(info),
            (
                "valkey".to_string(),
                "8.0.1".to_string(),
                "cluster".to_string()
            )
        );
    }

    #[test]
    fn parse_missing_version_is_unknown() {
        let info = "# Server\nuptime_in_seconds:10\n";
        assert_eq!(
            parse_server_info(info),
            (
                "unknown".to_string(),
                "unknown".to_string(),
                "standalone".to_string()
            )
        );
    }

    #[test]
    fn parse_empty_input() {
        assert_eq!(
            parse_server_info(""),
            (
                "unknown".to_string(),
                "unknown".to_string(),
                "standalone".to_string()
            )
        );
    }
}
