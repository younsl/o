//! Karpenter v1 API access (`NodePool`, `NodeClaim`, `EC2NodeClass`).
//!
//! Karpenter CRDs are addressed through kube's dynamic API. The pure AMI-pin
//! detection is unit-tested; the API wrappers are exercised against a cluster.

use anyhow::Result;
use chrono::{DateTime, Utc};
use kube::api::{Api, DeleteParams, DynamicObject, ListParams};
use kube::core::{ApiResource, GroupVersionKind};

use crate::error::KuoError;

/// Label Karpenter sets on both Nodes and `NodeClaims` identifying their `NodePool`.
pub const NODEPOOL_LABEL: &str = "karpenter.sh/nodepool";

fn nodepool_resource() -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("karpenter.sh", "v1", "NodePool"),
        "nodepools",
    )
}

fn nodeclaim_resource() -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("karpenter.sh", "v1", "NodeClaim"),
        "nodeclaims",
    )
}

fn ec2nodeclass_resource() -> ApiResource {
    ApiResource::from_gvk_with_plural(
        &GroupVersionKind::gvk("karpenter.k8s.aws", "v1", "EC2NodeClass"),
        "ec2nodeclasses",
    )
}

/// A `NodeClaim` as kuo needs it: its name and the backing node/instance.
#[derive(Debug, Clone)]
pub struct NodeClaimInfo {
    pub name: String,
    pub node_name: Option<String>,
    pub provider_id: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
}

fn nodeclaim_info(obj: &DynamicObject) -> NodeClaimInfo {
    let status = obj.data.get("status");
    NodeClaimInfo {
        name: obj.metadata.name.clone().unwrap_or_default(),
        node_name: status
            .and_then(|s| s.get("nodeName"))
            .and_then(|v| v.as_str())
            .map(String::from),
        provider_id: status
            .and_then(|s| s.get("providerID"))
            .and_then(|v| v.as_str())
            .map(String::from),
        created_at: obj
            .metadata
            .creation_timestamp
            .as_ref()
            .and_then(|t| DateTime::from_timestamp(t.0.as_second(), 0)),
    }
}

/// Whether the Karpenter v1 API (`NodePool`) is served by the cluster.
///
/// A `404` from the API server means the CRD/version is not installed; any
/// other error propagates.
pub async fn v1_available(client: &kube::Client) -> Result<bool> {
    let ar = nodepool_resource();
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    match api.list(&ListParams::default().limit(1)).await {
        Ok(_) => Ok(true),
        Err(kube::Error::Api(resp)) if resp.code == 404 => Ok(false),
        Err(e) => {
            Err(KuoError::KubernetesApi(format!("Failed to probe Karpenter v1 API: {e}")).into())
        }
    }
}

/// List all `NodePool` names in the cluster.
pub async fn list_nodepool_names(client: &kube::Client) -> Result<Vec<String>> {
    let ar = nodepool_resource();
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| KuoError::KubernetesApi(format!("Failed to list NodePools: {e}")))?;
    Ok(list
        .items
        .into_iter()
        .filter_map(|o| o.metadata.name)
        .collect())
}

/// List `NodeClaims` belonging to a `NodePool`.
pub async fn list_nodeclaims(client: &kube::Client, nodepool: &str) -> Result<Vec<NodeClaimInfo>> {
    let ar = nodeclaim_resource();
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let params = ListParams::default().labels(&format!("{NODEPOOL_LABEL}={nodepool}"));
    let list = api.list(&params).await.map_err(|e| {
        KuoError::KubernetesApi(format!("Failed to list NodeClaims for {nodepool}: {e}"))
    })?;
    Ok(list.items.iter().map(nodeclaim_info).collect())
}

/// Delete a `NodeClaim` by name. Karpenter then cordons, drains, and reprovisions.
pub async fn delete_nodeclaim(client: &kube::Client, name: &str) -> Result<()> {
    let ar = nodeclaim_resource();
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    api.delete(name, &DeleteParams::default())
        .await
        .map_err(|e| KuoError::KubernetesApi(format!("Failed to delete NodeClaim {name}: {e}")))?;
    Ok(())
}

/// Whether a `NodeClaim` still exists (used to confirm removal after delete).
pub async fn nodeclaim_exists(client: &kube::Client, name: &str) -> Result<bool> {
    let ar = nodeclaim_resource();
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let got = api
        .get_opt(name)
        .await
        .map_err(|e| KuoError::KubernetesApi(format!("Failed to get NodeClaim {name}: {e}")))?;
    Ok(got.is_some())
}

/// Read the `amiSelectorTerms` of the `EC2NodeClass` referenced by a `NodePool`.
///
/// Returns the raw term objects so the caller can apply [`is_pinned_ami`].
pub async fn nodepool_ami_terms(
    client: &kube::Client,
    nodepool: &str,
) -> Result<Vec<serde_json::Value>> {
    let np_ar = nodepool_resource();
    let np_api: Api<DynamicObject> = Api::all_with(client.clone(), &np_ar);
    let np = np_api
        .get(nodepool)
        .await
        .map_err(|e| KuoError::KubernetesApi(format!("Failed to get NodePool {nodepool}: {e}")))?;

    let class_name = np
        .data
        .pointer("/spec/template/spec/nodeClassRef/name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            KuoError::KubernetesApi(format!("NodePool {nodepool} has no nodeClassRef.name"))
        })?;

    let ec_ar = ec2nodeclass_resource();
    let ec_api: Api<DynamicObject> = Api::all_with(client.clone(), &ec_ar);
    let ec = ec_api.get(class_name).await.map_err(|e| {
        KuoError::KubernetesApi(format!("Failed to get EC2NodeClass {class_name}: {e}"))
    })?;

    Ok(ec
        .data
        .pointer("/spec/amiSelectorTerms")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

/// Whether any `amiSelectorTerms` entry pins the AMI to a fixed version.
///
/// Only `alias: <family>@latest` tracks the cluster version. A term with an
/// explicit `id`, or an alias pinned to a dated version, or any term that
/// carries neither an `alias` nor a resolvable latest reference, is treated as
/// pinned and rejected, because replacing a node would reprovision the same AMI.
#[must_use]
pub fn is_pinned_ami(terms: &[serde_json::Value]) -> bool {
    terms.iter().any(|t| {
        if t.get("id").is_some() {
            return true;
        }
        t.get("alias")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|alias| !alias.ends_with("@latest"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_resource_constructors_have_correct_plurals() {
        assert_eq!(nodepool_resource().plural, "nodepools");
        assert_eq!(nodeclaim_resource().plural, "nodeclaims");
        assert_eq!(ec2nodeclass_resource().plural, "ec2nodeclasses");
        assert_eq!(nodeclaim_resource().group, "karpenter.sh");
        assert_eq!(ec2nodeclass_resource().group, "karpenter.k8s.aws");
        assert_eq!(nodepool_resource().version, "v1");
    }

    #[test]
    fn test_is_pinned_ami_latest_ok() {
        let terms = vec![json!({"alias": "al2023@latest"})];
        assert!(!is_pinned_ami(&terms));
    }

    #[test]
    fn test_is_pinned_ami_dated_alias() {
        let terms = vec![json!({"alias": "al2023@v20250601"})];
        assert!(is_pinned_ami(&terms));
    }

    #[test]
    fn test_is_pinned_ami_explicit_id() {
        let terms = vec![json!({"id": "ami-0abc123"})];
        assert!(is_pinned_ami(&terms));
    }

    #[test]
    fn test_is_pinned_ami_mixed_rejects() {
        let terms = vec![json!({"alias": "al2023@latest"}), json!({"id": "ami-0abc"})];
        assert!(is_pinned_ami(&terms));
    }

    #[test]
    fn test_is_pinned_ami_no_alias_no_id_rejected() {
        let terms = vec![json!({"tags": {"team": "platform"}})];
        assert!(is_pinned_ami(&terms));
    }

    #[test]
    fn test_is_pinned_ami_empty_is_not_pinned() {
        assert!(!is_pinned_ami(&[]));
    }

    #[test]
    fn test_nodeclaim_info_extracts_fields() {
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "karpenter.sh/v1",
            "kind": "NodeClaim",
            "metadata": {
                "name": "spot-ghi56",
                "labels": {"karpenter.sh/nodepool": "spot"}
            },
            "status": {
                "nodeName": "ip-10-0-1-23.ap-northeast-2.compute.internal",
                "providerID": "aws:///ap-northeast-2a/i-0abc123"
            }
        }))
        .unwrap();
        let info = nodeclaim_info(&obj);
        assert_eq!(info.name, "spot-ghi56");
        assert_eq!(
            info.node_name.as_deref(),
            Some("ip-10-0-1-23.ap-northeast-2.compute.internal")
        );
        assert_eq!(
            info.provider_id.as_deref(),
            Some("aws:///ap-northeast-2a/i-0abc123")
        );
    }

    #[test]
    fn test_nodeclaim_info_missing_status() {
        let obj: DynamicObject = serde_json::from_value(json!({
            "apiVersion": "karpenter.sh/v1",
            "kind": "NodeClaim",
            "metadata": {"name": "pending-xyz"}
        }))
        .unwrap();
        let info = nodeclaim_info(&obj);
        assert_eq!(info.name, "pending-xyz");
        assert!(info.node_name.is_none());
        assert!(info.provider_id.is_none());
    }
}
