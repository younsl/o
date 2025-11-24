use anyhow::{Context, Result};
use aws_sdk_ec2::types::Tag;
use std::collections::HashMap;
use tracing::{debug, info};

use super::Ec2Client;

// EKS worker node identification tags
const EKS_NODE_TAG_PATTERNS: &[&str] = &[
    "kubernetes.io/cluster/", // Prefix pattern
    "eks:cluster-name",
    "eks:nodegroup-name",
];

const TAG_NAME: &str = "Name";
const TAG_EKS_CLUSTER: &str = "eks:cluster-name";
const TAG_K8S_CLUSTER_PREFIX: &str = "kubernetes.io/cluster/";

impl Ec2Client {
    pub(super) async fn get_instance_tags(
        &self,
        instance_ids: &[String],
    ) -> Result<HashMap<String, String>> {
        if instance_ids.is_empty() {
            return Ok(HashMap::new());
        }

        debug!(
            instance_count = instance_ids.len(),
            "Fetching tags for instances"
        );

        let response = self
            .client
            .describe_instances()
            .set_instance_ids(Some(instance_ids.to_vec()))
            .send()
            .await
            .context("Failed to describe instances for tags")?;

        info!(
            instance_count = instance_ids.len(),
            eks_node_tag_patterns = ?EKS_NODE_TAG_PATTERNS,
            "Starting EKS worker node filtering check to exclude cluster nodes from monitoring"
        );

        let (tags_map, eks_nodes_excluded) = Self::process_instance_tags(&response);

        Self::log_eks_filtering_results(eks_nodes_excluded, instance_ids.len());

        debug!(
            tagged_instances = tags_map.len(),
            "Fetched instance name tags"
        );

        Ok(tags_map)
    }

    fn process_instance_tags(
        response: &aws_sdk_ec2::operation::describe_instances::DescribeInstancesOutput,
    ) -> (HashMap<String, String>, usize) {
        let mut tags_map = HashMap::new();
        let mut eks_nodes_excluded = 0;

        for reservation in response.reservations() {
            for instance in reservation.instances() {
                if let Some(instance_id) = instance.instance_id() {
                    let tags = instance.tags();

                    if Self::is_eks_worker_node(tags) {
                        Self::log_eks_node_exclusion(instance_id, tags);
                        eks_nodes_excluded += 1;
                        continue;
                    }

                    if let Some(name_tag_value) = Self::find_tag_value(tags, TAG_NAME) {
                        tags_map.insert(instance_id.to_string(), name_tag_value);
                    }
                }
            }
        }

        (tags_map, eks_nodes_excluded)
    }

    pub(super) fn is_eks_worker_node(tags: &[Tag]) -> bool {
        tags.iter()
            .any(|tag| tag.key().is_some_and(Self::matches_eks_tag_pattern))
    }

    pub(super) fn matches_eks_tag_pattern(key: &str) -> bool {
        EKS_NODE_TAG_PATTERNS.iter().any(|pattern| {
            if pattern.ends_with('/') {
                key.starts_with(pattern)
            } else {
                key == *pattern
            }
        })
    }

    fn log_eks_node_exclusion(instance_id: &str, tags: &[Tag]) {
        let instance_name = Self::find_tag_value(tags, TAG_NAME).unwrap_or("N/A".to_string());
        let cluster_name = Self::extract_cluster_name(tags);

        debug!(
            instance_id = %instance_id,
            instance_name = %instance_name,
            cluster_name = %cluster_name,
            "Excluding EKS worker node from monitoring"
        );
    }

    fn extract_cluster_name(tags: &[Tag]) -> String {
        Self::find_tag_value(tags, TAG_EKS_CLUSTER)
            .or_else(|| Self::extract_cluster_name_from_k8s_tag(tags))
            .unwrap_or_else(|| "unknown".to_string())
    }

    fn extract_cluster_name_from_k8s_tag(tags: &[Tag]) -> Option<String> {
        tags.iter()
            .find(|tag| {
                tag.key()
                    .is_some_and(|k| k.starts_with(TAG_K8S_CLUSTER_PREFIX))
            })
            .and_then(|tag| tag.key())
            .map(|k| {
                k.strip_prefix(TAG_K8S_CLUSTER_PREFIX)
                    .unwrap_or("unknown")
                    .to_string()
            })
    }

    fn find_tag_value(tags: &[Tag], key: &str) -> Option<String> {
        tags.iter()
            .find(|tag| tag.key() == Some(key))
            .and_then(|tag| tag.value())
            .map(|v| v.to_string())
    }

    fn log_eks_filtering_results(eks_nodes_excluded: usize, total_instances: usize) {
        if eks_nodes_excluded > 0 {
            info!(
                eks_nodes_excluded = eks_nodes_excluded,
                total_instances_checked = total_instances,
                "EKS worker nodes excluded from monitoring"
            );
        } else {
            info!(
                total_instances_checked = total_instances,
                "No EKS worker nodes found, all instances eligible for monitoring"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_tag(key: &str, value: &str) -> Tag {
        Tag::builder().key(key).value(value).build()
    }

    mod is_eks_worker_node_tests {
        use super::*;

        #[test]
        fn test_empty_tags_is_not_eks_node() {
            let tags: Vec<Tag> = vec![];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                false,
                "Empty tags should not be identified as EKS worker node"
            );
        }

        #[test]
        fn test_kubernetes_cluster_tag_prefix_match() {
            let tags = vec![
                create_tag("kubernetes.io/cluster/my-cluster", "owned"),
                create_tag("Name", "my-instance"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                true,
                "Tag with kubernetes.io/cluster/ prefix should identify as EKS worker node"
            );
        }

        #[test]
        fn test_kubernetes_cluster_tag_different_cluster_names() {
            let test_cases = vec![
                "kubernetes.io/cluster/production",
                "kubernetes.io/cluster/staging",
                "kubernetes.io/cluster/dev-env",
                "kubernetes.io/cluster/test_cluster_123",
            ];

            for cluster_tag in test_cases {
                let tags = vec![create_tag(cluster_tag, "owned")];
                assert_eq!(
                    Ec2Client::is_eks_worker_node(&tags),
                    true,
                    "Tag '{}' should identify as EKS worker node",
                    cluster_tag
                );
            }
        }

        #[test]
        fn test_eks_cluster_name_tag() {
            let tags = vec![
                create_tag("eks:cluster-name", "my-cluster"),
                create_tag("Name", "my-instance"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                true,
                "Tag 'eks:cluster-name' should identify as EKS worker node"
            );
        }

        #[test]
        fn test_eks_nodegroup_name_tag() {
            let tags = vec![
                create_tag("eks:nodegroup-name", "my-nodegroup"),
                create_tag("Name", "my-instance"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                true,
                "Tag 'eks:nodegroup-name' should identify as EKS worker node"
            );
        }

        #[test]
        fn test_all_eks_tags_present() {
            let tags = vec![
                create_tag("kubernetes.io/cluster/my-cluster", "owned"),
                create_tag("eks:cluster-name", "my-cluster"),
                create_tag("eks:nodegroup-name", "my-nodegroup"),
                create_tag("Name", "my-worker-node"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                true,
                "Instance with all EKS tags should be identified as EKS worker node"
            );
        }

        #[test]
        fn test_non_eks_instance_with_name_tag_only() {
            let tags = vec![
                create_tag("Name", "my-standalone-instance"),
                create_tag("Environment", "production"),
                create_tag("Application", "database"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                false,
                "Instance with only common tags should NOT be identified as EKS worker node"
            );
        }

        #[test]
        fn test_similar_but_not_eks_tags() {
            let tags = vec![
                create_tag("kubernetes", "true"),
                create_tag("cluster", "my-cluster"),
                create_tag("eks", "true"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                false,
                "Similar but incorrect tag names should NOT identify as EKS worker node"
            );
        }

        #[test]
        fn test_kubernetes_tag_without_cluster_prefix() {
            let tags = vec![
                create_tag("kubernetes.io/role/master", "true"),
                create_tag("Name", "my-instance"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                false,
                "kubernetes.io tags without cluster/ prefix should NOT identify as EKS worker node"
            );
        }

        #[test]
        fn test_case_sensitivity() {
            let tags = vec![
                create_tag("KUBERNETES.IO/CLUSTER/MY-CLUSTER", "owned"),
                create_tag("EKS:CLUSTER-NAME", "my-cluster"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                false,
                "Tag matching is case-sensitive, uppercase tags should NOT match"
            );
        }

        #[test]
        fn test_partial_prefix_match_should_not_match() {
            let tags = vec![
                create_tag("kubernetes.io/cluste", "owned"), // Missing 'r'
                create_tag("eks:cluster", "my-cluster"),     // Missing '-name'
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                false,
                "Partial prefix matches should NOT identify as EKS worker node"
            );
        }

        #[test]
        fn test_tag_with_empty_key() {
            let tags = vec![
                Tag::builder().key("").value("some-value").build(),
                create_tag("Name", "my-instance"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                false,
                "Tag with empty key should not cause panic or false positive"
            );
        }

        #[test]
        fn test_tag_without_key() {
            let tags = vec![
                Tag::builder().value("some-value").build(),
                create_tag("Name", "my-instance"),
            ];
            assert_eq!(
                Ec2Client::is_eks_worker_node(&tags),
                false,
                "Tag without key should not cause panic or false positive"
            );
        }
    }

    mod matches_eks_tag_pattern_tests {
        use super::*;

        #[test]
        fn test_exact_match_eks_cluster_name() {
            assert_eq!(
                Ec2Client::matches_eks_tag_pattern("eks:cluster-name"),
                true,
                "Exact match 'eks:cluster-name' should return true"
            );
        }

        #[test]
        fn test_exact_match_eks_nodegroup_name() {
            assert_eq!(
                Ec2Client::matches_eks_tag_pattern("eks:nodegroup-name"),
                true,
                "Exact match 'eks:nodegroup-name' should return true"
            );
        }

        #[test]
        fn test_prefix_match_kubernetes_cluster() {
            assert_eq!(
                Ec2Client::matches_eks_tag_pattern("kubernetes.io/cluster/my-cluster"),
                true,
                "Prefix match 'kubernetes.io/cluster/' should return true"
            );
        }

        #[test]
        fn test_prefix_match_various_cluster_names() {
            let test_cases = vec![
                "kubernetes.io/cluster/prod",
                "kubernetes.io/cluster/staging-env",
                "kubernetes.io/cluster/dev_cluster",
                "kubernetes.io/cluster/123-test",
            ];

            for key in test_cases {
                assert_eq!(
                    Ec2Client::matches_eks_tag_pattern(key),
                    true,
                    "Key '{}' with kubernetes.io/cluster/ prefix should return true",
                    key
                );
            }
        }

        #[test]
        fn test_no_match_common_tags() {
            let test_cases = vec!["Name", "Environment", "Application", "Owner", "Project"];

            for key in test_cases {
                assert_eq!(
                    Ec2Client::matches_eks_tag_pattern(key),
                    false,
                    "Common tag '{}' should return false",
                    key
                );
            }
        }

        #[test]
        fn test_no_match_similar_but_different() {
            let test_cases = vec![
                "kubernetes",
                "kubernetes.io",
                "kubernetes.io/cluster",     // Missing trailing '/'
                "kubernetes.io/cluste/",     // Typo
                "eks:cluster",               // Missing '-name'
                "eks:nodegroup",             // Missing '-name'
                "eks-cluster-name",          // Wrong format
                "kubernetes.io/role/master", // Different k8s tag
            ];

            for key in test_cases {
                assert_eq!(
                    Ec2Client::matches_eks_tag_pattern(key),
                    false,
                    "Similar but different tag '{}' should return false",
                    key
                );
            }
        }

        #[test]
        fn test_empty_string() {
            assert_eq!(
                Ec2Client::matches_eks_tag_pattern(""),
                false,
                "Empty string should return false"
            );
        }

        #[test]
        fn test_case_sensitivity() {
            assert_eq!(
                Ec2Client::matches_eks_tag_pattern("EKS:CLUSTER-NAME"),
                false,
                "Uppercase variant should return false (case sensitive)"
            );
            assert_eq!(
                Ec2Client::matches_eks_tag_pattern("KUBERNETES.IO/CLUSTER/"),
                false,
                "Uppercase k8s prefix should return false (case sensitive)"
            );
        }
    }
}
