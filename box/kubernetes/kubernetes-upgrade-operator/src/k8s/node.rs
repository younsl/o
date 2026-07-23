//! Node inspection helpers for Karpenter replacement.
//!
//! Pure version parsing and staleness decisions are unit-tested here. The thin
//! API wrappers that read live Node and Pod objects mirror `k8s::pdb` and are
//! exercised end-to-end against a cluster rather than in unit tests.

use anyhow::Result;
use k8s_openapi::api::core::v1::{Node, Pod};
use kube::Api;
use kube::api::ListParams;

use crate::error::KuoError;

/// Parse the minor version out of a Kubernetes version string.
///
/// Accepts forms such as `"v1.33.0-eks-abc123"`, `"1.34"`, or `"v1.34"`.
/// Returns the minor component (`33`, `34`) or `None` if it cannot be parsed.
#[must_use]
pub fn parse_minor(version: &str) -> Option<u32> {
    let trimmed = version.trim().trim_start_matches('v');
    let mut parts = trimmed.split('.');
    let _major = parts.next()?;
    let minor = parts.next()?;
    // Strip any suffix on the minor segment (unlikely, but defensive).
    let digits: String = minor.chars().take_while(char::is_ascii_digit).collect();
    digits.parse::<u32>().ok()
}

/// Whether a node's kubelet version is older than the target minor.
///
/// A node whose minor cannot be parsed is treated as NOT stale, so kuo never
/// deletes a node it cannot reason about.
#[must_use]
pub fn is_stale_kubelet(kubelet_version: &str, target_minor: u32) -> bool {
    parse_minor(kubelet_version).is_some_and(|m| m < target_minor)
}

/// Kubelet version reported by a Node's `status.nodeInfo`.
#[must_use]
pub fn kubelet_version(node: &Node) -> Option<&str> {
    node.status
        .as_ref()?
        .node_info
        .as_ref()
        .map(|ni| ni.kubelet_version.as_str())
}

/// Fetch a single Node by name.
pub async fn get(client: &kube::Client, name: &str) -> Result<Option<Node>> {
    let nodes: Api<Node> = Api::all(client.clone());
    nodes
        .get_opt(name)
        .await
        .map_err(|e| KuoError::KubernetesApi(format!("Failed to get node {name}: {e}")).into())
}

/// List all pods scheduled on a given node (across all namespaces) via the
/// `spec.nodeName` field selector.
pub async fn pods_on_node(client: &kube::Client, node_name: &str) -> Result<Vec<Pod>> {
    let pods: Api<Pod> = Api::all(client.clone());
    let params = ListParams::default().fields(&format!("spec.nodeName={node_name}"));
    let list = pods.list(&params).await.map_err(|e| {
        KuoError::KubernetesApi(format!("Failed to list pods on node {node_name}: {e}"))
    })?;
    Ok(list.items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_minor_eks_suffix() {
        assert_eq!(parse_minor("v1.33.0-eks-abc123"), Some(33));
    }

    #[test]
    fn test_parse_minor_plain() {
        assert_eq!(parse_minor("1.34"), Some(34));
        assert_eq!(parse_minor("v1.34"), Some(34));
        assert_eq!(parse_minor("1.34.2"), Some(34));
    }

    #[test]
    fn test_parse_minor_strips_trailing_nondigits() {
        assert_eq!(parse_minor("1.34+build"), Some(34));
        assert_eq!(parse_minor("v1.33rc1"), Some(33));
    }

    #[test]
    fn test_parse_minor_invalid() {
        assert_eq!(parse_minor("garbage"), None);
        assert_eq!(parse_minor("v1"), None);
        assert_eq!(parse_minor(""), None);
    }

    #[test]
    fn test_is_stale_kubelet_equal_minor_not_stale() {
        // Same minor as target is not stale (only strictly-lower is).
        assert!(!is_stale_kubelet("v1.34.9-eks-x", 34));
    }

    #[test]
    fn test_parse_minor_leading_whitespace() {
        assert_eq!(parse_minor("  v1.35.0  "), Some(35));
    }

    #[test]
    fn test_is_stale_kubelet() {
        assert!(is_stale_kubelet("v1.33.0-eks-abc", 34));
        assert!(!is_stale_kubelet("v1.34.0-eks-abc", 34));
        assert!(!is_stale_kubelet("v1.35.0-eks-abc", 34));
    }

    #[test]
    fn test_is_stale_kubelet_unparseable_is_not_stale() {
        assert!(!is_stale_kubelet("unknown", 34));
    }

    #[test]
    fn test_kubelet_version_reads_node_info() {
        use k8s_openapi::api::core::v1::{NodeStatus, NodeSystemInfo};
        let ni = NodeSystemInfo {
            kubelet_version: "v1.33.0-eks-abc".to_string(),
            ..Default::default()
        };
        let node = Node {
            status: Some(NodeStatus {
                node_info: Some(ni),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(kubelet_version(&node), Some("v1.33.0-eks-abc"));
        assert!(is_stale_kubelet(kubelet_version(&node).unwrap(), 34));
    }

    #[test]
    fn test_kubelet_version_absent() {
        assert_eq!(kubelet_version(&Node::default()), None);
    }
}
