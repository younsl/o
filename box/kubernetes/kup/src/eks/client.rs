//! AWS EKS SDK client wrapper.

use std::collections::HashMap;

use anyhow::Result;
use aws_sdk_autoscaling::Client as AsgClient;
use aws_sdk_eks::Client;
use tracing::debug;

use crate::error::KupError;

/// Cluster information.
#[derive(Debug, Clone)]
pub struct ClusterInfo {
    pub name: String,
    pub version: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub ca_data: Option<String>,
}

impl std::fmt::Display for ClusterInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} ({}) - {}", self.name, self.version, self.region)
    }
}

/// EKS version lifecycle information from DescribeClusterVersions API.
#[derive(Debug, Clone)]
pub struct VersionLifecycle {
    pub end_of_standard_support: Option<String>,
}

/// EKS client wrapper for cluster operations.
#[derive(Clone)]
pub struct EksClient {
    client: Client,
    asg_client: AsgClient,
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
        let asg_client = AsgClient::new(&config);

        Ok(Self {
            client,
            asg_client,
            region,
        })
    }

    /// Get the underlying AWS SDK EKS client.
    pub fn inner(&self) -> &Client {
        &self.client
    }

    /// Get the underlying AWS SDK Auto Scaling client.
    pub fn asg(&self) -> &AsgClient {
        &self.asg_client
    }

    /// Get the AWS region string.
    pub fn region(&self) -> &str {
        &self.region
    }

    /// List all EKS clusters in the region.
    pub async fn list_clusters(&self) -> Result<Vec<ClusterInfo>> {
        debug!("Listing EKS clusters in region: {}", self.region);

        let mut clusters = Vec::new();
        let mut next_token: Option<String> = None;

        loop {
            let mut request = self.client.list_clusters();

            if let Some(token) = next_token.take() {
                request = request.next_token(token);
            }

            let response = request
                .send()
                .await
                .map_err(|e| KupError::aws(module_path!(), e))?;

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
            .map_err(|e| KupError::aws(module_path!(), e))?;

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
            .map_err(|e| KupError::aws(module_path!(), e))?;

        let update_id = response
            .update()
            .and_then(|u| u.id())
            .map(|s| s.to_string())
            .unwrap_or_default();

        debug!("Control plane update initiated: {}", update_id);
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
                return Err(KupError::Timeout {
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
                .map_err(|e| KupError::aws(module_path!(), e))?;

            if let Some(update) = response.update() {
                let status = update.status().map(|s| s.as_str()).unwrap_or("Unknown");
                debug!("Update {} status: {}", update_id, status);

                match status {
                    "Successful" => {
                        debug!("Cluster update completed successfully");
                        return Ok(());
                    }
                    "Failed" | "Cancelled" => {
                        let errors: Vec<String> = update
                            .errors()
                            .iter()
                            .filter_map(|e| e.error_message().map(|s| s.to_string()))
                            .collect();
                        return Err(KupError::UpgradeNotPossible(format!(
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

    /// Get available Kubernetes versions for upgrade from EKS API.
    ///
    /// Discovers supported versions by querying `DescribeAddonVersions` for the
    /// `kube-proxy` addon (present on all EKS clusters) and collecting unique
    /// cluster versions higher than the current version.
    pub async fn get_available_versions(&self, cluster_name: &str) -> Result<Vec<String>> {
        debug!("Getting available versions for cluster: {}", cluster_name);

        let cluster = self
            .describe_cluster(cluster_name)
            .await?
            .ok_or_else(|| KupError::ClusterNotFound(cluster_name.to_string()))?;

        let current_version = parse_k8s_version(&cluster.version)?;

        let mut supported_minors = std::collections::BTreeSet::new();
        let mut next_token: Option<String> = None;

        loop {
            let mut request = self
                .client
                .describe_addon_versions()
                .addon_name("kube-proxy");
            if let Some(token) = next_token.take() {
                request = request.next_token(token);
            }

            let response = request
                .send()
                .await
                .map_err(|e| KupError::aws(module_path!(), e))?;

            for addon in response.addons() {
                for version_info in addon.addon_versions() {
                    for compat in version_info.compatibilities() {
                        if let Some(cluster_version) = compat.cluster_version()
                            && let Ok(ver) = parse_k8s_version(cluster_version)
                            && ver.0 == current_version.0
                            && ver.1 > current_version.1
                        {
                            supported_minors.insert(ver.1);
                        }
                    }
                }
            }

            next_token = response.next_token().map(|s| s.to_string());
            if next_token.is_none() {
                break;
            }
        }

        let available: Vec<String> = supported_minors
            .into_iter()
            .map(|minor| format!("{}.{}", current_version.0, minor))
            .collect();

        debug!("Available upgrade versions: {:?}", available);
        Ok(available)
    }

    /// Get version lifecycle information (EOS dates) for all EKS versions.
    ///
    /// Calls `DescribeClusterVersions` API and returns a map of version string
    /// to lifecycle dates. Returns an empty map on failure (graceful degradation).
    pub async fn get_version_lifecycles(&self) -> HashMap<String, VersionLifecycle> {
        debug!("Fetching EKS version lifecycle information");

        let mut lifecycles = HashMap::new();
        let mut next_token: Option<String> = None;

        loop {
            let mut request = self.client.describe_cluster_versions();

            if let Some(token) = next_token.take() {
                request = request.next_token(token);
            }

            let response = match request.send().await {
                Ok(resp) => resp,
                Err(e) => {
                    debug!("Failed to fetch version lifecycles: {}", e);
                    return lifecycles;
                }
            };

            for version_info in response.cluster_versions() {
                if let Some(version) = version_info.cluster_version() {
                    let eos = version_info.end_of_standard_support_date().and_then(|dt| {
                        chrono::DateTime::from_timestamp(dt.secs(), dt.subsec_nanos())
                            .map(|d| d.format("%Y-%m-%d").to_string())
                    });

                    lifecycles.insert(
                        version.to_string(),
                        VersionLifecycle {
                            end_of_standard_support: eos,
                        },
                    );
                }
            }

            next_token = response.next_token().map(|s| s.to_string());
            if next_token.is_none() {
                break;
            }
        }

        debug!("Fetched lifecycle info for {} versions", lifecycles.len());
        lifecycles
    }
}

/// Parse a Kubernetes version string into major and minor components.
pub fn parse_k8s_version(version: &str) -> Result<(u32, u32)> {
    let parts: Vec<&str> = version.split('.').collect();
    if parts.len() < 2 {
        return Err(KupError::InvalidVersion(version.to_string()).into());
    }

    let major: u32 = parts[0]
        .parse()
        .map_err(|_| KupError::InvalidVersion(version.to_string()))?;
    let minor: u32 = parts[1]
        .parse()
        .map_err(|_| KupError::InvalidVersion(version.to_string()))?;

    Ok((major, minor))
}

/// Calculate the upgrade path from current to target version.
/// Returns empty Vec if target equals current (sync mode).
/// Returns error if target is lower than current (downgrade not supported).
pub fn calculate_upgrade_path(current: &str, target: &str) -> Result<Vec<String>> {
    let (curr_major, curr_minor) = parse_k8s_version(current)?;
    let (target_major, target_minor) = parse_k8s_version(target)?;

    if curr_major != target_major {
        return Err(KupError::UpgradeNotPossible(
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
        return Err(KupError::UpgradeNotPossible(format!(
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
