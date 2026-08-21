//! MCP server exposing kuo's upgrade knowledge to kagent agents.
//!
//! A third HTTP listener beside health and metrics serves the Model Context
//! Protocol over stateless streamable HTTP. Read tools project the
//! `EKSUpgrade` state, the EKS API, and the target cluster into
//! verdict-shaped answers an agent can branch on; mutating tools only ever
//! patch `EKSUpgrade` resources, never AWS, so the controller stays the
//! single actor. Design: `docs/designs/kagent-mcp-server.md`.

pub mod auth;
pub mod cache;
pub mod metrics;
pub mod result;
pub mod server;
pub mod tools;

use std::path::PathBuf;

use anyhow::{Context, Result, bail};

/// Default MCP listener port.
const DEFAULT_PORT: u16 = 8082;

/// Default TTL for the AWS read cache, in seconds.
const DEFAULT_CACHE_TTL_SECONDS: u64 = 30;

/// MCP server configuration, read once at process start.
#[derive(Clone, Debug)]
pub struct Config {
    /// Listener port.
    pub port: u16,
    /// Path of the mounted bearer token file, read per request so a rotated
    /// Secret takes effect without a Pod restart.
    pub token_file: PathBuf,
    /// TTL of the AWS read cache.
    pub cache_ttl: std::time::Duration,
}

impl Config {
    /// Read the configuration from the environment.
    ///
    /// Returns `Ok(None)` when `MCP_ENABLED` is unset or false. A missing
    /// `MCP_TOKEN_FILE` while enabled is an error rather than a degraded
    /// mode: mutating tools are always registered, so an unauthenticated
    /// endpoint is never acceptable.
    pub fn from_env() -> Result<Option<Self>> {
        Self::from_lookup(|key| {
            std::env::var(key)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
    }

    /// The environment-independent core of [`Self::from_env`], taking the
    /// variable lookup as a function so tests need no process-global state.
    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Option<Self>> {
        if !flag(&lookup, "MCP_ENABLED")? {
            return Ok(None);
        }

        let Some(token_file) = lookup("MCP_TOKEN_FILE") else {
            bail!(
                "MCP_ENABLED is set but MCP_TOKEN_FILE is empty. The MCP endpoint refuses to start without a bearer token because mutating tools are always registered"
            );
        };

        let port = match lookup("MCP_PORT") {
            None => DEFAULT_PORT,
            Some(raw) => raw
                .parse::<u16>()
                .with_context(|| format!("MCP_PORT must be a port number, got {raw:?}"))?,
        };

        let cache_ttl = match lookup("MCP_CACHE_TTL_SECONDS") {
            None => std::time::Duration::from_secs(DEFAULT_CACHE_TTL_SECONDS),
            Some(raw) => std::time::Duration::from_secs(raw.parse::<u64>().with_context(|| {
                format!("MCP_CACHE_TTL_SECONDS must be a number of seconds, got {raw:?}")
            })?),
        };

        Ok(Some(Self {
            port,
            token_file: PathBuf::from(token_file),
            cache_ttl,
        }))
    }
}

/// Read a boolean variable through the lookup, defaulting to false when unset.
///
/// An unrecognised value is an error rather than a false, matching the
/// Grafana annotation config: a typo that silently disabled the endpoint
/// would look identical to a deliberate opt-out.
fn flag(lookup: impl Fn(&str) -> Option<String>, key: &str) -> Result<bool> {
    match lookup(key) {
        None => Ok(false),
        Some(raw) => match raw.to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Ok(true),
            "false" | "0" | "no" => Ok(false),
            other => bail!("{key} must be a boolean, got {other:?}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup_from(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |key: &str| map.get(key).cloned()
    }

    #[test]
    fn test_disabled_when_unset() {
        let config = Config::from_lookup(lookup_from(&[])).unwrap();
        assert!(config.is_none());
    }

    #[test]
    fn test_disabled_when_false() {
        let config = Config::from_lookup(lookup_from(&[("MCP_ENABLED", "false")])).unwrap();
        assert!(config.is_none());
    }

    #[test]
    fn test_enabled_without_token_is_fatal() {
        let result = Config::from_lookup(lookup_from(&[("MCP_ENABLED", "true")]));
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("MCP_TOKEN_FILE"));
    }

    #[test]
    fn test_enabled_with_defaults() {
        let config = Config::from_lookup(lookup_from(&[
            ("MCP_ENABLED", "true"),
            ("MCP_TOKEN_FILE", "/var/run/secrets/kuo-mcp/token"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(config.port, DEFAULT_PORT);
        assert_eq!(
            config.token_file,
            PathBuf::from("/var/run/secrets/kuo-mcp/token")
        );
        assert_eq!(
            config.cache_ttl,
            std::time::Duration::from_secs(DEFAULT_CACHE_TTL_SECONDS)
        );
    }

    #[test]
    fn test_cache_ttl_override() {
        let config = Config::from_lookup(lookup_from(&[
            ("MCP_ENABLED", "true"),
            ("MCP_TOKEN_FILE", "/t"),
            ("MCP_CACHE_TTL_SECONDS", "5"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(config.cache_ttl, std::time::Duration::from_secs(5));
    }

    #[test]
    fn test_port_override() {
        let config = Config::from_lookup(lookup_from(&[
            ("MCP_ENABLED", "1"),
            ("MCP_TOKEN_FILE", "/t"),
            ("MCP_PORT", "9090"),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(config.port, 9090);
    }

    #[test]
    fn test_invalid_port_is_error() {
        let result = Config::from_lookup(lookup_from(&[
            ("MCP_ENABLED", "true"),
            ("MCP_TOKEN_FILE", "/t"),
            ("MCP_PORT", "not-a-port"),
        ]));
        assert!(result.is_err());
    }

    #[test]
    fn test_invalid_boolean_is_error_not_disabled() {
        let result = Config::from_lookup(lookup_from(&[("MCP_ENABLED", "enable")]));
        assert!(result.is_err());
    }
}
