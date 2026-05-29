//! ConfigMap-backed CRUD for alert rules. One ConfigMap holds all rules; each
//! data key is a rule name and each value is the JSON-encoded `AlertRule`.

use std::collections::BTreeMap;

use k8s_openapi::api::core::v1::ConfigMap;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::ObjectMeta;
use kube::{
    Client,
    api::{Api, Patch, PatchParams, PostParams},
};
use thiserror::Error;
use tracing::{debug, info};

use super::types::{AlertRule, validate_rule_name};

pub const MANAGED_BY_LABEL: &str = "app.kubernetes.io/managed-by";
pub const COMPONENT_LABEL: &str = "app.kubernetes.io/component";
pub const COMPONENT_VALUE: &str = "trivy-collector-alerts";

#[derive(Debug, Error)]
pub enum AlertStoreError {
    #[error("invalid rule: {0}")]
    Invalid(String),
    #[error("rule not found: {0}")]
    NotFound(String),
    #[error("kube API error: {0}")]
    Kube(#[from] kube::Error),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

#[derive(Clone)]
pub struct AlertStore {
    client: Client,
    namespace: String,
    configmap_name: String,
}

impl AlertStore {
    pub fn new(client: Client, namespace: String, configmap_name: String) -> Self {
        Self {
            client,
            namespace,
            configmap_name,
        }
    }

    pub fn namespace(&self) -> &str {
        &self.namespace
    }

    pub fn configmap_name(&self) -> &str {
        &self.configmap_name
    }

    fn api(&self) -> Api<ConfigMap> {
        Api::namespaced(self.client.clone(), &self.namespace)
    }

    /// Create an empty backing ConfigMap if it does not already exist.
    /// Idempotent: a pre-existing ConfigMap (with rules or empty) is left
    /// untouched. Concurrent creates from multiple replicas race safely —
    /// the loser sees `AlreadyExists` and is treated as success.
    pub async fn ensure_exists(&self) -> Result<(), AlertStoreError> {
        let api = self.api();
        if api.get_opt(&self.configmap_name).await?.is_some() {
            return Ok(());
        }
        let cm = ConfigMap {
            metadata: ObjectMeta {
                name: Some(self.configmap_name.clone()),
                namespace: Some(self.namespace.clone()),
                labels: Some(default_labels()),
                ..Default::default()
            },
            data: Some(BTreeMap::new()),
            ..Default::default()
        };
        match api.create(&PostParams::default(), &cm).await {
            Ok(_) => {
                info!(
                    namespace = %self.namespace,
                    name = %self.configmap_name,
                    "Created empty alerts ConfigMap"
                );
                Ok(())
            }
            Err(kube::Error::Api(e)) if e.code == 409 => Ok(()),
            Err(e) => Err(AlertStoreError::Kube(e)),
        }
    }

    pub async fn list(&self) -> Result<Vec<AlertRule>, AlertStoreError> {
        let api = self.api();
        let cm = match api.get_opt(&self.configmap_name).await? {
            Some(cm) => cm,
            None => return Ok(Vec::new()),
        };
        let data = cm.data.unwrap_or_default();
        let mut rules = Vec::with_capacity(data.len());
        for (key, value) in data {
            match serde_json::from_str::<AlertRule>(&value) {
                Ok(rule) => rules.push(rule),
                Err(e) => {
                    tracing::warn!(rule = %key, error = %e, "Skipping malformed alert rule");
                }
            }
        }
        rules.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(rules)
    }

    pub async fn get(&self, name: &str) -> Result<AlertRule, AlertStoreError> {
        let api = self.api();
        let cm = api
            .get_opt(&self.configmap_name)
            .await?
            .ok_or_else(|| AlertStoreError::NotFound(name.to_string()))?;
        let data = cm.data.unwrap_or_default();
        let raw = data
            .get(name)
            .ok_or_else(|| AlertStoreError::NotFound(name.to_string()))?;
        Ok(serde_json::from_str(raw)?)
    }

    pub async fn upsert(&self, rule: &AlertRule) -> Result<(), AlertStoreError> {
        validate_rule_name(&rule.name).map_err(|e| AlertStoreError::Invalid(e.to_string()))?;
        if rule.receivers.is_empty() {
            return Err(AlertStoreError::Invalid(
                "at least one receiver is required".into(),
            ));
        }
        for r in &rule.receivers {
            if let Some(slack) = &r.slack
                && !slack.webhook_url.starts_with("https://")
            {
                return Err(AlertStoreError::Invalid(format!(
                    "receiver '{}' slack webhook_url must start with https://",
                    r.name
                )));
            }
        }
        if let Some(expr) = &rule.matchers.version_expr {
            super::expr::VersionExpr::parse(expr)
                .map_err(|e| AlertStoreError::Invalid(format!("version_expr: {}", e)))?;
        }

        let json = serde_json::to_string(rule)?;
        // ensure_exists() runs at startup, but call again here so a manually
        // deleted ConfigMap is re-created on the next write.
        self.ensure_exists().await?;
        let patch = serde_json::json!({
            "data": { rule.name.clone(): json },
        });
        self.api()
            .patch(
                &self.configmap_name,
                &PatchParams::default(),
                &Patch::Merge(&patch),
            )
            .await?;
        debug!(rule = %rule.name, "Patched alert rule into ConfigMap");
        Ok(())
    }

    pub async fn delete(&self, name: &str) -> Result<(), AlertStoreError> {
        let api = self.api();
        let cm = api
            .get_opt(&self.configmap_name)
            .await?
            .ok_or_else(|| AlertStoreError::NotFound(name.to_string()))?;
        if cm.data.as_ref().is_none_or(|d| !d.contains_key(name)) {
            return Err(AlertStoreError::NotFound(name.to_string()));
        }
        // Setting the key to null in a JSON merge patch removes it.
        let patch = serde_json::json!({
            "data": { name: serde_json::Value::Null },
        });
        api.patch(
            &self.configmap_name,
            &PatchParams::default(),
            &Patch::Merge(&patch),
        )
        .await?;
        info!(rule = %name, "Deleted alert rule");
        Ok(())
    }
}

fn default_labels() -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    m.insert(MANAGED_BY_LABEL.to_string(), "trivy-collector".to_string());
    m.insert(COMPONENT_LABEL.to_string(), COMPONENT_VALUE.to_string());
    m
}
