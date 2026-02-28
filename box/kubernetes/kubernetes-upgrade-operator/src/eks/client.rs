//! AWS EKS SDK client wrapper.

use anyhow::Result;
use aws_sdk_eks::Client;
use tracing::debug;

use crate::error::KuoError;

/// Cluster information.
#[derive(Debug, Clone)]
pub struct ClusterInfo {
    pub name: String,
    pub version: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub ca_data: Option<String>,
    pub deletion_protection: Option<bool>,
}

impl std::fmt::Display for ClusterInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}) - {}", self.name, self.version, self.region)
    }
}

/// EKS client wrapper for cluster operations.
#[derive(Clone)]
pub struct EksClient {
    client: Client,
    region: String,
}

impl EksClient {
    /// Create a new EKS client from pre-configured AWS clients.
    pub const fn new(client: Client, region: String) -> Self {
        Self { client, region }
    }

    /// Get the underlying AWS SDK EKS client.
    pub const fn inner(&self) -> &Client {
        &self.client
    }

    /// Get the AWS region string.
    pub fn region(&self) -> &str {
        &self.region
    }

    /// Describe a specific cluster.
    pub async fn describe_cluster(&self, cluster_name: &str) -> Result<Option<ClusterInfo>> {
        debug!("Describing cluster: {}", cluster_name);

        let response = self
            .client
            .describe_cluster()
            .name(cluster_name)
            .send()
            .await
            .map_err(|e| KuoError::aws(module_path!(), e))?;

        if let Some(cluster) = response.cluster() {
            let info = ClusterInfo {
                name: cluster.name().unwrap_or_default().to_string(),
                version: cluster.version().unwrap_or_default().to_string(),
                region: self.region.clone(),
                endpoint: cluster.endpoint().map(std::string::ToString::to_string),
                ca_data: cluster
                    .certificate_authority()
                    .and_then(|ca| ca.data())
                    .map(std::string::ToString::to_string),
                deletion_protection: cluster.deletion_protection(),
            };
            return Ok(Some(info));
        }

        Ok(None)
    }

    /// Update cluster version (control plane upgrade).
    pub async fn update_cluster_version(
        &self,
        cluster_name: &str,
        target_version: &str,
    ) -> Result<String> {
        debug!(
            "Updating cluster {} control plane to version {}",
            cluster_name, target_version
        );

        let response = self
            .client
            .update_cluster_version()
            .name(cluster_name)
            .version(target_version)
            .send()
            .await
            .map_err(|e| KuoError::aws(module_path!(), e))?;

        let update_id = response
            .update()
            .and_then(|u| u.id())
            .map(std::string::ToString::to_string)
            .unwrap_or_default();

        debug!("Control plane update initiated: {}", update_id);
        Ok(update_id)
    }

    /// Check the status of a cluster update without waiting.
    /// Returns the status string (e.g., "`InProgress`", "Successful", "Failed").
    pub async fn check_update_status(&self, cluster_name: &str, update_id: &str) -> Result<String> {
        let response = self
            .client
            .describe_update()
            .name(cluster_name)
            .update_id(update_id)
            .send()
            .await
            .map_err(|e| KuoError::aws(module_path!(), e))?;

        let status = response
            .update()
            .and_then(|u| u.status())
            .map_or_else(|| "Unknown".to_string(), |s| s.as_str().to_string());

        Ok(status)
    }
}
