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
    pub fn new(client: Client, region: String) -> Self {
        Self { client, region }
    }

    /// Get the underlying AWS SDK EKS client.
    pub fn inner(&self) -> &Client {
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
                endpoint: cluster.endpoint().map(|s| s.to_string()),
                ca_data: cluster
                    .certificate_authority()
                    .and_then(|ca| ca.data())
                    .map(|s| s.to_string()),
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
            .map(|s| s.to_string())
            .unwrap_or_default();

        debug!("Control plane update initiated: {}", update_id);
        Ok(update_id)
    }

    /// Check the status of a cluster update without waiting.
    /// Returns the status string (e.g., "InProgress", "Successful", "Failed").
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
            .map(|s| s.as_str().to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        Ok(status)
    }
}

/// Parse a Kubernetes version string into major and minor components.
pub fn parse_k8s_version(version: &str) -> Result<(u32, u32)> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() < 2 {
        return Err(KuoError::InvalidVersion(version.to_string()).into());
    }

    let major: u32 = parts[0]
        .parse()
        .map_err(|_| KuoError::InvalidVersion(version.to_string()))?;
    let minor: u32 = parts[1]
        .parse()
        .map_err(|_| KuoError::InvalidVersion(version.to_string()))?;

    Ok((major, minor))
}

/// Calculate the upgrade path from current to target version.
/// Returns empty Vec if target equals current (sync mode).
/// Returns error if target is lower than current (downgrade not supported).
pub fn calculate_upgrade_path(current: &str, target: &str) -> Result<Vec<String>> {
    let (curr_major, curr_minor) = parse_k8s_version(current)?;
    let (target_major, target_minor) = parse_k8s_version(target)?;

    if curr_major != target_major {
        return Err(KuoError::UpgradeNotPossible(
            "Cross-major version upgrades are not supported".to_string(),
        )
        .into());
    }

    // Same version: sync mode - return empty path (no CP upgrade needed)
    if target_minor == curr_minor {
        return Ok(Vec::new());
    }

    // Downgrade not supported
    if target_minor < curr_minor {
        return Err(KuoError::UpgradeNotPossible(format!(
            "Target version {} is lower than current version {} (downgrade not supported)",
            target, current
        ))
        .into());
    }

    let mut path = Vec::new();
    for minor in (curr_minor + 1)..=target_minor {
        path.push(format!("{}.{}", curr_major, minor));
    }

    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_k8s_version() {
        assert_eq!(parse_k8s_version("1.28").unwrap(), (1, 28));
        assert_eq!(parse_k8s_version("1.32").unwrap(), (1, 32));
        assert!(parse_k8s_version("invalid").is_err());
    }

    #[test]
    fn test_calculate_upgrade_path() {
        let path = calculate_upgrade_path("1.28", "1.30").unwrap();
        assert_eq!(path, vec!["1.29", "1.30"]);

        let path = calculate_upgrade_path("1.32", "1.34").unwrap();
        assert_eq!(path, vec!["1.33", "1.34"]);

        // Downgrade not supported
        assert!(calculate_upgrade_path("1.30", "1.28").is_err());
    }

    #[test]
    fn test_calculate_upgrade_path_same_version() {
        // Sync mode: same version returns empty path
        let path = calculate_upgrade_path("1.32", "1.32").unwrap();
        assert!(path.is_empty());

        let path = calculate_upgrade_path("1.33", "1.33").unwrap();
        assert!(path.is_empty());
    }
}
