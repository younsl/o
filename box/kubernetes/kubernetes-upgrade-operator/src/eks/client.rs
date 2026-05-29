//! AWS EKS SDK client wrapper.

use anyhow::Result;
use aws_sdk_eks::Client;
use chrono::{DateTime, Utc};
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

/// EKS version lifecycle information from `DescribeClusterVersions` API.
#[derive(Debug, Clone)]
pub struct VersionLifecycle {
    /// Kubernetes version (e.g., "1.32").
    pub version: String,
    /// Version status (e.g., "standard-support", "extended-support").
    pub status: String,
    /// End of standard support date.
    pub end_of_standard_support: Option<DateTime<Utc>>,
    /// End of extended support date.
    pub end_of_extended_support: Option<DateTime<Utc>>,
}

/// Convert an AWS Smithy `DateTime` to a `chrono::DateTime<Utc>`.
fn smithy_datetime_to_chrono(dt: &aws_smithy_types::DateTime) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp(dt.secs(), dt.subsec_nanos())
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

    /// Describe EKS cluster versions to get lifecycle (support end dates).
    pub async fn describe_cluster_versions(
        &self,
        versions: &[&str],
    ) -> Result<Vec<VersionLifecycle>> {
        debug!("Describing cluster versions: {:?}", versions);

        let mut builder = self.client.describe_cluster_versions();
        for v in versions {
            builder = builder.cluster_versions(*v);
        }

        let response = builder
            .send()
            .await
            .map_err(|e| KuoError::aws(module_path!(), e))?;

        let result = response
            .cluster_versions()
            .iter()
            .map(|cv| {
                let version = cv.cluster_version().unwrap_or_default().to_string();
                let status = cv
                    .status()
                    .map_or_else(String::new, |s| s.as_str().to_string());
                let end_of_standard_support = cv
                    .end_of_standard_support_date()
                    .and_then(smithy_datetime_to_chrono);
                let end_of_extended_support = cv
                    .end_of_extended_support_date()
                    .and_then(smithy_datetime_to_chrono);

                VersionLifecycle {
                    version,
                    status,
                    end_of_standard_support,
                    end_of_extended_support,
                }
            })
            .collect();

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_smithy_datetime_to_chrono_valid() {
        let smithy_dt = aws_smithy_types::DateTime::from_secs(1_742_688_000); // 2025-03-23T00:00:00Z
        let chrono_dt = smithy_datetime_to_chrono(&smithy_dt);
        assert!(chrono_dt.is_some());
        let dt = chrono_dt.unwrap();
        assert_eq!(
            dt.format("%Y-%m-%dT%H:%M:%SZ").to_string(),
            "2025-03-23T00:00:00Z"
        );
    }

    #[test]
    fn test_smithy_datetime_to_chrono_epoch() {
        let smithy_dt = aws_smithy_types::DateTime::from_secs(0);
        let chrono_dt = smithy_datetime_to_chrono(&smithy_dt);
        assert!(chrono_dt.is_some());
        assert_eq!(chrono_dt.unwrap().timestamp(), 0);
    }

    #[test]
    fn test_version_lifecycle_struct() {
        let lifecycle = VersionLifecycle {
            version: "1.32".to_string(),
            status: "standard-support".to_string(),
            end_of_standard_support: Some("2026-03-23T00:00:00Z".parse().unwrap()),
            end_of_extended_support: Some("2027-03-23T00:00:00Z".parse().unwrap()),
        };
        assert_eq!(lifecycle.version, "1.32");
        assert_eq!(lifecycle.status, "standard-support");
        assert!(lifecycle.end_of_standard_support.is_some());
        assert!(lifecycle.end_of_extended_support.is_some());
    }

    #[test]
    fn test_version_lifecycle_no_dates() {
        let lifecycle = VersionLifecycle {
            version: "1.33".to_string(),
            status: "standard-support".to_string(),
            end_of_standard_support: None,
            end_of_extended_support: None,
        };
        assert!(lifecycle.end_of_standard_support.is_none());
        assert!(lifecycle.end_of_extended_support.is_none());
    }

    #[test]
    fn test_cluster_info_display() {
        let info = ClusterInfo {
            name: "prod-cluster".to_string(),
            version: "1.33".to_string(),
            region: "ap-northeast-2".to_string(),
            endpoint: None,
            ca_data: None,
            deletion_protection: Some(true),
        };
        let display = format!("{info}");
        assert_eq!(display, "prod-cluster (1.33) - ap-northeast-2");
    }

    #[test]
    fn test_cluster_info_fields() {
        let info = ClusterInfo {
            name: "staging".to_string(),
            version: "1.32".to_string(),
            region: "us-east-1".to_string(),
            endpoint: Some("https://eks.example.com".to_string()),
            ca_data: Some("base64data".to_string()),
            deletion_protection: Some(false),
        };
        assert_eq!(info.endpoint.as_deref(), Some("https://eks.example.com"));
        assert_eq!(info.ca_data.as_deref(), Some("base64data"));
        assert_eq!(info.deletion_protection, Some(false));
    }

    #[test]
    fn test_cluster_info_clone() {
        let info = ClusterInfo {
            name: "test".to_string(),
            version: "1.33".to_string(),
            region: "eu-west-1".to_string(),
            endpoint: None,
            ca_data: None,
            deletion_protection: None,
        };
        let cloned = info.clone();
        assert_eq!(cloned.name, info.name);
        assert_eq!(cloned.deletion_protection, None);
    }

    #[test]
    fn test_smithy_datetime_to_chrono_with_nanos() {
        let smithy_dt = aws_smithy_types::DateTime::from_fractional_secs(1_742_688_000, 0.5);
        let chrono_dt = smithy_datetime_to_chrono(&smithy_dt);
        assert!(chrono_dt.is_some());
    }
}
