//! Karpenter EC2NodeClass CRD query for amiSelectorTerms.
//!
//! Uses the Kubernetes Dynamic API to query EC2NodeClass resources
//! and extract AMI selector configuration for upgrade visibility.

use anyhow::Result;
use kube::Api;
use kube::api::{ApiResource, DynamicObject, ListParams};
use tracing::debug;

/// A single AMI selector term from EC2NodeClass spec.
#[derive(Debug, Clone)]
pub struct AmiSelectorTerm {
    pub alias: Option<String>,
    pub id: Option<String>,
    pub name: Option<String>,
    pub owner: Option<String>,
    pub tags: Option<std::collections::HashMap<String, String>>,
}

/// Information about a single EC2NodeClass.
#[derive(Debug, Clone)]
pub struct Ec2NodeClassInfo {
    pub name: String,
    pub ami_selector_terms: Vec<AmiSelectorTerm>,
}

/// Summary of all Karpenter EC2NodeClass resources.
#[derive(Debug, Clone)]
pub struct KarpenterSummary {
    pub node_classes: Vec<Ec2NodeClassInfo>,
}

/// Check all EC2NodeClass resources in the cluster.
///
/// Tries `karpenter.k8s.aws/v1` first, falls back to `v1beta1`.
/// Returns an empty summary if the CRD is not installed (non-fatal).
pub async fn check_ec2_node_classes(client: &kube::Client) -> Result<KarpenterSummary> {
    // Try v1 first
    match list_ec2_node_classes(client, "v1").await {
        Ok(summary) => return Ok(summary),
        Err(e) => {
            debug!("EC2NodeClass v1 query failed, trying v1beta1: {}", e);
        }
    }

    // Fallback to v1beta1
    match list_ec2_node_classes(client, "v1beta1").await {
        Ok(summary) => Ok(summary),
        Err(e) => {
            debug!(
                "EC2NodeClass v1beta1 query also failed (CRD likely not installed): {}",
                e
            );
            Ok(KarpenterSummary {
                node_classes: vec![],
            })
        }
    }
}

/// List EC2NodeClass resources using a specific API version.
async fn list_ec2_node_classes(client: &kube::Client, version: &str) -> Result<KarpenterSummary> {
    let ar = ApiResource {
        group: "karpenter.k8s.aws".to_string(),
        version: version.to_string(),
        api_version: format!("karpenter.k8s.aws/{}", version),
        kind: "EC2NodeClass".to_string(),
        plural: "ec2nodeclasses".to_string(),
    };

    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let list = api.list(&ListParams::default()).await.map_err(|e| {
        crate::error::KupError::KubernetesApi(format!("Failed to list EC2NodeClasses: {}", e))
    })?;

    debug!(
        "Found {} EC2NodeClass resources (api version: {})",
        list.items.len(),
        version
    );

    let mut node_classes = Vec::new();
    for obj in &list.items {
        let name = obj
            .metadata
            .name
            .as_deref()
            .unwrap_or("unknown")
            .to_string();

        let ami_selector_terms = obj
            .data
            .get("spec")
            .map(extract_ami_selector_terms)
            .unwrap_or_default();

        node_classes.push(Ec2NodeClassInfo {
            name,
            ami_selector_terms,
        });
    }

    Ok(KarpenterSummary { node_classes })
}

/// Extract amiSelectorTerms from EC2NodeClass spec JSON.
fn extract_ami_selector_terms(spec: &serde_json::Value) -> Vec<AmiSelectorTerm> {
    let terms = match spec.get("amiSelectorTerms").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return vec![],
    };

    terms
        .iter()
        .map(|term| {
            let tags = term.get("tags").and_then(|t| t.as_object()).map(|obj| {
                obj.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                    .collect()
            });

            AmiSelectorTerm {
                alias: term
                    .get("alias")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                id: term
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                name: term
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                owner: term
                    .get("owner")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                tags,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_ami_selector_terms_alias() {
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                { "alias": "al2023@v20250117" }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].alias.as_deref(), Some("al2023@v20250117"));
        assert!(terms[0].id.is_none());
        assert!(terms[0].name.is_none());
        assert!(terms[0].owner.is_none());
        assert!(terms[0].tags.is_none());
    }

    #[test]
    fn test_extract_ami_selector_terms_id() {
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                { "id": "ami-0123456789abcdef0" }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].id.as_deref(), Some("ami-0123456789abcdef0"));
        assert!(terms[0].alias.is_none());
    }

    #[test]
    fn test_extract_ami_selector_terms_with_tags() {
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                {
                    "name": "my-ami-*",
                    "owner": "123456789012",
                    "tags": {
                        "Environment": "production",
                        "Team": "platform"
                    }
                }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].name.as_deref(), Some("my-ami-*"));
        assert_eq!(terms[0].owner.as_deref(), Some("123456789012"));
        let tags = terms[0].tags.as_ref().unwrap();
        assert_eq!(tags.get("Environment").unwrap(), "production");
        assert_eq!(tags.get("Team").unwrap(), "platform");
    }

    #[test]
    fn test_extract_ami_selector_terms_multiple() {
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                { "alias": "al2023@latest" },
                { "id": "ami-0123456789abcdef0" }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 2);
        assert_eq!(terms[0].alias.as_deref(), Some("al2023@latest"));
        assert_eq!(terms[1].id.as_deref(), Some("ami-0123456789abcdef0"));
    }

    #[test]
    fn test_extract_ami_selector_terms_empty() {
        let spec = serde_json::json!({
            "amiSelectorTerms": []
        });

        let terms = extract_ami_selector_terms(&spec);
        assert!(terms.is_empty());
    }

    #[test]
    fn test_extract_ami_selector_terms_missing() {
        let spec = serde_json::json!({
            "someOtherField": "value"
        });

        let terms = extract_ami_selector_terms(&spec);
        assert!(terms.is_empty());
    }

    #[test]
    fn test_karpenter_summary_empty() {
        let summary = KarpenterSummary {
            node_classes: vec![],
        };
        assert!(summary.node_classes.is_empty());
    }

    #[test]
    fn test_ec2_node_class_info() {
        let info = Ec2NodeClassInfo {
            name: "default".to_string(),
            ami_selector_terms: vec![AmiSelectorTerm {
                alias: Some("al2023@v20250117".to_string()),
                id: None,
                name: None,
                owner: None,
                tags: None,
            }],
        };

        assert_eq!(info.name, "default");
        assert_eq!(info.ami_selector_terms.len(), 1);
    }

    #[test]
    fn test_extract_ami_selector_terms_tags_only() {
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                {
                    "tags": {
                        "karpenter.sh/discovery": "my-cluster"
                    }
                }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 1);
        assert!(terms[0].alias.is_none());
        assert!(terms[0].id.is_none());
        assert!(terms[0].name.is_none());
        assert!(terms[0].owner.is_none());
        let tags = terms[0].tags.as_ref().unwrap();
        assert_eq!(tags.get("karpenter.sh/discovery").unwrap(), "my-cluster");
    }

    #[test]
    fn test_extract_ami_selector_terms_owner_only() {
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                { "owner": "123456789012" }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].owner.as_deref(), Some("123456789012"));
        assert!(terms[0].alias.is_none());
        assert!(terms[0].id.is_none());
        assert!(terms[0].name.is_none());
        assert!(terms[0].tags.is_none());
    }

    #[test]
    fn test_extract_ami_selector_terms_all_fields() {
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                {
                    "alias": "al2023@latest",
                    "id": "ami-0123456789abcdef0",
                    "name": "my-custom-ami-*",
                    "owner": "123456789012",
                    "tags": { "Environment": "prod" }
                }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 1);
        assert_eq!(terms[0].alias.as_deref(), Some("al2023@latest"));
        assert_eq!(terms[0].id.as_deref(), Some("ami-0123456789abcdef0"));
        assert_eq!(terms[0].name.as_deref(), Some("my-custom-ami-*"));
        assert_eq!(terms[0].owner.as_deref(), Some("123456789012"));
        assert_eq!(
            terms[0].tags.as_ref().unwrap().get("Environment").unwrap(),
            "prod"
        );
    }

    #[test]
    fn test_extract_ami_selector_terms_not_array() {
        let spec = serde_json::json!({
            "amiSelectorTerms": "invalid"
        });

        let terms = extract_ami_selector_terms(&spec);
        assert!(terms.is_empty());
    }

    #[test]
    fn test_extract_ami_selector_terms_null_values() {
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                {
                    "alias": null,
                    "id": null
                }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 1);
        assert!(terms[0].alias.is_none());
        assert!(terms[0].id.is_none());
    }

    #[test]
    fn test_extract_ami_selector_terms_empty_tags() {
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                { "tags": {} }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 1);
        let tags = terms[0].tags.as_ref().unwrap();
        assert!(tags.is_empty());
    }

    #[test]
    fn test_extract_ami_selector_terms_spec_is_null() {
        let spec = serde_json::json!(null);
        let terms = extract_ami_selector_terms(&spec);
        assert!(terms.is_empty());
    }

    #[test]
    fn test_extract_ami_selector_terms_spec_is_empty_object() {
        let spec = serde_json::json!({});
        let terms = extract_ami_selector_terms(&spec);
        assert!(terms.is_empty());
    }

    #[test]
    fn test_karpenter_summary_multiple_node_classes() {
        let summary = KarpenterSummary {
            node_classes: vec![
                Ec2NodeClassInfo {
                    name: "default".to_string(),
                    ami_selector_terms: vec![AmiSelectorTerm {
                        alias: Some("al2023@latest".to_string()),
                        id: None,
                        name: None,
                        owner: None,
                        tags: None,
                    }],
                },
                Ec2NodeClassInfo {
                    name: "gpu".to_string(),
                    ami_selector_terms: vec![AmiSelectorTerm {
                        alias: None,
                        id: Some("ami-gpu123".to_string()),
                        name: None,
                        owner: None,
                        tags: None,
                    }],
                },
            ],
        };

        assert_eq!(summary.node_classes.len(), 2);
        assert_eq!(summary.node_classes[0].name, "default");
        assert_eq!(summary.node_classes[1].name, "gpu");
    }

    #[test]
    fn test_ec2_node_class_info_empty_terms() {
        let info = Ec2NodeClassInfo {
            name: "no-selector".to_string(),
            ami_selector_terms: vec![],
        };

        assert_eq!(info.name, "no-selector");
        assert!(info.ami_selector_terms.is_empty());
    }

    #[test]
    fn test_extract_ami_selector_terms_tags_non_string_values() {
        // Tags with non-string values should be filtered out
        let spec = serde_json::json!({
            "amiSelectorTerms": [
                {
                    "tags": {
                        "valid": "value",
                        "number": 42,
                        "bool": true
                    }
                }
            ]
        });

        let terms = extract_ami_selector_terms(&spec);
        assert_eq!(terms.len(), 1);
        let tags = terms[0].tags.as_ref().unwrap();
        // Only string values are collected
        assert_eq!(tags.len(), 1);
        assert_eq!(tags.get("valid").unwrap(), "value");
    }
}
