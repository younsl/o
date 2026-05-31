//! Abstractions over Redis connectivity.
//!
//! These traits let the REPL dispatch and health-check logic be exercised in
//! tests with in-memory fakes instead of a live Redis server.

use anyhow::Result;

use crate::config::ClusterConfig;
use crate::redis_client::RedisClient;

/// Operations performed against a connected Redis server.
#[allow(async_fn_in_trait)]
pub trait RedisOps {
    /// Run `INFO` and return the raw reply.
    async fn info(&mut self) -> Result<String>;
    /// Return `(engine, version, mode)` parsed from `INFO server`.
    async fn server_info(&mut self) -> Result<(String, String, String)>;
    /// Run an arbitrary Redis command line and return formatted output.
    async fn execute_command(&mut self, cmd: &str) -> Result<String>;
}

/// Establishes connections to clusters.
#[allow(async_fn_in_trait)]
pub trait Connector {
    /// The client type produced by a successful connection.
    type Client: RedisOps;

    /// Connect to the cluster described by `config`.
    async fn connect(&self, config: ClusterConfig) -> Result<Self::Client>;
}

/// Production connector backed by real network connections.
pub struct RealConnector;

impl Connector for RealConnector {
    type Client = RedisClient;

    async fn connect(&self, config: ClusterConfig) -> Result<Self::Client> {
        RedisClient::connect(config).await
    }
}
