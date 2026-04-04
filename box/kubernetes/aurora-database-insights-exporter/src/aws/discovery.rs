use std::sync::Arc;

use aws_sdk_rds::Client as RdsClient;
use regex::Regex;
use tokio::sync::RwLock;

use crate::config::DiscoveryConfig;
use crate::types::AuroraInstance;

/// Trait for RDS instance discovery (enables testing with mocks).
#[allow(async_fn_in_trait)]
pub trait RdsDiscoverer: Send + Sync {
    async fn describe_instances(&self) -> Result<Vec<RdsInstanceInfo>, String>;
}

/// Raw instance info from RDS API before filtering.
#[derive(Debug, Clone)]
pub struct RdsInstanceInfo {
    pub dbi_resource_id: String,
    pub db_instance_identifier: String,
    pub engine: String,
    pub db_cluster_identifier: String,
    pub db_instance_class: String,
    pub performance_insights_enabled: bool,
    pub tags: Vec<(String, String)>,
}

/// Real AWS RDS discoverer using the SDK.
pub struct AwsRdsDiscoverer {
    client: RdsClient,
}

impl AwsRdsDiscoverer {
    pub fn new(client: RdsClient) -> Self {
        Self { client }
    }
}

impl RdsDiscoverer for AwsRdsDiscoverer {
    async fn describe_instances(&self) -> Result<Vec<RdsInstanceInfo>, String> {
        let mut instances = Vec::new();
        let mut marker = None;

        loop {
            let mut req = self.client.describe_db_instances();
            if let Some(ref m) = marker {
                req = req.marker(m);
            }

            let resp = req.send().await.map_err(|e| e.to_string())?;

            for db in resp.db_instances() {
                let engine = db.engine.as_deref().unwrap_or_default();
                let info = RdsInstanceInfo {
                    dbi_resource_id: db
                        .dbi_resource_id
                        .as_deref()
                        .unwrap_or_default()
                        .to_string(),
                    db_instance_identifier: db
                        .db_instance_identifier
                        .as_deref()
                        .unwrap_or_default()
                        .to_string(),
                    engine: engine.to_string(),
                    db_cluster_identifier: db
                        .db_cluster_identifier
                        .as_deref()
                        .unwrap_or_default()
                        .to_string(),
                    db_instance_class: db
                        .db_instance_class
                        .as_deref()
                        .unwrap_or_default()
                        .to_string(),
                    performance_insights_enabled: db.performance_insights_enabled.unwrap_or(false),
                    tags: db
                        .tag_list()
                        .iter()
                        .filter_map(|t: &aws_sdk_rds::types::Tag| {
                            Some((t.key.as_ref()?.to_string(), t.value.as_ref()?.to_string()))
                        })
                        .collect(),
                };
                instances.push(info);
            }

            marker = resp.marker().map(|s| s.to_string());
            if marker.is_none() {
                break;
            }
        }

        Ok(instances)
    }
}

/// Filter and convert raw RDS instances to AuroraInstances.
pub fn filter_instances(
    raw: &[RdsInstanceInfo],
    config: &DiscoveryConfig,
) -> Result<Vec<AuroraInstance>, String> {
    let include_patterns: Vec<Regex> = config
        .include
        .identifier
        .iter()
        .map(|p| Regex::new(p))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Invalid include pattern: {e}"))?;

    let exclude_patterns: Vec<Regex> = config
        .exclude
        .identifier
        .iter()
        .map(|p| Regex::new(p))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Invalid exclude pattern: {e}"))?;

    let mut result = Vec::new();

    for inst in raw {
        // Engine filter
        if inst.engine != config.engine {
            continue;
        }

        // Performance Insights filter
        if config.require_pi_enabled && !inst.performance_insights_enabled {
            continue;
        }

        // Include filter: if patterns exist, at least one must match
        if !include_patterns.is_empty()
            && !include_patterns
                .iter()
                .any(|p| p.is_match(&inst.db_instance_identifier))
        {
            continue;
        }

        // Tag include filter: all specified tags must match
        if !config.include.tags.is_empty() {
            let all_tags_match = config.include.tags.iter().all(|tf| {
                inst.tags
                    .iter()
                    .any(|(k, v)| k == &tf.key && v == &tf.value)
            });
            if !all_tags_match {
                continue;
            }
        }

        // Exclude filter: if any pattern matches, skip
        if exclude_patterns
            .iter()
            .any(|p| p.is_match(&inst.db_instance_identifier))
        {
            continue;
        }

        let vcpu = AuroraInstance::vcpu_from_instance_class(&inst.db_instance_class);

        // Extract exported tag values in config order
        let exported_tags: Vec<(String, String)> = config
            .exported_tags
            .iter()
            .map(|key| {
                let value = inst
                    .tags
                    .iter()
                    .find(|(k, _)| k == key)
                    .map(|(_, v)| v.clone())
                    .unwrap_or_default();
                (key.clone(), value)
            })
            .collect();

        result.push(AuroraInstance {
            dbi_resource_id: inst.dbi_resource_id.clone(),
            db_instance_identifier: inst.db_instance_identifier.clone(),
            engine: inst.engine.clone(),
            db_cluster_identifier: inst.db_cluster_identifier.clone(),
            db_instance_class: inst.db_instance_class.clone(),
            vcpu,
            exported_tags,
        });
    }

    Ok(result)
}

/// Result of a discovery cycle.
pub struct DiscoveryCycleResult {
    pub added: usize,
    pub removed_instances: Vec<AuroraInstance>,
    pub total: usize,
}

/// Run one discovery cycle: fetch instances from RDS and update shared state.
pub async fn run_discovery_cycle<D: RdsDiscoverer>(
    discoverer: &D,
    config: &DiscoveryConfig,
    state: &Arc<RwLock<Vec<AuroraInstance>>>,
) -> Result<DiscoveryCycleResult, String> {
    let raw = discoverer.describe_instances().await?;
    let new_instances = filter_instances(&raw, config)?;

    let mut current = state.write().await;
    let new_ids: std::collections::HashSet<_> = new_instances
        .iter()
        .map(|i| i.dbi_resource_id.clone())
        .collect();

    // Find removed instances before replacing
    let removed_instances: Vec<AuroraInstance> = current
        .iter()
        .filter(|i| !new_ids.contains(&i.dbi_resource_id))
        .cloned()
        .collect();

    let old_ids: std::collections::HashSet<_> =
        current.iter().map(|i| i.dbi_resource_id.clone()).collect();
    let added = new_ids.difference(&old_ids).count();
    let total = new_instances.len();

    *current = new_instances;

    Ok(DiscoveryCycleResult {
        added,
        removed_instances,
        total,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_raw_instance(
        id: &str,
        engine: &str,
        pi_enabled: bool,
        class: &str,
        tags: Vec<(&str, &str)>,
    ) -> RdsInstanceInfo {
        RdsInstanceInfo {
            dbi_resource_id: format!("db-{id}"),
            db_instance_identifier: id.to_string(),
            engine: engine.to_string(),
            db_cluster_identifier: "cluster-1".to_string(),
            db_instance_class: class.to_string(),
            performance_insights_enabled: pi_enabled,
            tags: tags
                .into_iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn default_discovery_config() -> DiscoveryConfig {
        DiscoveryConfig::default()
    }

    #[test]
    fn test_filter_aurora_mysql_only() {
        let raw = vec![
            make_raw_instance(
                "aurora-writer",
                "aurora-mysql",
                true,
                "db.r6g.large",
                vec![],
            ),
            make_raw_instance(
                "pg-writer",
                "aurora-postgresql",
                true,
                "db.r6g.large",
                vec![],
            ),
            make_raw_instance("mysql-rds", "mysql", true, "db.r6g.large", vec![]),
        ];
        let config = default_discovery_config();
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].db_instance_identifier, "aurora-writer");
    }

    #[test]
    fn test_filter_pi_enabled_only() {
        let raw = vec![
            make_raw_instance("writer-pi", "aurora-mysql", true, "db.r6g.large", vec![]),
            make_raw_instance("writer-nopi", "aurora-mysql", false, "db.r6g.large", vec![]),
        ];
        let config = default_discovery_config();
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].db_instance_identifier, "writer-pi");
    }

    #[test]
    fn test_filter_include_pattern() {
        let raw = vec![
            make_raw_instance("prod-writer", "aurora-mysql", true, "db.r6g.large", vec![]),
            make_raw_instance("dev-writer", "aurora-mysql", true, "db.r6g.large", vec![]),
        ];
        let mut config = default_discovery_config();
        config.include.identifier = vec!["^prod-".to_string()];
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].db_instance_identifier, "prod-writer");
    }

    #[test]
    fn test_filter_exclude_pattern() {
        let raw = vec![
            make_raw_instance("prod-writer", "aurora-mysql", true, "db.r6g.large", vec![]),
            make_raw_instance(
                "prod-test-writer",
                "aurora-mysql",
                true,
                "db.r6g.large",
                vec![],
            ),
        ];
        let mut config = default_discovery_config();
        config.exclude.identifier = vec!["-test-".to_string()];
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].db_instance_identifier, "prod-writer");
    }

    #[test]
    fn test_filter_tag_match() {
        let raw = vec![
            make_raw_instance(
                "prod-writer",
                "aurora-mysql",
                true,
                "db.r6g.large",
                vec![("Environment", "production")],
            ),
            make_raw_instance(
                "dev-writer",
                "aurora-mysql",
                true,
                "db.r6g.large",
                vec![("Environment", "development")],
            ),
        ];
        let mut config = default_discovery_config();
        config.include.tags = vec![crate::config::TagFilter {
            key: "Environment".to_string(),
            value: "production".to_string(),
        }];
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].db_instance_identifier, "prod-writer");
    }

    #[test]
    fn test_filter_vcpu_derived() {
        let raw = vec![make_raw_instance(
            "writer",
            "aurora-mysql",
            true,
            "db.r6g.2xlarge",
            vec![],
        )];
        let config = default_discovery_config();
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result[0].vcpu, 8);
    }

    #[test]
    fn test_filter_empty_input() {
        let config = default_discovery_config();
        let result = filter_instances(&[], &config).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn test_filter_invalid_regex() {
        let raw = vec![make_raw_instance(
            "writer",
            "aurora-mysql",
            true,
            "db.r6g.large",
            vec![],
        )];
        let mut config = default_discovery_config();
        config.include.identifier = vec!["[invalid".to_string()];
        let result = filter_instances(&raw, &config);
        assert!(result.is_err());
    }

    #[test]
    fn test_filter_exported_tags() {
        let raw = vec![make_raw_instance(
            "writer",
            "aurora-mysql",
            true,
            "db.r6g.large",
            vec![("Team", "platform"), ("Environment", "production")],
        )];
        let mut config = default_discovery_config();
        config.exported_tags = vec!["Team".to_string(), "Environment".to_string()];
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].exported_tags,
            vec![
                ("Team".to_string(), "platform".to_string()),
                ("Environment".to_string(), "production".to_string()),
            ]
        );
    }

    #[test]
    fn test_filter_exported_tags_missing_tag() {
        let raw = vec![make_raw_instance(
            "writer",
            "aurora-mysql",
            true,
            "db.r6g.large",
            vec![("Team", "platform")],
        )];
        let mut config = default_discovery_config();
        config.exported_tags = vec!["Team".to_string(), "MissingTag".to_string()];
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result[0].exported_tags[0].1, "platform");
        assert_eq!(result[0].exported_tags[1].1, ""); // Missing tag → empty string
    }

    struct MockDiscoverer {
        instances: Vec<RdsInstanceInfo>,
    }

    impl RdsDiscoverer for MockDiscoverer {
        async fn describe_instances(&self) -> Result<Vec<RdsInstanceInfo>, String> {
            Ok(self.instances.clone())
        }
    }

    #[tokio::test]
    async fn test_run_discovery_cycle() {
        let discoverer = MockDiscoverer {
            instances: vec![
                make_raw_instance("writer", "aurora-mysql", true, "db.r6g.large", vec![]),
                make_raw_instance("reader", "aurora-mysql", true, "db.r6g.large", vec![]),
            ],
        };
        let config = default_discovery_config();
        let state = Arc::new(RwLock::new(Vec::new()));

        let result = run_discovery_cycle(&discoverer, &config, &state)
            .await
            .unwrap();
        assert_eq!(result.added, 2);
        assert_eq!(result.removed_instances.len(), 0);
        assert_eq!(state.read().await.len(), 2);
    }

    #[tokio::test]
    async fn test_run_discovery_cycle_detects_removal() {
        let state = Arc::new(RwLock::new(vec![AuroraInstance {
            dbi_resource_id: "db-old".to_string(),
            db_instance_identifier: "old-writer".to_string(),
            engine: "aurora-mysql".to_string(),
            db_cluster_identifier: "cluster".to_string(),
            db_instance_class: "db.r6g.large".to_string(),
            vcpu: 2,
            exported_tags: vec![],
        }]));

        let discoverer = MockDiscoverer {
            instances: vec![make_raw_instance(
                "new-writer",
                "aurora-mysql",
                true,
                "db.r6g.large",
                vec![],
            )],
        };
        let config = default_discovery_config();

        let result = run_discovery_cycle(&discoverer, &config, &state)
            .await
            .unwrap();
        assert_eq!(result.added, 1);
        assert_eq!(result.removed_instances.len(), 1);
        assert_eq!(
            result.removed_instances[0].db_instance_identifier,
            "old-writer"
        );
        assert_eq!(state.read().await.len(), 1);
        assert_eq!(state.read().await[0].db_instance_identifier, "new-writer");
    }

    #[test]
    fn test_filter_include_and_exclude_combined() {
        let raw = vec![
            make_raw_instance("prod-writer", "aurora-mysql", true, "db.r6g.large", vec![]),
            make_raw_instance(
                "prod-test-writer",
                "aurora-mysql",
                true,
                "db.r6g.large",
                vec![],
            ),
            make_raw_instance("dev-writer", "aurora-mysql", true, "db.r6g.large", vec![]),
        ];
        let mut config = default_discovery_config();
        config.include.identifier = vec!["^prod-".to_string()];
        config.exclude.identifier = vec!["-test-".to_string()];
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].db_instance_identifier, "prod-writer");
    }

    #[test]
    fn test_filter_multiple_tags_all_must_match() {
        let raw = vec![
            make_raw_instance(
                "writer",
                "aurora-mysql",
                true,
                "db.r6g.large",
                vec![("Env", "prod"), ("Team", "platform")],
            ),
            make_raw_instance(
                "reader",
                "aurora-mysql",
                true,
                "db.r6g.large",
                vec![("Env", "prod")], // Missing Team tag
            ),
        ];
        let mut config = default_discovery_config();
        config.include.tags = vec![
            crate::config::TagFilter {
                key: "Env".to_string(),
                value: "prod".to_string(),
            },
            crate::config::TagFilter {
                key: "Team".to_string(),
                value: "platform".to_string(),
            },
        ];
        let result = filter_instances(&raw, &config).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].db_instance_identifier, "writer");
    }

    struct FailingDiscoverer;

    impl RdsDiscoverer for FailingDiscoverer {
        async fn describe_instances(&self) -> Result<Vec<RdsInstanceInfo>, String> {
            Err("Connection timeout".to_string())
        }
    }

    #[tokio::test]
    async fn test_run_discovery_cycle_failure_retains_state() {
        let state = Arc::new(RwLock::new(vec![AuroraInstance {
            dbi_resource_id: "db-existing".to_string(),
            db_instance_identifier: "existing-writer".to_string(),
            engine: "aurora-mysql".to_string(),
            db_cluster_identifier: "cluster".to_string(),
            db_instance_class: "db.r6g.large".to_string(),
            vcpu: 2,
            exported_tags: vec![],
        }]));

        let discoverer = FailingDiscoverer;
        let config = default_discovery_config();

        let result = run_discovery_cycle(&discoverer, &config, &state).await;
        assert!(result.is_err());
        // State should remain unchanged
        assert_eq!(state.read().await.len(), 1);
        assert_eq!(
            state.read().await[0].db_instance_identifier,
            "existing-writer"
        );
    }

    #[tokio::test]
    async fn test_run_discovery_cycle_no_change() {
        let state = Arc::new(RwLock::new(vec![AuroraInstance {
            dbi_resource_id: "db-writer".to_string(),
            db_instance_identifier: "writer".to_string(),
            engine: "aurora-mysql".to_string(),
            db_cluster_identifier: "cluster".to_string(),
            db_instance_class: "db.r6g.large".to_string(),
            vcpu: 2,
            exported_tags: vec![],
        }]));

        let discoverer = MockDiscoverer {
            instances: vec![make_raw_instance(
                "writer",
                "aurora-mysql",
                true,
                "db.r6g.large",
                vec![],
            )],
        };
        let config = default_discovery_config();

        let result = run_discovery_cycle(&discoverer, &config, &state)
            .await
            .unwrap();
        assert_eq!(result.added, 0);
        assert_eq!(result.removed_instances.len(), 0);
        assert_eq!(result.total, 1);
    }
}
