//! Workload controller promotion and readiness checks.
//!
//! When a node is replaced, kuo waits for the controllers that owned the
//! evicted pods to recover before touching the next node. This module promotes
//! pods to their top-level owning controller (deduplicated) and judges whether
//! each controller is stable again.
//!
//! Readiness judgements are pure and unit-tested against constructed objects.
//! The API wrappers that fetch live controllers are exercised against a cluster.

use std::collections::BTreeSet;

use anyhow::Result;
use k8s_openapi::api::apps::v1::{DaemonSet, Deployment, ReplicaSet, StatefulSet};
use k8s_openapi::api::core::v1::Pod;
use kube::Api;

use crate::error::KuoError;

/// A top-level workload controller identity.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ControllerRef {
    pub kind: String,
    pub namespace: String,
    pub name: String,
}

/// Return the controlling `ownerReference` of a pod, if any.
///
/// Only the reference with `controller: true` is considered. Pods with no
/// controller (static pods, bare pods) return `None` and are skipped by the
/// caller.
#[must_use]
pub fn controller_owner(pod: &Pod) -> Option<ControllerRef> {
    let namespace = pod.metadata.namespace.clone().unwrap_or_default();
    pod.metadata
        .owner_references
        .as_ref()?
        .iter()
        .find(|o| o.controller == Some(true))
        .map(|o| ControllerRef {
            kind: o.kind.clone(),
            namespace: namespace.clone(),
            name: o.name.clone(),
        })
}

/// Deduplicate a set of controller references, sorted for deterministic output.
#[must_use]
pub fn dedup(refs: impl IntoIterator<Item = ControllerRef>) -> Vec<ControllerRef> {
    let set: BTreeSet<ControllerRef> = refs.into_iter().collect();
    set.into_iter().collect()
}

/// Whether a Deployment has fully rolled out: ready replicas meet the desired
/// count and the controller has observed the current generation.
#[must_use]
pub fn deployment_ready(dep: &Deployment) -> bool {
    let desired = dep.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let Some(status) = &dep.status else {
        return false;
    };
    let ready = status.ready_replicas.unwrap_or(0);
    let observed = status.observed_generation.unwrap_or(0);
    let generation = dep.metadata.generation.unwrap_or(0);
    ready >= desired && observed >= generation
}

/// Whether a `StatefulSet` has fully rolled out.
#[must_use]
pub fn statefulset_ready(sts: &StatefulSet) -> bool {
    let desired = sts.spec.as_ref().and_then(|s| s.replicas).unwrap_or(1);
    let Some(status) = &sts.status else {
        return false;
    };
    let ready = status.ready_replicas.unwrap_or(0);
    let observed = status.observed_generation.unwrap_or(0);
    let generation = sts.metadata.generation.unwrap_or(0);
    ready >= desired && observed >= generation
}

/// Whether a `DaemonSet` is fully scheduled and Ready.
#[must_use]
pub fn daemonset_ready(ds: &DaemonSet) -> bool {
    let Some(status) = &ds.status else {
        return false;
    };
    let observed = status.observed_generation.unwrap_or(0);
    let generation = ds.metadata.generation.unwrap_or(0);
    status.number_ready >= status.desired_number_scheduled && observed >= generation
}

/// Resolve pod owners to their top-level controllers, deduplicated.
///
/// A pod owned by a `ReplicaSet` is promoted to the `ReplicaSet`'s owning
/// Deployment. `StatefulSets`, `DaemonSets`, and standalone `ReplicaSets` are kept as
/// is. Pods with no controller are skipped.
pub async fn resolve_controllers(
    client: &kube::Client,
    pods: &[Pod],
) -> Result<Vec<ControllerRef>> {
    let mut resolved = Vec::new();
    for pod in pods {
        let Some(owner) = controller_owner(pod) else {
            continue;
        };
        if owner.kind == "ReplicaSet" {
            let rs_api: Api<ReplicaSet> = Api::namespaced(client.clone(), &owner.namespace);
            if let Some(rs) = rs_api.get_opt(&owner.name).await.map_err(|e| {
                KuoError::KubernetesApi(format!("Failed to get replicaset {}: {e}", owner.name))
            })? && let Some(dep) = rs
                .metadata
                .owner_references
                .as_ref()
                .and_then(|o| o.iter().find(|r| r.controller == Some(true)))
            {
                resolved.push(ControllerRef {
                    kind: dep.kind.clone(),
                    namespace: owner.namespace.clone(),
                    name: dep.name.clone(),
                });
                continue;
            }
        }
        resolved.push(owner);
    }
    Ok(dedup(resolved))
}

/// Return the subset of controllers that are NOT yet stable.
///
/// Unknown kinds are treated as stable (kuo cannot judge them and will not
/// block on them). Fetch failures propagate as errors.
pub async fn unstable_controllers(
    client: &kube::Client,
    controllers: &[ControllerRef],
) -> Result<Vec<ControllerRef>> {
    let mut unstable = Vec::new();
    for c in controllers {
        let ready = match c.kind.as_str() {
            "Deployment" => {
                let api: Api<Deployment> = Api::namespaced(client.clone(), &c.namespace);
                api.get_opt(&c.name)
                    .await
                    .map_err(map_get_err(c))?
                    .as_ref()
                    .is_some_and(deployment_ready)
            }
            "StatefulSet" => {
                let api: Api<StatefulSet> = Api::namespaced(client.clone(), &c.namespace);
                api.get_opt(&c.name)
                    .await
                    .map_err(map_get_err(c))?
                    .as_ref()
                    .is_some_and(statefulset_ready)
            }
            "DaemonSet" => {
                let api: Api<DaemonSet> = Api::namespaced(client.clone(), &c.namespace);
                api.get_opt(&c.name)
                    .await
                    .map_err(map_get_err(c))?
                    .as_ref()
                    .is_some_and(daemonset_ready)
            }
            _ => true,
        };
        if !ready {
            unstable.push(c.clone());
        }
    }
    Ok(unstable)
}

fn map_get_err(c: &ControllerRef) -> impl Fn(kube::Error) -> anyhow::Error {
    let kind = c.kind.clone();
    let name = c.name.clone();
    move |e| KuoError::KubernetesApi(format!("Failed to get {kind} {name}: {e}")).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use k8s_openapi::api::apps::v1::{
        DaemonSetStatus, DeploymentSpec, DeploymentStatus, StatefulSetSpec, StatefulSetStatus,
    };
    use k8s_openapi::apimachinery::pkg::apis::meta::v1::OwnerReference;
    use kube::api::ObjectMeta;

    fn pod_with_owner(kind: &str, name: &str, controller: bool) -> Pod {
        Pod {
            metadata: ObjectMeta {
                namespace: Some("default".to_string()),
                owner_references: Some(vec![OwnerReference {
                    api_version: "apps/v1".to_string(),
                    kind: kind.to_string(),
                    name: name.to_string(),
                    uid: "uid".to_string(),
                    controller: Some(controller),
                    block_owner_deletion: None,
                }]),
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn test_controller_owner_present() {
        let pod = pod_with_owner("ReplicaSet", "web-abc", true);
        let owner = controller_owner(&pod).unwrap();
        assert_eq!(owner.kind, "ReplicaSet");
        assert_eq!(owner.name, "web-abc");
        assert_eq!(owner.namespace, "default");
    }

    #[test]
    fn test_controller_owner_none_for_bare_pod() {
        let pod = Pod::default();
        assert!(controller_owner(&pod).is_none());
    }

    #[test]
    fn test_controller_owner_ignores_non_controller_ref() {
        let pod = pod_with_owner("ReplicaSet", "web-abc", false);
        assert!(controller_owner(&pod).is_none());
    }

    #[test]
    fn test_dedup_collapses_same_controller() {
        let refs = vec![
            ControllerRef {
                kind: "Deployment".to_string(),
                namespace: "default".to_string(),
                name: "web".to_string(),
            },
            ControllerRef {
                kind: "Deployment".to_string(),
                namespace: "default".to_string(),
                name: "web".to_string(),
            },
            ControllerRef {
                kind: "StatefulSet".to_string(),
                namespace: "default".to_string(),
                name: "db".to_string(),
            },
        ];
        assert_eq!(dedup(refs).len(), 2);
    }

    #[test]
    fn test_deployment_ready_true() {
        let dep = Deployment {
            metadata: ObjectMeta {
                generation: Some(3),
                ..Default::default()
            },
            spec: Some(DeploymentSpec {
                replicas: Some(3),
                ..Default::default()
            }),
            status: Some(DeploymentStatus {
                ready_replicas: Some(3),
                observed_generation: Some(3),
                ..Default::default()
            }),
        };
        assert!(deployment_ready(&dep));
    }

    #[test]
    fn test_deployment_not_ready_when_replicas_short() {
        let dep = Deployment {
            metadata: ObjectMeta {
                generation: Some(3),
                ..Default::default()
            },
            spec: Some(DeploymentSpec {
                replicas: Some(3),
                ..Default::default()
            }),
            status: Some(DeploymentStatus {
                ready_replicas: Some(2),
                observed_generation: Some(3),
                ..Default::default()
            }),
        };
        assert!(!deployment_ready(&dep));
    }

    #[test]
    fn test_deployment_not_ready_when_generation_stale() {
        let dep = Deployment {
            metadata: ObjectMeta {
                generation: Some(4),
                ..Default::default()
            },
            spec: Some(DeploymentSpec {
                replicas: Some(1),
                ..Default::default()
            }),
            status: Some(DeploymentStatus {
                ready_replicas: Some(1),
                observed_generation: Some(3),
                ..Default::default()
            }),
        };
        assert!(!deployment_ready(&dep));
    }

    #[test]
    fn test_statefulset_ready() {
        let sts = StatefulSet {
            metadata: ObjectMeta {
                generation: Some(1),
                ..Default::default()
            },
            spec: Some(StatefulSetSpec {
                replicas: Some(2),
                ..Default::default()
            }),
            status: Some(StatefulSetStatus {
                ready_replicas: Some(2),
                observed_generation: Some(1),
                ..Default::default()
            }),
        };
        assert!(statefulset_ready(&sts));
    }

    #[test]
    fn test_daemonset_ready() {
        let ds = DaemonSet {
            metadata: ObjectMeta {
                generation: Some(2),
                ..Default::default()
            },
            status: Some(DaemonSetStatus {
                number_ready: 5,
                desired_number_scheduled: 5,
                observed_generation: Some(2),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(daemonset_ready(&ds));
    }

    #[test]
    fn test_deployment_not_ready_without_status() {
        let dep = Deployment {
            metadata: ObjectMeta::default(),
            spec: Some(DeploymentSpec {
                replicas: Some(1),
                ..Default::default()
            }),
            status: None,
        };
        assert!(!deployment_ready(&dep));
    }

    #[test]
    fn test_deployment_ready_default_replicas() {
        // spec.replicas None defaults to 1.
        let dep = Deployment {
            metadata: ObjectMeta {
                generation: Some(1),
                ..Default::default()
            },
            spec: Some(DeploymentSpec::default()),
            status: Some(DeploymentStatus {
                ready_replicas: Some(1),
                observed_generation: Some(1),
                ..Default::default()
            }),
        };
        assert!(deployment_ready(&dep));
    }

    #[test]
    fn test_statefulset_not_ready_without_status() {
        let sts = StatefulSet {
            metadata: ObjectMeta::default(),
            spec: Some(StatefulSetSpec {
                replicas: Some(2),
                ..Default::default()
            }),
            status: None,
        };
        assert!(!statefulset_ready(&sts));
    }

    #[test]
    fn test_statefulset_not_ready_short_replicas() {
        let sts = StatefulSet {
            metadata: ObjectMeta {
                generation: Some(1),
                ..Default::default()
            },
            spec: Some(StatefulSetSpec {
                replicas: Some(3),
                ..Default::default()
            }),
            status: Some(StatefulSetStatus {
                ready_replicas: Some(1),
                observed_generation: Some(1),
                ..Default::default()
            }),
        };
        assert!(!statefulset_ready(&sts));
    }

    #[test]
    fn test_daemonset_not_ready_without_status() {
        assert!(!daemonset_ready(&DaemonSet::default()));
    }

    #[test]
    fn test_statefulset_ready_default_replicas() {
        // spec.replicas None defaults to 1.
        let sts = StatefulSet {
            metadata: ObjectMeta {
                generation: Some(1),
                ..Default::default()
            },
            spec: Some(StatefulSetSpec::default()),
            status: Some(StatefulSetStatus {
                ready_replicas: Some(1),
                observed_generation: Some(1),
                ..Default::default()
            }),
        };
        assert!(statefulset_ready(&sts));
    }

    #[test]
    fn test_daemonset_not_ready_stale_generation() {
        let ds = DaemonSet {
            metadata: ObjectMeta {
                generation: Some(5),
                ..Default::default()
            },
            status: Some(DaemonSetStatus {
                number_ready: 3,
                desired_number_scheduled: 3,
                observed_generation: Some(4),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(!daemonset_ready(&ds));
    }

    #[test]
    fn test_daemonset_not_ready() {
        let ds = DaemonSet {
            metadata: ObjectMeta {
                generation: Some(2),
                ..Default::default()
            },
            status: Some(DaemonSetStatus {
                number_ready: 3,
                desired_number_scheduled: 5,
                observed_generation: Some(2),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(!daemonset_ready(&ds));
    }
}
