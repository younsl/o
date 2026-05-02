use std::sync::Arc;

use k8s_openapi::api::coordination::v1::{Lease, LeaseSpec};
use k8s_openapi::apimachinery::pkg::apis::meta::v1::{MicroTime, ObjectMeta};
use kube::Client;
use kube::api::{Api, Patch, PatchParams, PostParams};
use tokio::sync::{Notify, RwLock};

use crate::config::LeaderElectionConfig;

/// Manages leader election via Kubernetes Lease resources.
pub struct LeaderElector {
    api: Api<Lease>,
    config: LeaderElectionConfig,
    identity: String,
    is_leader: Arc<RwLock<bool>>,
    leader_notify: Arc<Notify>,
}

impl LeaderElector {
    pub async fn new(
        config: LeaderElectionConfig,
        is_leader: Arc<RwLock<bool>>,
        leader_notify: Arc<Notify>,
    ) -> Result<Self, String> {
        let client = Client::try_default().await.map_err(|e| e.to_string())?;
        let api: Api<Lease> = Api::namespaced(client, &config.lease_namespace);

        let identity = std::env::var("POD_NAME").unwrap_or_else(|_| {
            let id = &simple_id()[..8];
            format!("adie-{id}")
        });

        tracing::info!(
            identity = %identity,
            lease_name = %config.lease_name,
            lease_namespace = %config.lease_namespace,
            "Initialized leader election"
        );

        Ok(Self {
            api,
            config,
            identity,
            is_leader,
            leader_notify,
        })
    }

    /// Run the leader election loop. Blocks until shutdown.
    pub async fn run(&self) {
        loop {
            match self.try_acquire_or_renew().await {
                Ok(true) => {
                    let mut leader = self.is_leader.write().await;
                    if !*leader {
                        *leader = true;
                        tracing::info!(identity = %self.identity, "Acquired leadership");
                        self.leader_notify.notify_waiters();
                    }
                }
                Ok(false) => {
                    let mut leader = self.is_leader.write().await;
                    if *leader {
                        *leader = false;
                        tracing::warn!(identity = %self.identity, "Lost leadership");
                    }
                    tracing::debug!(identity = %self.identity, "Waiting for leadership");
                }
                Err(e) => {
                    tracing::warn!(identity = %self.identity, error = %e, "Leader election encountered an error");
                }
            }

            tokio::time::sleep(std::time::Duration::from_secs(
                self.config.retry_period_seconds,
            ))
            .await;
        }
    }

    /// Release the lease explicitly on graceful shutdown.
    pub async fn release(&self) {
        if !*self.is_leader.read().await {
            return;
        }

        tracing::info!(
            identity = %self.identity,
            lease_name = %self.config.lease_name,
            lease_namespace = %self.config.lease_namespace,
            "Releasing leadership before shutdown"
        );

        let now = now_micro_time();
        let lease = Lease {
            metadata: ObjectMeta {
                name: Some(self.config.lease_name.clone()),
                namespace: Some(self.config.lease_namespace.clone()),
                ..Default::default()
            },
            spec: Some(LeaseSpec {
                holder_identity: None,
                acquire_time: None,
                renew_time: Some(now),
                lease_duration_seconds: Some(0),
                lease_transitions: None,
                ..Default::default()
            }),
        };

        match self
            .api
            .patch(
                &self.config.lease_name,
                &PatchParams::apply("aurora-database-insights-exporter").force(),
                &Patch::Apply(lease),
            )
            .await
        {
            Ok(_) => {
                *self.is_leader.write().await = false;
                tracing::info!(identity = %self.identity, "Leadership released successfully");
            }
            Err(e) => {
                tracing::warn!(
                    identity = %self.identity,
                    error = %e.to_string(),
                    "Failed to release leadership"
                );
            }
        }
    }

    async fn try_acquire_or_renew(&self) -> Result<bool, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        let lease_name = &self.config.lease_name;

        match self.api.get(lease_name).await {
            Ok(lease) => {
                let spec = lease.spec.as_ref();
                let holder = spec
                    .and_then(|s| s.holder_identity.as_deref())
                    .unwrap_or("");
                let duration_secs =
                    spec.and_then(|s| s.lease_duration_seconds).unwrap_or(15) as i64;

                if holder == self.identity {
                    self.renew_lease(lease_name).await?;
                    return Ok(true);
                }

                // Check if expired by comparing renew_time + duration vs now
                let renew_epoch: i64 = spec
                    .and_then(|s| s.renew_time.as_ref())
                    .map(|t| t.0.as_second())
                    .unwrap_or(0);

                if renew_epoch > 0 && now < renew_epoch + duration_secs {
                    // Lease still valid
                    return Ok(false);
                }

                // Expired — acquire
                let transitions = spec.and_then(|s| s.lease_transitions).unwrap_or(0);
                self.acquire_lease(lease_name, transitions + 1).await?;
                Ok(true)
            }
            Err(kube::Error::Api(err)) if err.code == 404 => {
                self.create_lease(lease_name).await?;
                Ok(true)
            }
            Err(e) => Err(e.to_string()),
        }
    }

    async fn create_lease(&self, name: &str) -> Result<(), String> {
        let now = now_micro_time();
        let lease = Lease {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some(self.config.lease_namespace.clone()),
                ..Default::default()
            },
            spec: Some(LeaseSpec {
                holder_identity: Some(self.identity.clone()),
                lease_duration_seconds: Some(self.config.lease_duration_seconds as i32),
                acquire_time: Some(now.clone()),
                renew_time: Some(now),
                lease_transitions: Some(0),
                ..Default::default()
            }),
        };

        self.api
            .create(&PostParams::default(), &lease)
            .await
            .map_err(|e| e.to_string())?;

        tracing::info!(identity = %self.identity, lease = name, namespace = %self.config.lease_namespace, "Created new lease");
        Ok(())
    }

    async fn renew_lease(&self, name: &str) -> Result<(), String> {
        let now = now_micro_time();
        let lease = Lease {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some(self.config.lease_namespace.clone()),
                ..Default::default()
            },
            spec: Some(LeaseSpec {
                holder_identity: Some(self.identity.clone()),
                renew_time: Some(now),
                lease_duration_seconds: Some(self.config.lease_duration_seconds as i32),
                ..Default::default()
            }),
        };

        self.api
            .patch(
                name,
                &PatchParams::apply("aurora-database-insights-exporter").force(),
                &Patch::Apply(lease),
            )
            .await
            .map_err(|e| e.to_string())?;

        tracing::debug!(identity = %self.identity, "Lease renewed");
        Ok(())
    }

    async fn acquire_lease(&self, name: &str, transitions: i32) -> Result<(), String> {
        let now = now_micro_time();
        let lease = Lease {
            metadata: ObjectMeta {
                name: Some(name.to_string()),
                namespace: Some(self.config.lease_namespace.clone()),
                ..Default::default()
            },
            spec: Some(LeaseSpec {
                holder_identity: Some(self.identity.clone()),
                acquire_time: Some(now.clone()),
                renew_time: Some(now),
                lease_duration_seconds: Some(self.config.lease_duration_seconds as i32),
                lease_transitions: Some(transitions),
                ..Default::default()
            }),
        };

        self.api
            .patch(
                name,
                &PatchParams::apply("aurora-database-insights-exporter").force(),
                &Patch::Apply(lease),
            )
            .await
            .map_err(|e| e.to_string())?;

        tracing::info!(identity = %self.identity, transitions, lease = name, namespace = %self.config.lease_namespace, "Acquired expired lease");
        Ok(())
    }
}

fn now_micro_time() -> MicroTime {
    let ts = k8s_openapi::jiff::Timestamp::now();
    MicroTime(ts)
}

/// Generate a simple random hex string for fallback identity.
fn simple_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{nanos:x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_simple_id_not_empty() {
        let id = simple_id();
        assert!(!id.is_empty());
        assert!(id.len() >= 8);
    }

    #[test]
    fn test_simple_id_unique() {
        let a = simple_id();
        std::thread::sleep(std::time::Duration::from_millis(1));
        let b = simple_id();
        assert_ne!(a, b);
    }

    #[test]
    fn test_now_micro_time() {
        let mt = now_micro_time();
        // Should be a non-zero timestamp
        assert!(mt.0.as_second() > 0);
    }
}
