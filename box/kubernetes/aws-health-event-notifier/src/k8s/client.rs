//! Emits Kubernetes Events for published AWS Health notifications.
//!
//! Every Event's `involvedObject` points at the notifier's own Pod (resolved
//! from the Downward API), mirroring how node-problem-detector reports against
//! the node it runs on. The client uses in-cluster config — the projected
//! `ServiceAccount` token and CA are read by `kube`, and the token rotation is
//! handled transparently.

use anyhow::Context;
use k8s_openapi::api::authorization::v1::{
    ResourceAttributes, SelfSubjectAccessReview, SelfSubjectAccessReviewSpec,
};
use k8s_openapi::api::core::v1::ObjectReference;
use kube::api::PostParams;
use kube::runtime::events::{Recorder, Reporter};
use kube::{Api, Client};

use crate::error::{AppError, AppResult};
use crate::health::HealthEvent;
use crate::k8s::event;

/// Notifier Pod identity, injected via the Downward API.
pub struct PodIdentity {
    pub name: String,
    pub namespace: String,
    /// `metadata.uid`; optional but lets `kubectl describe pod` match exactly.
    pub uid: Option<String>,
}

pub struct K8sEventClient {
    client: Client,
    namespace: String,
    recorder: Recorder,
    reference: ObjectReference,
}

impl K8sEventClient {
    /// Build the client from in-cluster config and the notifier Pod identity.
    pub async fn connect(pod: PodIdentity) -> anyhow::Result<Self> {
        let client = Client::try_default()
            .await
            .context("build in-cluster kube client (is this running inside a pod?)")?;

        let reporter = Reporter {
            controller: env!("CARGO_PKG_NAME").into(),
            instance: Some(pod.name.clone()),
        };
        let recorder = Recorder::new(client.clone(), reporter);

        let reference = ObjectReference {
            api_version: Some("v1".into()),
            kind: Some("Pod".into()),
            name: Some(pod.name),
            namespace: Some(pod.namespace.clone()),
            uid: pod.uid,
            ..Default::default()
        };

        Ok(Self {
            client,
            namespace: pod.namespace,
            recorder,
            reference,
        })
    }

    /// Preflight RBAC check: may this `ServiceAccount` `create` Kubernetes
    /// Events in its namespace? Uses `SelfSubjectAccessReview`, which any authenticated
    /// identity may submit without extra permissions. `Ok(false)` means the
    /// RBAC is missing; `Err` means the check itself could not be performed.
    pub async fn can_create_events(&self) -> anyhow::Result<bool> {
        let review = SelfSubjectAccessReview {
            spec: SelfSubjectAccessReviewSpec {
                resource_attributes: Some(ResourceAttributes {
                    namespace: Some(self.namespace.clone()),
                    verb: Some("create".into()),
                    group: Some("events.k8s.io".into()),
                    resource: Some("events".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
            ..Default::default()
        };
        let api: Api<SelfSubjectAccessReview> = Api::all(self.client.clone());
        let resp = api
            .create(&PostParams::default(), &review)
            .await
            .context("SelfSubjectAccessReview request failed")?;
        Ok(resp.status.is_some_and(|s| s.allowed))
    }

    /// Publish a Kubernetes Event for the given Health event.
    pub async fn emit(
        &self,
        event: &HealthEvent,
        reminder_offset_hours: Option<u32>,
    ) -> AppResult<()> {
        let ev = event::build(event, reminder_offset_hours);
        self.recorder
            .publish(&ev, &self.reference)
            .await
            .map_err(|e| AppError::K8s(format!("publish event: {e}")))
    }
}
