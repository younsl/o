//! `EC2Schedule` spec types.

use std::collections::HashMap;

use kube::CustomResource;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::status::EC2ScheduleStatus;

/// `EC2Schedule` spec defines the desired state of an EC2 scheduling rule.
#[derive(CustomResource, Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[kube(
    group = "ec2-scheduler.io",
    version = "v1alpha1",
    kind = "EC2Schedule",
    namespaced,
    status = "EC2ScheduleStatus",
    printcolumn = r#"{"name":"REGION","type":"string","jsonPath":".spec.region"}"#,
    printcolumn = r#"{"name":"TIMEZONE","type":"string","jsonPath":".spec.timezone"}"#,
    printcolumn = r#"{"name":"PAUSED","type":"boolean","jsonPath":".spec.paused"}"#,
    printcolumn = r#"{"name":"PHASE","type":"string","jsonPath":".status.phase"}"#,
    printcolumn = r#"{"name":"RUNNING","type":"integer","jsonPath":".status.runningCount"}"#,
    printcolumn = r#"{"name":"STOPPED","type":"integer","jsonPath":".status.stoppedCount"}"#,
    printcolumn = r#"{"name":"AGE","type":"date","jsonPath":".metadata.creationTimestamp"}"#
)]
#[serde(rename_all = "camelCase")]
pub struct EC2ScheduleSpec {
    /// AWS region where the EC2 instances reside.
    pub region: String,

    /// IANA timezone for cron schedule evaluation (e.g., `Asia/Seoul`, `America/New_York`).
    #[serde(default = "default_timezone")]
    pub timezone: String,

    /// Instance selector defining which EC2 instances to manage.
    pub instance_selector: InstanceSelector,

    /// Cron-based schedules for start/stop actions.
    pub schedules: Vec<ScheduleEntry>,

    /// Pause all scheduling actions. Follows the Kubernetes Deployment `.spec.paused` convention.
    /// When true, the controller skips start/stop execution and sets phase to Paused.
    #[serde(default)]
    pub paused: bool,

    /// Dry-run mode. When true, the controller logs actions without executing them.
    #[serde(default)]
    pub dry_run: bool,

    /// IAM Role ARN to assume for cross-account access.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assume_role_arn: Option<String>,
}

/// Instance selector defining which EC2 instances to manage.
/// At least one of `instance_ids` or `tags` must be specified.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSelector {
    /// Explicit list of EC2 instance IDs to manage.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instance_ids: Vec<String>,

    /// Tags to filter instances. All tags must match (AND logic).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub tags: HashMap<String, String>,
}

/// A single schedule entry with start and stop cron expressions.
#[derive(Deserialize, Serialize, Clone, Debug, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleEntry {
    /// Human-readable name for this schedule (e.g., "weekday").
    pub name: String,

    /// Cron expression for starting instances (e.g., "0 9 * * 1-5").
    pub start: String,

    /// Cron expression for stopping instances (e.g., "0 18 * * 1-5").
    pub stop: String,
}

fn default_timezone() -> String {
    "UTC".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_timezone() {
        assert_eq!(default_timezone(), "UTC");
    }

    #[test]
    fn test_schedule_entry_serde() {
        let json = r#"{"name":"weekday","start":"0 9 * * 1-5","stop":"0 18 * * 1-5"}"#;
        let entry: ScheduleEntry = serde_json::from_str(json).unwrap();
        assert_eq!(entry.name, "weekday");
        assert_eq!(entry.start, "0 9 * * 1-5");
        assert_eq!(entry.stop, "0 18 * * 1-5");
    }

    #[test]
    fn test_instance_selector_tags_only() {
        let json = r#"{"tags":{"Environment":"development","Team":"platform"}}"#;
        let selector: InstanceSelector = serde_json::from_str(json).unwrap();
        assert!(selector.instance_ids.is_empty());
        assert_eq!(selector.tags.len(), 2);
        assert_eq!(selector.tags.get("Environment").unwrap(), "development");
        assert_eq!(selector.tags.get("Team").unwrap(), "platform");
    }

    #[test]
    fn test_instance_selector_ids_only() {
        let json = r#"{"instanceIds":["i-abc","i-def"]}"#;
        let selector: InstanceSelector = serde_json::from_str(json).unwrap();
        assert_eq!(selector.instance_ids, vec!["i-abc", "i-def"]);
        assert!(selector.tags.is_empty());
    }

    #[test]
    fn test_instance_selector_both() {
        let json = r#"{"instanceIds":["i-abc"],"tags":{"Env":"dev"}}"#;
        let selector: InstanceSelector = serde_json::from_str(json).unwrap();
        assert_eq!(selector.instance_ids, vec!["i-abc"]);
        assert_eq!(selector.tags.get("Env").unwrap(), "dev");
    }

    #[test]
    fn test_spec_defaults() {
        let json = r#"{
            "region": "ap-northeast-2",
            "instanceSelector": {"instanceIds": ["i-123"]},
            "schedules": [{"name": "test", "start": "0 9 * * *", "stop": "0 18 * * *"}]
        }"#;
        let spec: EC2ScheduleSpec = serde_json::from_str(json).unwrap();
        assert_eq!(spec.timezone, "UTC");
        assert!(!spec.paused);
        assert!(!spec.dry_run);
        assert_eq!(spec.instance_selector.instance_ids, vec!["i-123"]);
        assert!(spec.assume_role_arn.is_none());
    }
}
