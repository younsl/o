//! `EKSUpgrade` spec types.

use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::status::EKSUpgradeStatus;

/// `EKSUpgrade` spec defines the desired state of an EKS cluster upgrade.
#[derive(CustomResource, Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[kube(
    group = "kuo.io",
    version = "v1alpha1",
    kind = "EKSUpgrade",
    status = "EKSUpgradeStatus",
    printcolumn = r#"{"name":"CLUSTER","type":"string","jsonPath":".spec.clusterName"}"#,
    printcolumn = r#"{"name":"TARGET","type":"string","jsonPath":".spec.targetVersion"}"#,
    printcolumn = r#"{"name":"PHASE","type":"string","jsonPath":".status.phase"}"#,
    printcolumn = r#"{"name":"AUTH","type":"string","jsonPath":".status.conditions[?(@.type==\"AWSAuthenticated\")].reason"}"#,
    printcolumn = r#"{"name":"AGE","type":"date","jsonPath":".metadata.creationTimestamp"}"#
)]
#[serde(rename_all = "camelCase")]
pub struct EKSUpgradeSpec {
    /// Name of the EKS cluster to upgrade.
    pub cluster_name: String,

    /// Target Kubernetes version (e.g., "1.34").
    pub target_version: String,

    /// AWS region where the cluster resides.
    pub region: String,

    /// Direction of the version change (required; must be set explicitly).
    ///
    /// `Forward` upgrades the cluster toward `targetVersion`. `Rollback`
    /// reverts a previously upgraded cluster to the previous minor version
    /// (N-1), mirroring the AWS EKS version rollback semantics: node groups
    /// roll back first, then add-ons, then the control plane. Only a single
    /// minor rollback (N to N-1) is supported.
    pub upgrade_mode: UpgradeMode,

    /// IAM Role ARN to assume for cross-account access.
    /// Works with both IRSA and EKS Pod Identity as the base credential source.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assume_role_arn: Option<String>,

    /// Optional add-on version overrides (addon name -> version).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub addon_versions: Option<std::collections::HashMap<String, String>>,

    /// Skip PDB drain deadlock check before node group rolling updates.
    #[serde(default)]
    pub skip_pdb_check: bool,

    /// Plan only, do not execute.
    #[serde(default)]
    pub dry_run: bool,

    /// Timeout configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeouts: Option<TimeoutConfig>,

    /// Slack notification configuration for this upgrade.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification: Option<NotificationConfig>,

    /// Karpenter `NodePool` node replacement configuration.
    ///
    /// When present and enabled, kuo rolls Karpenter-managed nodes after the
    /// managed node group phase completes. Absent or disabled leaves Karpenter
    /// nodes untouched (managed node groups only), preserving prior behaviour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub karpenter_node_pools: Option<KarpenterNodePoolsConfig>,
}

/// Direction of the version change for an `EKSUpgrade`.
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, Eq, JsonSchema)]
pub enum UpgradeMode {
    /// Upgrade the cluster toward a higher `targetVersion` (default).
    #[default]
    Forward,
    /// Roll the cluster back to the previous minor version (N-1).
    Rollback,
}

impl std::fmt::Display for UpgradeMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Forward => write!(f, "Forward"),
            Self::Rollback => write!(f, "Rollback"),
        }
    }
}

/// Slack notification configuration.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NotificationConfig {
    /// Send Slack notifications for actual upgrades (dryRun: false).
    #[serde(default)]
    pub on_upgrade: bool,
    /// Send Slack notifications for dry-run executions (dryRun: true).
    #[serde(default)]
    pub on_dry_run: bool,
}

/// Karpenter `NodePool` node replacement configuration.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KarpenterNodePoolsConfig {
    /// Enable Karpenter `NodePool` node replacement.
    #[serde(default)]
    pub enabled: bool,

    /// `NodePools` to process, in the listed order. An empty list or a single
    /// `ALL` entry (case-insensitive) selects every `NodePool` in the cluster.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_pools: Vec<String>,

    /// Replacement strategy. v1 supports `Replace` only.
    #[serde(default)]
    pub strategy: KarpenterStrategy,

    /// Maximum nodes replaced concurrently per `NodePool`.
    ///
    /// Accepts a bare integer (`"1"`) or a percentage (`"10%"`) of the
    /// `NodePool`'s node count. Defaults to `"1"` (strictly sequential).
    #[serde(default = "default_max_unavailable")]
    pub max_unavailable: String,

    /// Max minutes to wait for an old node to drain and be removed after the
    /// `NodeClaim` is deleted. Karpenter performs the drain; kuo waits. Default 15.
    #[serde(default = "default_node_drain_timeout")]
    pub node_drain_timeout_minutes: u64,

    /// Max minutes to wait for the controllers of evicted pods to become Ready
    /// again on other nodes before proceeding. Default 10.
    #[serde(default = "default_controller_stable_timeout")]
    pub controller_stable_timeout_minutes: u64,
}

/// Sentinel accepted in `nodePools` to explicitly select every `NodePool`.
pub const NODE_POOLS_ALL: &str = "ALL";

impl KarpenterNodePoolsConfig {
    /// Whether every `NodePool` in the cluster is targeted.
    ///
    /// True when `nodePools` is empty or contains the `ALL` sentinel
    /// (case-insensitive). Otherwise only the listed `NodePools` are processed.
    #[must_use]
    pub fn selects_all(&self) -> bool {
        self.node_pools.is_empty()
            || self
                .node_pools
                .iter()
                .any(|n| n.eq_ignore_ascii_case(NODE_POOLS_ALL))
    }

    /// Resolve `max_unavailable` against a `NodePool`'s node count.
    ///
    /// Returns at least 1 (a value of 0 would make no progress). A percentage
    /// rounds down but is likewise floored at 1. An unparseable value falls back
    /// to 1 rather than erroring, keeping replacement conservative.
    #[must_use]
    pub fn resolve_max_unavailable(&self, total_nodes: usize) -> usize {
        let raw = self.max_unavailable.trim();
        let parsed = raw.strip_suffix('%').map_or_else(
            || raw.parse::<usize>().ok(),
            |pct| {
                pct.trim()
                    .parse::<usize>()
                    .ok()
                    .map(|p| total_nodes.saturating_mul(p) / 100)
            },
        );
        parsed.unwrap_or(1).max(1)
    }
}

/// Karpenter node replacement strategy.
#[derive(Deserialize, Serialize, Clone, Debug, Default, PartialEq, Eq, JsonSchema)]
pub enum KarpenterStrategy {
    /// kuo deletes `NodeClaims` directly and controls order, pace, and stability
    /// checks. Karpenter performs cordon/drain/provisioning.
    #[default]
    Replace,
}

impl std::fmt::Display for KarpenterStrategy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Replace => write!(f, "Replace"),
        }
    }
}

fn default_max_unavailable() -> String {
    "1".to_string()
}
const fn default_node_drain_timeout() -> u64 {
    15
}
const fn default_controller_stable_timeout() -> u64 {
    10
}

/// Timeout configuration for upgrade operations.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TimeoutConfig {
    /// Control plane upgrade timeout in minutes (default: 30).
    #[serde(default = "default_cp_timeout")]
    pub control_plane_minutes: u64,

    /// Node group upgrade timeout in minutes (default: 60).
    #[serde(default = "default_ng_timeout")]
    pub nodegroup_minutes: u64,
}

const fn default_cp_timeout() -> u64 {
    30
}
const fn default_ng_timeout() -> u64 {
    60
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_timeouts() {
        assert_eq!(default_cp_timeout(), 30);
        assert_eq!(default_ng_timeout(), 60);
    }

    #[test]
    fn test_timeout_config_serde_defaults() {
        let json = r"{}";
        let config: TimeoutConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.control_plane_minutes, 30);
        assert_eq!(config.nodegroup_minutes, 60);
    }

    #[test]
    fn test_upgrade_mode_display() {
        assert_eq!(UpgradeMode::Forward.to_string(), "Forward");
        assert_eq!(UpgradeMode::Rollback.to_string(), "Rollback");
    }

    #[test]
    fn test_karpenter_config_serde_defaults() {
        let json = r#"{"enabled":true}"#;
        let config: KarpenterNodePoolsConfig = serde_json::from_str(json).unwrap();
        assert!(config.enabled);
        assert!(config.node_pools.is_empty());
        assert_eq!(config.strategy, KarpenterStrategy::Replace);
        assert_eq!(config.max_unavailable, "1");
        assert_eq!(config.node_drain_timeout_minutes, 15);
        assert_eq!(config.controller_stable_timeout_minutes, 10);
    }

    #[test]
    fn test_karpenter_strategy_display_and_default() {
        assert_eq!(KarpenterStrategy::default(), KarpenterStrategy::Replace);
        assert_eq!(KarpenterStrategy::Replace.to_string(), "Replace");
    }

    #[test]
    fn test_selects_all() {
        let mk = |pools: Vec<&str>| KarpenterNodePoolsConfig {
            enabled: true,
            node_pools: pools.into_iter().map(String::from).collect(),
            strategy: KarpenterStrategy::Replace,
            max_unavailable: "1".to_string(),
            node_drain_timeout_minutes: 15,
            controller_stable_timeout_minutes: 10,
        };
        assert!(mk(vec![]).selects_all());
        assert!(mk(vec!["ALL"]).selects_all());
        assert!(mk(vec!["all"]).selects_all());
        assert!(mk(vec!["default", "ALL"]).selects_all());
        assert!(!mk(vec!["default", "spot"]).selects_all());
    }

    #[test]
    fn test_resolve_max_unavailable_integer() {
        let config = KarpenterNodePoolsConfig {
            enabled: true,
            node_pools: vec![],
            strategy: KarpenterStrategy::Replace,
            max_unavailable: "3".to_string(),
            node_drain_timeout_minutes: 15,
            controller_stable_timeout_minutes: 10,
        };
        assert_eq!(config.resolve_max_unavailable(10), 3);
        assert_eq!(config.resolve_max_unavailable(1), 3);
    }

    #[test]
    fn test_resolve_max_unavailable_percentage() {
        let config = KarpenterNodePoolsConfig {
            enabled: true,
            node_pools: vec![],
            strategy: KarpenterStrategy::Replace,
            max_unavailable: "30%".to_string(),
            node_drain_timeout_minutes: 15,
            controller_stable_timeout_minutes: 10,
        };
        assert_eq!(config.resolve_max_unavailable(10), 3);
        // 30% of 5 = 1.5 -> floors to 1.
        assert_eq!(config.resolve_max_unavailable(5), 1);
        // 30% of 2 = 0.6 -> floors to 0 -> clamped to 1.
        assert_eq!(config.resolve_max_unavailable(2), 1);
    }

    #[test]
    fn test_resolve_max_unavailable_zero_clamped_and_whitespace() {
        let mk = |mu: &str| KarpenterNodePoolsConfig {
            enabled: true,
            node_pools: vec![],
            strategy: KarpenterStrategy::Replace,
            max_unavailable: mu.to_string(),
            node_drain_timeout_minutes: 15,
            controller_stable_timeout_minutes: 10,
        };
        assert_eq!(mk("0").resolve_max_unavailable(10), 1);
        assert_eq!(mk("  2  ").resolve_max_unavailable(10), 2);
        assert_eq!(mk("0%").resolve_max_unavailable(10), 1);
        assert_eq!(mk("100%").resolve_max_unavailable(4), 4);
    }

    #[test]
    fn test_resolve_max_unavailable_invalid_falls_back_to_one() {
        let config = KarpenterNodePoolsConfig {
            enabled: true,
            node_pools: vec![],
            strategy: KarpenterStrategy::Replace,
            max_unavailable: "garbage".to_string(),
            node_drain_timeout_minutes: 15,
            controller_stable_timeout_minutes: 10,
        };
        assert_eq!(config.resolve_max_unavailable(10), 1);
    }

    #[test]
    fn test_spec_without_karpenter_config() {
        let json =
            r#"{"clusterName":"c","targetVersion":"1.34","region":"r","upgradeMode":"Forward"}"#;
        let spec: EKSUpgradeSpec = serde_json::from_str(json).unwrap();
        assert!(spec.karpenter_node_pools.is_none());
    }

    #[test]
    fn test_upgrade_mode_required_in_deserialization() {
        // upgradeMode has no serde default: a spec omitting it must fail.
        let json = r#"{"clusterName":"c","targetVersion":"1.34","region":"r"}"#;
        assert!(serde_json::from_str::<EKSUpgradeSpec>(json).is_err());

        let json =
            r#"{"clusterName":"c","targetVersion":"1.34","region":"r","upgradeMode":"Rollback"}"#;
        let spec: EKSUpgradeSpec = serde_json::from_str(json).unwrap();
        assert_eq!(spec.upgrade_mode, UpgradeMode::Rollback);
    }
}
