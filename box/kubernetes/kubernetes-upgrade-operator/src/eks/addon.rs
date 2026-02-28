//! EKS Add-on operations.

use anyhow::Result;
use aws_sdk_eks::Client;
use futures::future::join_all;
use std::collections::HashMap;
use tracing::{debug, info, warn};

use std::cmp::Ordering;

use super::types::PlanResult;
use crate::error::KuoError;

/// Parse an EKS addon version string into a comparable tuple.
///
/// Format: `v<major>.<minor>.<patch>-eksbuild.<build>`
/// Returns `(major, minor, patch, build)` or `None` if parsing fails.
fn parse_addon_version(version: &str) -> Option<(u64, u64, u64, u64)> {
    let s = version.strip_prefix('v').unwrap_or(version);

    let (semver_part, build) = if let Some((sem, eksbuild)) = s.split_once("-eksbuild.") {
        let build_num = eksbuild.parse::<u64>().ok()?;
        (sem, build_num)
    } else {
        (s, 0)
    };

    let parts: Vec<&str> = semver_part.split('.').collect();
    if parts.len() != 3 {
        return None;
    }

    let major = parts[0].parse::<u64>().ok()?;
    let minor = parts[1].parse::<u64>().ok()?;
    let patch = parts[2].parse::<u64>().ok()?;

    Some((major, minor, patch, build))
}

/// Compare two EKS addon version strings numerically.
///
/// Falls back to lexicographic comparison if either version cannot be parsed.
fn compare_addon_versions(a: &str, b: &str) -> Ordering {
    match (parse_addon_version(a), parse_addon_version(b)) {
        (Some(va), Some(vb)) => va.cmp(&vb),
        _ => a.cmp(b),
    }
}

/// Add-on information.
#[derive(Debug, Clone)]
pub struct AddonInfo {
    pub name: String,
    pub current_version: String,
}

/// Add-on version information.
#[derive(Debug, Clone)]
pub struct AddonVersionInfo {
    pub version: String,
    pub default_version: bool,
}

/// Type alias for addon upgrade item (addon info + target version).
pub type AddonUpgrade = (AddonInfo, String);

/// Type alias for addon plan result.
pub type AddonPlanResult = PlanResult<AddonUpgrade>;

/// List all add-ons installed on a cluster.
pub async fn list_addons(client: &Client, cluster_name: &str) -> Result<Vec<AddonInfo>> {
    debug!("Listing add-ons for cluster: {}", cluster_name);

    let response = client
        .list_addons()
        .cluster_name(cluster_name)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    // Parallel describe_addon calls for better performance
    let futures: Vec<_> = response
        .addons()
        .iter()
        .map(|addon_name| describe_addon(client, cluster_name, addon_name))
        .collect();

    let results = join_all(futures).await;

    let addons: Vec<AddonInfo> = results
        .into_iter()
        .filter_map(|r| r.ok().flatten())
        .collect();

    debug!("Found {} add-ons", addons.len());
    Ok(addons)
}

/// Describe a specific add-on.
pub async fn describe_addon(
    client: &Client,
    cluster_name: &str,
    addon_name: &str,
) -> Result<Option<AddonInfo>> {
    debug!("Describing add-on: {}", addon_name);

    let response = client
        .describe_addon()
        .cluster_name(cluster_name)
        .addon_name(addon_name)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    if let Some(addon) = response.addon() {
        let info = AddonInfo {
            name: addon.addon_name().unwrap_or_default().to_string(),
            current_version: addon.addon_version().unwrap_or_default().to_string(),
        };
        return Ok(Some(info));
    }

    Ok(None)
}

/// Get available versions for an add-on compatible with a specific Kubernetes version.
pub async fn get_compatible_versions(
    client: &Client,
    addon_name: &str,
    k8s_version: &str,
) -> Result<Vec<AddonVersionInfo>> {
    debug!(
        "Getting compatible versions for {} with K8s {}",
        addon_name, k8s_version
    );

    let response = client
        .describe_addon_versions()
        .addon_name(addon_name)
        .kubernetes_version(k8s_version)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    let mut versions = Vec::new();

    for addon in response.addons() {
        for version_info in addon.addon_versions() {
            versions.push(AddonVersionInfo {
                version: version_info.addon_version().unwrap_or_default().to_string(),
                default_version: version_info
                    .compatibilities()
                    .iter()
                    .any(aws_sdk_eks::types::Compatibility::default_version),
            });
        }
    }

    // Sort by version (latest first) using numeric comparison
    versions.sort_by(|a, b| compare_addon_versions(&b.version, &a.version));

    Ok(versions)
}

/// Get the latest compatible version for an add-on.
pub async fn get_latest_compatible_version(
    client: &Client,
    addon_name: &str,
    k8s_version: &str,
) -> Result<Option<String>> {
    let versions = get_compatible_versions(client, addon_name, k8s_version).await?;

    // Prefer default version, otherwise take the first (latest)
    if let Some(default) = versions.iter().find(|v| v.default_version) {
        return Ok(Some(default.version.clone()));
    }

    Ok(versions.first().map(|v| v.version.clone()))
}

/// Update an add-on to a specific version.
pub async fn update_addon(
    client: &Client,
    cluster_name: &str,
    addon_name: &str,
    target_version: &str,
) -> Result<String> {
    info!(
        "Updating add-on {} to version {}",
        addon_name, target_version
    );

    let response = client
        .update_addon()
        .cluster_name(cluster_name)
        .addon_name(addon_name)
        .addon_version(target_version)
        .resolve_conflicts(aws_sdk_eks::types::ResolveConflicts::Overwrite)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    let update_id = response
        .update()
        .and_then(|u| u.id())
        .map(std::string::ToString::to_string)
        .unwrap_or_default();

    info!("Add-on update initiated: {}", update_id);
    Ok(update_id)
}

/// Plan add-on upgrades to target Kubernetes version.
pub async fn plan_addon_upgrades(
    client: &Client,
    cluster_name: &str,
    target_k8s_version: &str,
    specified_versions: &HashMap<String, String>,
) -> Result<AddonPlanResult> {
    let current_addons = list_addons(client, cluster_name).await?;
    let addon_count = current_addons.len();
    let mut result = AddonPlanResult::new();

    for addon in current_addons {
        // Check if user specified a version for this add-on
        let target_version = if let Some(specified) = specified_versions.get(&addon.name) {
            specified.clone()
        } else {
            // Get latest compatible version
            if let Some(version) =
                get_latest_compatible_version(client, &addon.name, target_k8s_version).await?
            {
                version
            } else {
                warn!(
                    "No compatible version found for {} with K8s {}",
                    addon.name, target_k8s_version
                );
                result.add_skipped();
                continue;
            }
        };

        if target_version == addon.current_version {
            result.add_skipped();
        } else {
            result.add_upgrade((addon, target_version));
        }
    }

    info!(
        "Found {} add-ons ({} to upgrade, {} skipped)",
        addon_count,
        result.upgrade_count(),
        result.skipped_count()
    );
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_addon_info_creation() {
        let addon = AddonInfo {
            name: "vpc-cni".to_string(),
            current_version: "v1.18.1-eksbuild.3".to_string(),
        };
        assert_eq!(addon.name, "vpc-cni");
        assert_eq!(addon.current_version, "v1.18.1-eksbuild.3");
    }

    #[test]
    fn test_addon_version_info_default() {
        let v = AddonVersionInfo {
            version: "v1.18.1-eksbuild.3".to_string(),
            default_version: true,
        };
        assert!(v.default_version);
        assert_eq!(v.version, "v1.18.1-eksbuild.3");
    }

    #[test]
    fn test_addon_version_info_sorting() {
        let mut versions = vec![
            AddonVersionInfo {
                version: "v1.16.0-eksbuild.1".to_string(),
                default_version: false,
            },
            AddonVersionInfo {
                version: "v1.18.1-eksbuild.3".to_string(),
                default_version: true,
            },
            AddonVersionInfo {
                version: "v1.17.0-eksbuild.2".to_string(),
                default_version: false,
            },
            AddonVersionInfo {
                version: "v1.9.0-eksbuild.1".to_string(),
                default_version: false,
            },
        ];
        versions.sort_by(|a, b| compare_addon_versions(&b.version, &a.version));
        assert_eq!(versions[0].version, "v1.18.1-eksbuild.3");
        assert_eq!(versions[1].version, "v1.17.0-eksbuild.2");
        assert_eq!(versions[2].version, "v1.16.0-eksbuild.1");
        assert_eq!(versions[3].version, "v1.9.0-eksbuild.1");
    }

    #[test]
    fn test_parse_addon_version() {
        assert_eq!(
            parse_addon_version("v1.18.1-eksbuild.3"),
            Some((1, 18, 1, 3))
        );
        assert_eq!(parse_addon_version("v1.9.0-eksbuild.1"), Some((1, 9, 0, 1)));
        assert_eq!(
            parse_addon_version("v2.0.0-eksbuild.10"),
            Some((2, 0, 0, 10))
        );
        // Without eksbuild suffix
        assert_eq!(parse_addon_version("v1.5.0"), Some((1, 5, 0, 0)));
        // Without v prefix
        assert_eq!(parse_addon_version("1.5.0-eksbuild.2"), Some((1, 5, 0, 2)));
        // Invalid
        assert_eq!(parse_addon_version("invalid"), None);
        assert_eq!(parse_addon_version("v1.2"), None);
    }

    #[test]
    fn test_compare_addon_versions() {
        use std::cmp::Ordering;

        // v1.18 > v1.9 (the bug case: lexicographic would say v1.9 > v1.18)
        assert_eq!(
            compare_addon_versions("v1.18.0-eksbuild.1", "v1.9.0-eksbuild.1"),
            Ordering::Greater
        );

        // Same version
        assert_eq!(
            compare_addon_versions("v1.18.1-eksbuild.3", "v1.18.1-eksbuild.3"),
            Ordering::Equal
        );

        // eksbuild number comparison
        assert_eq!(
            compare_addon_versions("v1.18.1-eksbuild.3", "v1.18.1-eksbuild.1"),
            Ordering::Greater
        );

        // Patch version comparison
        assert_eq!(
            compare_addon_versions("v1.18.2-eksbuild.1", "v1.18.1-eksbuild.3"),
            Ordering::Greater
        );

        // Fallback to string comparison for unparseable versions
        assert_eq!(
            compare_addon_versions("invalid-a", "invalid-b"),
            Ordering::Less
        );
    }
}

/// Poll addon status (non-blocking). Returns the current status string.
pub async fn poll_addon_status(
    client: &Client,
    cluster_name: &str,
    addon_name: &str,
) -> Result<String> {
    let response = client
        .describe_addon()
        .cluster_name(cluster_name)
        .addon_name(addon_name)
        .send()
        .await
        .map_err(|e| KuoError::aws(module_path!(), e))?;

    let status = response
        .addon()
        .and_then(|a| a.status())
        .map_or_else(|| "Unknown".to_string(), |s| s.as_str().to_string());

    Ok(status)
}
