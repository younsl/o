//! NodeClaim count per NodePool via Kubernetes Dynamic API.

use std::collections::HashMap;

use anyhow::Result;
use kube::Api;
use kube::api::{ApiResource, DynamicObject, ListParams};
use tracing::debug;

/// ApiResource definition for `karpenter.sh/v1` NodeClaim.
fn nodeclaim_api_resource() -> ApiResource {
    ApiResource {
        group: "karpenter.sh".to_string(),
        version: "v1".to_string(),
        api_version: "karpenter.sh/v1".to_string(),
        kind: "NodeClaim".to_string(),
        plural: "nodeclaims".to_string(),
    }
}

/// Count NodeClaims grouped by their owning NodePool.
///
/// Returns a map of NodePool name to NodeClaim count.
/// If the NodeClaim CRD is not installed, returns an empty map.
pub async fn count_by_nodepool(client: &kube::Client) -> Result<HashMap<String, usize>> {
    let ar = nodeclaim_api_resource();
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);

    let list = match api.list(&ListParams::default()).await {
        Ok(list) => list,
        Err(e) => {
            debug!("Failed to list NodeClaims (CRD may not exist): {}", e);
            return Ok(HashMap::new());
        }
    };

    debug!("Found {} NodeClaim resources", list.items.len());

    let mut counts: HashMap<String, usize> = HashMap::new();
    for obj in &list.items {
        let nodepool_name = obj
            .metadata
            .labels
            .as_ref()
            .and_then(|labels| labels.get("karpenter.sh/nodepool"))
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());

        *counts.entry(nodepool_name).or_insert(0) += 1;
    }

    Ok(counts)
}
