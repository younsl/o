//! AWS EKS SDK client wrapper.

use anyhow::Result;
use aws_sdk_eks::Client;
use tracing::{debug, info};

use crate::error::EkupError;

/// Cluster information.
#[derive(Debug, Clone)]
pub struct ClusterInfo {
    pub name: String,
    pub version: String,
    pub region: String,
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
    /// Create a new EKS client with the given AWS configuration.
    pub async fn new(profile: Option<&str>, region: Option<&str>) -> Result<Self> {
        let mut config_loader = aws_config::defaults(aws_config::BehaviorVersion::latest());

        if let Some(profile) = profile {
            debug!("Using AWS profile: {}", profile);
            config_loader = config_loader.profile_name(profile);
        }

        if let Some(region) = region {
            debug!("Using AWS region: {}", region);
            config_loader = config_loader.region(aws_config::Region::new(region.to_string()));
        }

        let config = config_loader.load().await;
        let region = config
            .region()
            .map(|r| r.to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let client = Client::new(&config);

        Ok(Self { client, region })
    }

    /// Get the underlying AWS SDK client.
    pub fn inner(&self) -> &Client {
        &self.client
    }

    /// List all EKS clusters in the region.
    pub async fn list_clusters(&self) -> Result<Vec<ClusterInfo>> {
        info!("Listing EKS clusters in region: {}", self.region);

        let mut clusters = Vec::new();
        let mut next_token: Option<String> = None;

        loop {
            let mut request = self.client.list_clusters();

            if let Some(token) = next_token.take() {
                request = request.next_token(token);
            }

            let response = request.send().await.map_err(EkupError::aws)?;

            for cluster_name in response.clusters() {
                if let Some(info) = self.describe_cluster(cluster_name).await? {
                    clusters.push(info);
                }
            }

            next_token = response.next_token().map(|s| s.to_string());
            if next_token.is_none() {
                break;
            }
        }

        debug!("Found {} clusters", clusters.len());
        Ok(clusters)
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
            .map_err(EkupError::aws)?;

        if let Some(cluster) = response.cluster() {
            let info = ClusterInfo {
                name: cluster.name().unwrap_or_default().to_string(),
                version: cluster.version().unwrap_or_default().to_string(),
                region: self.region.clone(),
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
        info!(
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
            .map_err(EkupError::aws)?;

        let update_id = response
            .update()
            .and_then(|u| u.id())
            .map(|s| s.to_string())
            .unwrap_or_default();

        info!("Control plane update initiated: {}", update_id);
        Ok(update_id)
    }

    /// Wait for cluster update to complete.
    pub async fn wait_for_cluster_update(
        &self,
        cluster_name: &str,
        update_id: &str,
        timeout_minutes: u64,
        check_interval_seconds: u64,
    ) -> Result<()> {
        use std::time::{Duration, Instant};

        let timeout = Duration::from_secs(timeout_minutes * 60);
        let interval = Duration::from_secs(check_interval_seconds);
        let start = Instant::now();

        loop {
            if start.elapsed() > timeout {
                return Err(EkupError::Timeout {
                    operation: "cluster update".to_string(),
                    details: format!(
                        "Update {} did not complete within {} minutes",
                        update_id, timeout_minutes
                    ),
                }
                .into());
            }

            let response = self
                .client
                .describe_update()
                .name(cluster_name)
                .update_id(update_id)
                .send()
                .await
                .map_err(EkupError::aws)?;

            if let Some(update) = response.update() {
                let status = update.status().map(|s| s.as_str()).unwrap_or("Unknown");
                debug!("Update {} status: {}", update_id, status);

                match status {
                    "Successful" => {
                        info!("Cluster update completed successfully");
                        return Ok(());
                    }
                    "Failed" | "Cancelled" => {
                        let errors: Vec<String> = update
                            .errors()
                            .iter()
                            .filter_map(|e| e.error_message().map(|s| s.to_string()))
                            .collect();
                        return Err(EkupError::UpgradeNotPossible(format!(
                            "Update {}: {}",
                            status,
                            errors.join(", ")
                        ))
                        .into());
                    }
                    _ => {
                        // InProgress, Pending
                        tokio::time::sleep(interval).await;
                    }
                }
            } else {
                tokio::time::sleep(interval).await;
            }
        }
    }

    /// Get available Kubernetes versions for upgrade.
    pub async fn get_available_versions(&self, cluster_name: &str) -> Result<Vec<String>> {
        debug!("Getting available versions for cluster: {}", cluster_name);

        // EKS doesn't have a direct API for this, so we'll compute based on current version
        let cluster = self
            .describe_cluster(cluster_name)
            .await?
            .ok_or_else(|| EkupError::ClusterNotFound(cluster_name.to_string()))?;

        let current_version = parse_k8s_version(&cluster.version)?;
        let mut available = Vec::new();

        // EKS typically supports up to +2-3 minor versions ahead
        for i in 1..=3 {
            let next_minor = current_version.1 + i;
            // EKS version ceiling (update this as new versions are released)
            if next_minor <= 34 {
                available.push(format!("{}.{}", current_version.0, next_minor));
            }
        }

        Ok(available)
    }
}

/// Parse a Kubernetes version string into major and minor components.
pub fn parse_k8s_version(version: &str) -> Result<(u32, u32)> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() < 2 {
        return Err(EkupError::InvalidVersion(version.to_string()).into());
    }

    let major: u32 = parts[0]
        .parse()
        .map_err(|_| EkupError::InvalidVersion(version.to_string()))?;
    let minor: u32 = parts[1]
        .parse()
        .map_err(|_| EkupError::InvalidVersion(version.to_string()))?;

    Ok((major, minor))
}

/// Calculate the upgrade path from current to target version.
pub fn calculate_upgrade_path(current: &str, target: &str) -> Result<Vec<String>> {
    let (curr_major, curr_minor) = parse_k8s_version(current)?;
    let (target_major, target_minor) = parse_k8s_version(target)?;

    if curr_major != target_major {
        return Err(EkupError::UpgradeNotPossible(
            "Cross-major version upgrades are not supported".to_string(),
        )
        .into());
    }

    if target_minor <= curr_minor {
        return Err(EkupError::UpgradeNotPossible(format!(
            "Target version {} is not higher than current version {}",
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

        assert!(calculate_upgrade_path("1.30", "1.28").is_err());
    }
}
