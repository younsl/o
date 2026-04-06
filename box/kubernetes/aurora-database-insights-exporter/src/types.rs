/// Represents a discovered Aurora MySQL instance with Performance Insights enabled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuroraInstance {
    pub dbi_resource_id: String,
    pub db_instance_identifier: String,
    pub engine: String,
    pub db_cluster_identifier: String,
    pub db_instance_class: String,
    pub vcpu: u32,
    /// Exported AWS tags as (key, value) pairs. Keys are normalized to `tag_<lowercase>`.
    pub exported_tags: Vec<(String, String)>,
}

impl AuroraInstance {
    /// Derive vCPU count from instance class using a static lookup table.
    /// Returns 0 for unknown instance classes.
    pub fn vcpu_from_instance_class(instance_class: &str) -> u32 {
        // Extract size suffix after "db.<family>."
        // e.g., "db.r6g.large" -> "large", "db.r6g.2xlarge" -> "2xlarge"
        let size = instance_class.rsplit('.').next().unwrap_or("");

        match size {
            "micro" => 1,
            "small" => 1,
            "medium" => 1,
            "large" => 2,
            "xlarge" => 4,
            "2xlarge" => 8,
            "4xlarge" => 16,
            "8xlarge" => 32,
            "12xlarge" => 48,
            "16xlarge" => 64,
            "24xlarge" => 96,
            "metal" => 96,
            // Serverless v2
            _ if instance_class.contains("serverless") => 0,
            _ => 0,
        }
    }
}

/// Labels common to all instance-level Prometheus metrics.
/// Includes base labels + exported AWS tags as dynamic labels.
#[derive(Debug, Clone)]
pub struct InstanceLabels {
    pub instance: String,
    pub resource_id: String,
    pub engine: String,
    pub region: String,
    pub cluster: String,
    /// Exported tag values in the same order as the config's exported_tags.
    /// Label names are `tag_<lowercase_key>`.
    pub tag_values: Vec<String>,
}

impl InstanceLabels {
    pub fn from_instance(inst: &AuroraInstance, region: &str) -> Self {
        Self {
            instance: inst.db_instance_identifier.clone(),
            resource_id: inst.dbi_resource_id.clone(),
            engine: inst.engine.clone(),
            region: region.to_string(),
            cluster: inst.db_cluster_identifier.clone(),
            tag_values: inst.exported_tags.iter().map(|(_, v)| v.clone()).collect(),
        }
    }

    /// Returns base label values as a Vec (5 base + N tag values).
    pub fn as_vec(&self) -> Vec<&str> {
        let mut v = vec![
            self.instance.as_str(),
            self.resource_id.as_str(),
            self.engine.as_str(),
            self.region.as_str(),
            self.cluster.as_str(),
        ];
        for tv in &self.tag_values {
            v.push(tv.as_str());
        }
        v
    }
}

/// Normalize an AWS tag key to a Prometheus label name: `tag_<lowercase_snake>`.
pub fn tag_key_to_label(key: &str) -> String {
    let normalized = key.to_lowercase().replace(['-', '.', '/', ' ', ':'], "_");
    format!("tag_{normalized}")
}

/// Collected metrics snapshot for a single instance.
#[derive(Debug, Clone)]
pub struct MetricSnapshot {
    pub labels: InstanceLabels,
    pub db_load: f64,
    pub db_load_cpu: f64,
    pub db_load_non_cpu: f64,
    pub vcpu: u32,
    pub wait_events: Vec<WaitEventMetric>,
    pub top_sql: Vec<SqlMetric>,
    pub users: Vec<UserMetric>,
    pub hosts: Vec<HostMetric>,
    pub databases: Vec<DatabaseMetric>,
}

#[derive(Debug, Clone)]
pub struct WaitEventMetric {
    pub wait_event: String,
    pub wait_event_type: String,
    pub value: f64,
}

#[derive(Debug, Clone)]
pub struct SqlMetric {
    pub sql_id: String,
    pub sql_text: String,
    pub sql_text_truncated: bool,
    pub value: f64,
    pub calls_per_sec: f64,
    pub avg_latency_per_call: f64,
}

#[derive(Debug, Clone)]
pub struct UserMetric {
    pub db_user: String,
    pub value: f64,
}

#[derive(Debug, Clone)]
pub struct HostMetric {
    pub client_host: String,
    pub value: f64,
}

#[derive(Debug, Clone)]
pub struct DatabaseMetric {
    pub db_name: String,
    pub value: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vcpu_lookup_standard_sizes() {
        assert_eq!(AuroraInstance::vcpu_from_instance_class("db.r6g.large"), 2);
        assert_eq!(AuroraInstance::vcpu_from_instance_class("db.r6g.xlarge"), 4);
        assert_eq!(
            AuroraInstance::vcpu_from_instance_class("db.r6g.2xlarge"),
            8
        );
        assert_eq!(
            AuroraInstance::vcpu_from_instance_class("db.r6g.4xlarge"),
            16
        );
        assert_eq!(
            AuroraInstance::vcpu_from_instance_class("db.r6g.8xlarge"),
            32
        );
        assert_eq!(
            AuroraInstance::vcpu_from_instance_class("db.r6g.16xlarge"),
            64
        );
    }

    #[test]
    fn test_vcpu_lookup_small_sizes() {
        assert_eq!(AuroraInstance::vcpu_from_instance_class("db.t3.micro"), 1);
        assert_eq!(AuroraInstance::vcpu_from_instance_class("db.t3.small"), 1);
        assert_eq!(AuroraInstance::vcpu_from_instance_class("db.t3.medium"), 1);
    }

    #[test]
    fn test_vcpu_lookup_unknown() {
        assert_eq!(
            AuroraInstance::vcpu_from_instance_class("db.unknown.foo"),
            0
        );
        assert_eq!(AuroraInstance::vcpu_from_instance_class(""), 0);
    }

    #[test]
    fn test_vcpu_lookup_serverless() {
        assert_eq!(AuroraInstance::vcpu_from_instance_class("db.serverless"), 0);
    }

    #[test]
    fn test_instance_labels_from_instance() {
        let inst = AuroraInstance {
            dbi_resource_id: "db-ABC123".to_string(),
            db_instance_identifier: "prod-writer".to_string(),
            engine: "aurora-mysql".to_string(),
            db_cluster_identifier: "prod-cluster".to_string(),
            db_instance_class: "db.r6g.large".to_string(),
            vcpu: 2,
            exported_tags: vec![("Team".to_string(), "platform".to_string())],
        };
        let labels = InstanceLabels::from_instance(&inst, "ap-northeast-2");
        assert_eq!(labels.instance, "prod-writer");
        assert_eq!(labels.resource_id, "db-ABC123");
        assert_eq!(labels.region, "ap-northeast-2");
        assert_eq!(labels.tag_values, vec!["platform"]);
        assert_eq!(labels.cluster, "prod-cluster");
    }

    #[test]
    fn test_instance_labels_as_vec() {
        let labels = InstanceLabels {
            instance: "w".to_string(),
            resource_id: "db-X".to_string(),
            engine: "aurora-mysql".to_string(),
            region: "us-east-1".to_string(),
            cluster: "c".to_string(),
            tag_values: vec!["team-a".to_string()],
        };
        let v = labels.as_vec();
        assert_eq!(
            v,
            vec!["w", "db-X", "aurora-mysql", "us-east-1", "c", "team-a"]
        );
    }

    #[test]
    fn test_tag_key_to_label() {
        assert_eq!(tag_key_to_label("Team"), "tag_team");
        assert_eq!(tag_key_to_label("Environment"), "tag_environment");
        assert_eq!(tag_key_to_label("app-name"), "tag_app_name");
        assert_eq!(
            tag_key_to_label("aws:cloudformation:stack-name"),
            "tag_aws_cloudformation_stack_name"
        );
    }

    #[test]
    fn test_sql_metric_truncation_flag() {
        let short = SqlMetric {
            sql_id: "A".to_string(),
            sql_text: "SELECT 1".to_string(),
            sql_text_truncated: false,
            value: 1.0,
            calls_per_sec: 0.0,
            avg_latency_per_call: 0.0,
        };
        assert!(!short.sql_text_truncated);

        let long = SqlMetric {
            sql_id: "B".to_string(),
            sql_text: "x".repeat(200),
            sql_text_truncated: true,
            value: 2.0,
            calls_per_sec: 0.0,
            avg_latency_per_call: 0.0,
        };
        assert!(long.sql_text_truncated);
    }
}
