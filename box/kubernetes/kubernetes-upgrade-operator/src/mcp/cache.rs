//! TTL cache in front of every AWS and target-cluster read.
//!
//! An agent loop retries fast; the reconciler already performs these reads on
//! its own cadence. The cache bounds what an agent can add on top. Keys carry
//! the cluster name so a successful mutation can drop everything known about
//! that cluster, otherwise an agent that promotes an upgrade and immediately
//! re-reads would see the pre-promotion state for up to the TTL.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

/// Cache lookup outcome, reported to metrics by the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Hit,
    Miss,
}

/// A TTL cache keyed by `(tool, cluster, args)`.
pub struct Cache {
    ttl: Duration,
    entries: Mutex<HashMap<String, (Instant, serde_json::Value)>>,
}

impl Cache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// Compose the cache key. The cluster segment is what
    /// [`Self::invalidate_cluster`] matches on.
    fn key(tool: &str, cluster: &str, args: &str) -> String {
        format!("{tool}\u{1f}{cluster}\u{1f}{args}")
    }

    /// Look up a fresh entry.
    pub async fn get(&self, tool: &str, cluster: &str, args: &str) -> Option<serde_json::Value> {
        let key = Self::key(tool, cluster, args);
        let entries = self.entries.lock().await;
        entries
            .get(&key)
            .filter(|(stored, _)| stored.elapsed() < self.ttl)
            .map(|(_, value)| value.clone())
    }

    /// Store a value, stamping it now.
    pub async fn put(&self, tool: &str, cluster: &str, args: &str, value: serde_json::Value) {
        let key = Self::key(tool, cluster, args);
        let mut entries = self.entries.lock().await;
        // Opportunistically shed expired entries so the map cannot grow
        // unboundedly across many clusters and argument shapes.
        entries.retain(|_, (stored, _)| stored.elapsed() < self.ttl);
        entries.insert(key, (Instant::now(), value));
    }

    /// Drop every entry for one cluster. Called after a successful mutation.
    pub async fn invalidate_cluster(&self, cluster: &str) {
        let needle = format!("\u{1f}{cluster}\u{1f}");
        let mut entries = self.entries.lock().await;
        entries.retain(|key, _| !key.contains(&needle));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_get_put_roundtrip() {
        let cache = Cache::new(Duration::from_secs(30));
        assert!(cache.get("t", "c", "a").await.is_none());
        cache.put("t", "c", "a", json!({"n": 1})).await;
        assert_eq!(cache.get("t", "c", "a").await, Some(json!({"n": 1})));
    }

    #[tokio::test]
    async fn test_expiry() {
        let cache = Cache::new(Duration::from_millis(10));
        cache.put("t", "c", "a", json!(1)).await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(cache.get("t", "c", "a").await.is_none());
    }

    #[tokio::test]
    async fn test_invalidate_cluster_is_scoped() {
        let cache = Cache::new(Duration::from_secs(30));
        cache.put("t1", "prod", "a", json!(1)).await;
        cache.put("t2", "prod", "b", json!(2)).await;
        cache.put("t1", "stage", "a", json!(3)).await;

        cache.invalidate_cluster("prod").await;

        assert!(cache.get("t1", "prod", "a").await.is_none());
        assert!(cache.get("t2", "prod", "b").await.is_none());
        assert_eq!(cache.get("t1", "stage", "a").await, Some(json!(3)));
    }

    #[tokio::test]
    async fn test_key_separator_prevents_collisions() {
        let cache = Cache::new(Duration::from_secs(30));
        // "ab"+"c" must not collide with "a"+"bc".
        cache.put("t", "ab", "c", json!(1)).await;
        assert!(cache.get("t", "a", "bc").await.is_none());
    }
}
