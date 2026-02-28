//! NodePool operations via Kubernetes Dynamic API.
//!
//! Uses `karpenter.sh/v1` NodePool CRD to list, get, and patch
//! disruption settings including consolidation pause/resume.

use anyhow::Result;
use kube::Api;
use kube::api::{ApiResource, DynamicObject, ListParams, Patch, PatchParams};
use tracing::debug;

use crate::error::KarcError;

/// API versions to try in order.
const API_VERSIONS: &[&str] = &["v1", "v1beta1"];

/// ApiResource definition for `karpenter.sh` NodePool with a specific version.
fn nodepool_api_resource(version: &str) -> ApiResource {
    ApiResource {
        group: "karpenter.sh".to_string(),
        version: version.to_string(),
        api_version: format!("karpenter.sh/{}", version),
        kind: "NodePool".to_string(),
        plural: "nodepools".to_string(),
    }
}

/// Result of listing NodePools, including the detected API version.
#[derive(Debug)]
pub struct NodePoolList {
    pub api_version: String,
    pub nodepools: Vec<NodePoolInfo>,
}

/// Disruption budget entry from NodePool spec.
#[derive(Debug, Clone)]
pub struct Budget {
    pub nodes: Option<String>,
    pub schedule: Option<String>,
    pub duration: Option<String>,
    pub reasons: Vec<String>,
}

/// Disruption information extracted from a NodePool.
#[derive(Debug, Clone)]
pub struct DisruptionInfo {
    pub consolidation_policy: String,
    pub consolidate_after: String,
    pub budgets: Vec<Budget>,
}

/// Summarized NodePool information.
#[derive(Debug, Clone)]
pub struct NodePoolInfo {
    pub name: String,
    pub weight: Option<u32>,
    pub disruption: DisruptionInfo,
    pub is_paused: bool,
}

/// List all NodePool resources in the cluster.
///
/// Tries `karpenter.sh/v1` first, falls back to `v1beta1`.
pub async fn list_nodepools(client: &kube::Client) -> Result<NodePoolList> {
    for version in API_VERSIONS {
        match list_nodepools_with_version(client, version).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                debug!("NodePool {} query failed, trying next: {}", version, e);
            }
        }
    }

    Err(KarcError::KubernetesApi("Failed to list NodePools: CRD not found".to_string()).into())
}

/// List NodePools using a specific API version.
async fn list_nodepools_with_version(client: &kube::Client, version: &str) -> Result<NodePoolList> {
    let ar = nodepool_api_resource(version);
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let list = api
        .list(&ListParams::default())
        .await
        .map_err(|e| KarcError::KubernetesApi(format!("Failed to list NodePools: {}", e)))?;

    debug!(
        "Found {} NodePool resources (api version: {})",
        list.items.len(),
        version
    );

    let mut nodepools = Vec::new();
    for obj in &list.items {
        let name = obj
            .metadata
            .name
            .as_deref()
            .unwrap_or("unknown")
            .to_string();

        let weight = obj
            .data
            .get("spec")
            .and_then(|s| s.get("weight"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        let disruption = extract_disruption_info(&obj.data);
        let is_paused = has_pause_budget(&disruption.budgets);

        nodepools.push(NodePoolInfo {
            name,
            weight,
            disruption,
            is_paused,
        });
    }

    // Sort by name for stable output
    nodepools.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(NodePoolList {
        api_version: format!("karpenter.sh/{}", version),
        nodepools,
    })
}

/// Detect the working Karpenter API version by trying each in order.
async fn detect_api_version(client: &kube::Client) -> Result<String> {
    for version in API_VERSIONS {
        let ar = nodepool_api_resource(version);
        let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
        if api.list(&ListParams::default().limit(1)).await.is_ok() {
            return Ok(version.to_string());
        }
    }
    Err(KarcError::KubernetesApi("NodePool CRD not found".to_string()).into())
}

/// Get a single NodePool by name.
pub async fn get_nodepool(client: &kube::Client, name: &str) -> Result<NodePoolInfo> {
    let version = detect_api_version(client).await?;
    let ar = nodepool_api_resource(&version);
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);
    let obj = api.get(name).await.map_err(|e| {
        if e.to_string().contains("NotFound") {
            KarcError::NodePoolNotFound(name.to_string())
        } else {
            KarcError::KubernetesApi(format!("Failed to get NodePool '{}': {}", name, e))
        }
    })?;

    let weight = obj
        .data
        .get("spec")
        .and_then(|s| s.get("weight"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);
    let disruption = extract_disruption_info(&obj.data);
    let is_paused = has_pause_budget(&disruption.budgets);

    Ok(NodePoolInfo {
        name: name.to_string(),
        weight,
        disruption,
        is_paused,
    })
}

/// Pause consolidation by prepending `{nodes: "0"}` to budgets.
///
/// If the NodePool is already paused (has a zero-budget without schedule),
/// this is a no-op and returns `Ok(false)`.
pub async fn pause_nodepool(client: &kube::Client, name: &str) -> Result<bool> {
    let info = get_nodepool(client, name).await?;
    if info.is_paused {
        debug!("NodePool '{}' is already paused, skipping", name);
        return Ok(false);
    }

    let version = detect_api_version(client).await?;
    let ar = nodepool_api_resource(&version);
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);

    // Get current budgets from the raw object
    let obj = api.get(name).await?;
    let mut budgets = extract_raw_budgets(&obj.data);

    // Prepend pause budget
    budgets.insert(0, serde_json::json!({"nodes": "0"}));

    let patch = serde_json::json!({
        "spec": {
            "disruption": {
                "budgets": budgets
            }
        }
    });

    debug!("Pausing NodePool '{}' with patch: {:?}", name, patch);

    api.patch(name, &PatchParams::apply("karc"), &Patch::Merge(patch))
        .await
        .map_err(|e| {
            KarcError::KubernetesApi(format!("Failed to pause NodePool '{}': {}", name, e))
        })?;

    Ok(true)
}

/// Resume consolidation by removing pause budgets (`{nodes: "0"}` without schedule/duration).
///
/// Scheduled zero-budgets like `{nodes: "0", schedule: "...", duration: "..."}` are preserved.
/// If the NodePool is not paused, this is a no-op and returns `Ok(false)`.
pub async fn resume_nodepool(client: &kube::Client, name: &str) -> Result<bool> {
    let info = get_nodepool(client, name).await?;
    if !info.is_paused {
        debug!("NodePool '{}' is not paused, skipping", name);
        return Ok(false);
    }

    let version = detect_api_version(client).await?;
    let ar = nodepool_api_resource(&version);
    let api: Api<DynamicObject> = Api::all_with(client.clone(), &ar);

    let obj = api.get(name).await?;
    let budgets = extract_raw_budgets(&obj.data);

    // Remove pause budgets (nodes: "0" without schedule/duration)
    let filtered: Vec<serde_json::Value> = budgets
        .into_iter()
        .filter(|b| !is_pause_budget_value(b))
        .collect();

    let patch = serde_json::json!({
        "spec": {
            "disruption": {
                "budgets": if filtered.is_empty() {
                    // Karpenter requires at least one budget; use default 10%
                    vec![serde_json::json!({"nodes": "10%"})]
                } else {
                    filtered
                }
            }
        }
    });

    debug!("Resuming NodePool '{}' with patch: {:?}", name, patch);

    api.patch(name, &PatchParams::apply("karc"), &Patch::Merge(patch))
        .await
        .map_err(|e| {
            KarcError::KubernetesApi(format!("Failed to resume NodePool '{}': {}", name, e))
        })?;

    Ok(true)
}

/// Extract disruption info from NodePool JSON data.
fn extract_disruption_info(data: &serde_json::Value) -> DisruptionInfo {
    let spec = data.get("spec").and_then(|s| s.get("disruption"));

    let consolidation_policy = spec
        .and_then(|d| d.get("consolidationPolicy"))
        .and_then(|v| v.as_str())
        .unwrap_or("WhenEmptyOrUnderutilized")
        .to_string();

    let consolidate_after = spec
        .and_then(|d| d.get("consolidateAfter"))
        .and_then(|v| v.as_str())
        .unwrap_or("0s")
        .to_string();

    let budgets = spec
        .and_then(|d| d.get("budgets"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|b| Budget {
                    nodes: b
                        .get("nodes")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    schedule: b
                        .get("schedule")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    duration: b
                        .get("duration")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    reasons: b
                        .get("reasons")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|r| r.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_else(|| {
            vec![Budget {
                nodes: Some("10%".to_string()),
                schedule: None,
                duration: None,
                reasons: vec![],
            }]
        });

    DisruptionInfo {
        consolidation_policy,
        consolidate_after,
        budgets,
    }
}

/// Extract raw budget JSON values from NodePool data.
fn extract_raw_budgets(data: &serde_json::Value) -> Vec<serde_json::Value> {
    data.get("spec")
        .and_then(|s| s.get("disruption"))
        .and_then(|d| d.get("budgets"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default()
}

/// Check if any budget is a pause budget (nodes: "0" without schedule/duration).
pub fn has_pause_budget(budgets: &[Budget]) -> bool {
    budgets.iter().any(is_pause_budget)
}

/// Check if a budget is a pause entry: `nodes: "0"` without `schedule` and `duration`.
pub fn is_pause_budget(budget: &Budget) -> bool {
    budget.nodes.as_deref() == Some("0") && budget.schedule.is_none() && budget.duration.is_none()
}

/// Check if a raw JSON budget value is a pause entry.
fn is_pause_budget_value(value: &serde_json::Value) -> bool {
    let nodes = value.get("nodes").and_then(|v| v.as_str());
    let schedule = value.get("schedule");
    let duration = value.get("duration");

    nodes == Some("0")
        && (schedule.is_none() || schedule == Some(&serde_json::Value::Null))
        && (duration.is_none() || duration == Some(&serde_json::Value::Null))
}

/// Format budget nodes value for display.
pub fn format_budgets_summary(budgets: &[Budget]) -> String {
    let non_pause: Vec<&Budget> = budgets.iter().filter(|b| !is_pause_budget(b)).collect();

    if non_pause.is_empty() {
        return "10%".to_string();
    }

    // Show the first non-scheduled budget's nodes value
    non_pause
        .iter()
        .find(|b| b.schedule.is_none())
        .and_then(|b| b.nodes.as_deref())
        .unwrap_or("10%")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_pause_budget_true() {
        let budget = Budget {
            nodes: Some("0".to_string()),
            schedule: None,
            duration: None,
            reasons: vec![],
        };
        assert!(is_pause_budget(&budget));
    }

    #[test]
    fn test_is_pause_budget_with_schedule() {
        let budget = Budget {
            nodes: Some("0".to_string()),
            schedule: Some("0 9 * * 5".to_string()),
            duration: Some("8h".to_string()),
            reasons: vec![],
        };
        assert!(!is_pause_budget(&budget));
    }

    #[test]
    fn test_is_pause_budget_nonzero() {
        let budget = Budget {
            nodes: Some("10%".to_string()),
            schedule: None,
            duration: None,
            reasons: vec![],
        };
        assert!(!is_pause_budget(&budget));
    }

    #[test]
    fn test_is_pause_budget_none_nodes() {
        let budget = Budget {
            nodes: None,
            schedule: None,
            duration: None,
            reasons: vec![],
        };
        assert!(!is_pause_budget(&budget));
    }

    #[test]
    fn test_has_pause_budget() {
        let budgets = vec![
            Budget {
                nodes: Some("0".to_string()),
                schedule: None,
                duration: None,
                reasons: vec![],
            },
            Budget {
                nodes: Some("10%".to_string()),
                schedule: None,
                duration: None,
                reasons: vec![],
            },
        ];
        assert!(has_pause_budget(&budgets));
    }

    #[test]
    fn test_has_no_pause_budget() {
        let budgets = vec![Budget {
            nodes: Some("10%".to_string()),
            schedule: None,
            duration: None,
            reasons: vec![],
        }];
        assert!(!has_pause_budget(&budgets));
    }

    #[test]
    fn test_is_pause_budget_value_true() {
        let val = serde_json::json!({"nodes": "0"});
        assert!(is_pause_budget_value(&val));
    }

    #[test]
    fn test_is_pause_budget_value_with_schedule() {
        let val = serde_json::json!({"nodes": "0", "schedule": "0 9 * * 5", "duration": "8h"});
        assert!(!is_pause_budget_value(&val));
    }

    #[test]
    fn test_is_pause_budget_value_nonzero() {
        let val = serde_json::json!({"nodes": "10%"});
        assert!(!is_pause_budget_value(&val));
    }

    #[test]
    fn test_extract_disruption_info_full() {
        let data = serde_json::json!({
            "spec": {
                "disruption": {
                    "consolidationPolicy": "WhenEmpty",
                    "consolidateAfter": "Never",
                    "budgets": [
                        {"nodes": "5"},
                        {"nodes": "0", "schedule": "0 9 * * 5", "duration": "8h", "reasons": ["Underutilized"]}
                    ]
                }
            }
        });

        let info = extract_disruption_info(&data);
        assert_eq!(info.consolidation_policy, "WhenEmpty");
        assert_eq!(info.consolidate_after, "Never");
        assert_eq!(info.budgets.len(), 2);
        assert_eq!(info.budgets[0].nodes.as_deref(), Some("5"));
        assert!(info.budgets[0].schedule.is_none());
        assert_eq!(info.budgets[1].nodes.as_deref(), Some("0"));
        assert_eq!(info.budgets[1].schedule.as_deref(), Some("0 9 * * 5"));
        assert_eq!(info.budgets[1].reasons, vec!["Underutilized"]);
    }

    #[test]
    fn test_extract_disruption_info_defaults() {
        let data = serde_json::json!({
            "spec": {}
        });

        let info = extract_disruption_info(&data);
        assert_eq!(info.consolidation_policy, "WhenEmptyOrUnderutilized");
        assert_eq!(info.consolidate_after, "0s");
        assert_eq!(info.budgets.len(), 1);
        assert_eq!(info.budgets[0].nodes.as_deref(), Some("10%"));
    }

    #[test]
    fn test_extract_disruption_info_no_spec() {
        let data = serde_json::json!({});

        let info = extract_disruption_info(&data);
        assert_eq!(info.consolidation_policy, "WhenEmptyOrUnderutilized");
        assert_eq!(info.consolidate_after, "0s");
    }

    #[test]
    fn test_extract_raw_budgets() {
        let data = serde_json::json!({
            "spec": {
                "disruption": {
                    "budgets": [
                        {"nodes": "10%"},
                        {"nodes": "0", "schedule": "0 9 * * 5", "duration": "8h"}
                    ]
                }
            }
        });

        let budgets = extract_raw_budgets(&data);
        assert_eq!(budgets.len(), 2);
    }

    #[test]
    fn test_extract_raw_budgets_empty() {
        let data = serde_json::json!({});
        let budgets = extract_raw_budgets(&data);
        assert!(budgets.is_empty());
    }

    #[test]
    fn test_format_budgets_summary() {
        let budgets = vec![
            Budget {
                nodes: Some("10%".to_string()),
                schedule: None,
                duration: None,
                reasons: vec![],
            },
            Budget {
                nodes: Some("0".to_string()),
                schedule: Some("0 9 * * 5".to_string()),
                duration: Some("8h".to_string()),
                reasons: vec![],
            },
        ];
        assert_eq!(format_budgets_summary(&budgets), "10%");
    }

    #[test]
    fn test_format_budgets_summary_paused() {
        let budgets = vec![
            Budget {
                nodes: Some("0".to_string()),
                schedule: None,
                duration: None,
                reasons: vec![],
            },
            Budget {
                nodes: Some("5".to_string()),
                schedule: None,
                duration: None,
                reasons: vec![],
            },
        ];
        assert_eq!(format_budgets_summary(&budgets), "5");
    }

    #[test]
    fn test_budget_reasons_empty() {
        let budget = Budget {
            nodes: Some("0".to_string()),
            schedule: Some("0 0 * * 1-5".to_string()),
            duration: Some("2h".to_string()),
            reasons: vec![],
        };
        assert!(budget.reasons.is_empty());
    }

    #[test]
    fn test_budget_reasons_multiple() {
        let budget = Budget {
            nodes: Some("3".to_string()),
            schedule: Some("0 0 * * 1-5".to_string()),
            duration: Some("2h".to_string()),
            reasons: vec!["Empty".to_string(), "Drifted".to_string()],
        };
        assert_eq!(budget.reasons.len(), 2);
        assert_eq!(budget.reasons[0], "Empty");
        assert_eq!(budget.reasons[1], "Drifted");
    }

    #[test]
    fn test_is_pause_budget_value_null_schedule() {
        let val = serde_json::json!({"nodes": "0", "schedule": null, "duration": null});
        assert!(is_pause_budget_value(&val));
    }
}
