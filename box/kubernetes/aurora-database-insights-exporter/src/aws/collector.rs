use std::sync::Arc;

use aws_sdk_pi::Client as PiClient;
use aws_sdk_pi::types::{DimensionGroup, MetricQuery};
use chrono::Utc;
use tokio::sync::RwLock;

use crate::config::CollectionConfig;
use crate::observability::metrics::Metrics;
use crate::types::*;

const SQL_TEXT_MAX_LEN: usize = 200;

/// Trait for PI API calls (enables testing with mocks).
#[allow(async_fn_in_trait)]
pub trait PiCollector: Send + Sync {
    async fn get_resource_metrics_grouped(
        &self,
        resource_id: &str,
        group: &str,
        limit: Option<i32>,
        period: i32,
    ) -> Result<Vec<(String, String, f64)>, String>;

    async fn describe_dimension_keys(
        &self,
        resource_id: &str,
        group: &str,
        limit: i32,
        period: i32,
    ) -> Result<Vec<DimensionKeyResult>, String>;
}

#[derive(Debug, Clone)]
pub struct DimensionKeyResult {
    pub dimensions: Vec<(String, String)>,
    pub value: f64,
}

/// Real AWS PI collector using the SDK.
pub struct AwsPiCollector {
    client: PiClient,
}

impl AwsPiCollector {
    pub fn new(client: PiClient) -> Self {
        Self { client }
    }
}

impl PiCollector for AwsPiCollector {
    async fn get_resource_metrics_grouped(
        &self,
        resource_id: &str,
        group: &str,
        limit: Option<i32>,
        period: i32,
    ) -> Result<Vec<(String, String, f64)>, String> {
        let now = Utc::now();
        let start = now - chrono::Duration::seconds(i64::from(period) * 2);

        let mut dim_group_builder = DimensionGroup::builder().group(group);
        if let Some(l) = limit {
            dim_group_builder = dim_group_builder.limit(l);
        }
        let dim_group = dim_group_builder.build().map_err(|e| e.to_string())?;

        let query = MetricQuery::builder()
            .metric("db.load.avg")
            .group_by(dim_group)
            .build()
            .map_err(|e| e.to_string())?;

        let resp = self
            .client
            .get_resource_metrics()
            .service_type(aws_sdk_pi::types::ServiceType::Rds)
            .identifier(resource_id)
            .metric_queries(query)
            .start_time(aws_sdk_pi::primitives::DateTime::from_secs(
                start.timestamp(),
            ))
            .end_time(aws_sdk_pi::primitives::DateTime::from_secs(now.timestamp()))
            .period_in_seconds(period)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let mut results = Vec::new();
        for metric in resp.metric_list() {
            if let Some(key_map) = metric.key.as_ref()
                && let Some(dimensions) = key_map.dimensions.as_ref() {
                    let dim_key = dimensions.keys().next().cloned().unwrap_or_default();
                    let dim_value = dimensions.values().next().cloned().unwrap_or_default();

                    // Get the latest datapoint value
                    let value = metric
                        .data_points()
                        .last()
                        .map(|dp| dp.value)
                        .unwrap_or(0.0);

                    results.push((dim_key, dim_value, value));
                }
        }

        Ok(results)
    }

    async fn describe_dimension_keys(
        &self,
        resource_id: &str,
        group: &str,
        limit: i32,
        period: i32,
    ) -> Result<Vec<DimensionKeyResult>, String> {
        let now = Utc::now();
        let start = now - chrono::Duration::seconds(i64::from(period) * 2);

        let dim_group = DimensionGroup::builder()
            .group(group)
            .dimensions("db.sql_tokenized.id")
            .dimensions("db.sql_tokenized.statement")
            .limit(limit)
            .build()
            .map_err(|e| e.to_string())?;

        let resp = self
            .client
            .describe_dimension_keys()
            .service_type(aws_sdk_pi::types::ServiceType::Rds)
            .identifier(resource_id)
            .metric("db.load.avg")
            .group_by(dim_group)
            .start_time(aws_sdk_pi::primitives::DateTime::from_secs(
                start.timestamp(),
            ))
            .end_time(aws_sdk_pi::primitives::DateTime::from_secs(now.timestamp()))
            .period_in_seconds(period)
            .max_results(limit)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let mut results = Vec::new();
        for key in resp.keys() {
            if let Some(dims) = key.dimensions.as_ref() {
                let dimensions: Vec<(String, String)> =
                    dims.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
                let value = key.total.unwrap_or(0.0);
                results.push(DimensionKeyResult { dimensions, value });
            }
        }

        Ok(results)
    }
}

/// Collect metrics for a single instance. Returns a MetricSnapshot on success.
pub async fn collect_instance_metrics<P: PiCollector>(
    pi: &P,
    instance: &AuroraInstance,
    region: &str,
    config: &CollectionConfig,
) -> Result<MetricSnapshot, String> {
    let labels = InstanceLabels::from_instance(instance, region);
    let resource_id = &instance.dbi_resource_id;
    let period = config.pi_period_seconds;

    // 1. Wait events (GetResourceMetrics grouped by db.wait_event)
    let wait_event_data = pi
        .get_resource_metrics_grouped(resource_id, "db.wait_event", Some(25), period)
        .await?;

    let mut db_load_cpu = 0.0;
    let mut db_load_total = 0.0;
    let mut wait_events = Vec::new();

    for (wait_event_type, wait_event, value) in &wait_event_data {
        db_load_total += value;
        if wait_event_type.to_uppercase() == "CPU" || wait_event.to_uppercase().contains("CPU") {
            db_load_cpu += value;
        }
        wait_events.push(WaitEventMetric {
            wait_event: wait_event.clone(),
            wait_event_type: wait_event_type.clone(),
            value: *value,
        });
    }

    let db_load_non_cpu = (db_load_total - db_load_cpu).max(0.0);

    // 2. Top SQL (DescribeDimensionKeys grouped by db.sql_tokenized)
    let sql_data = pi
        .describe_dimension_keys(resource_id, "db.sql_tokenized", config.top_sql_limit, period)
        .await?;

    let top_sql: Vec<SqlMetric> = sql_data
        .iter()
        .map(|dk| {
            let sql_id = dk
                .dimensions
                .iter()
                .find(|(k, _)| k.contains("id"))
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            let raw_text = dk
                .dimensions
                .iter()
                .find(|(k, _)| k.contains("statement"))
                .map(|(_, v)| v.clone())
                .unwrap_or_default();

            let (sql_text, sql_text_truncated) = truncate_sql(&raw_text);

            SqlMetric {
                sql_id,
                sql_text,
                sql_text_truncated,
                value: dk.value,
            }
        })
        .collect();

    // 3. Users (GetResourceMetrics grouped by db.user)
    let user_data = pi
        .get_resource_metrics_grouped(resource_id, "db.user", None, period)
        .await?;

    let users: Vec<UserMetric> = user_data
        .iter()
        .map(|(_, user, value)| UserMetric {
            db_user: user.clone(),
            value: *value,
        })
        .collect();

    // 4. Hosts (GetResourceMetrics grouped by db.host)
    let host_data = pi
        .get_resource_metrics_grouped(
            resource_id,
            "db.host",
            Some(config.top_host_limit),
            period,
        )
        .await?;

    let hosts: Vec<HostMetric> = host_data
        .iter()
        .map(|(_, host, value)| HostMetric {
            client_host: host.clone(),
            value: *value,
        })
        .collect();

    Ok(MetricSnapshot {
        labels,
        db_load: db_load_total,
        db_load_cpu,
        db_load_non_cpu,
        vcpu: instance.vcpu,
        wait_events,
        top_sql,
        users,
        hosts,
    })
}

/// Truncate SQL text to max length, returning (text, was_truncated).
pub fn truncate_sql(raw: &str) -> (String, bool) {
    if raw.len() > SQL_TEXT_MAX_LEN {
        let truncated = format!("{}...", &raw[..SQL_TEXT_MAX_LEN]);
        (truncated, true)
    } else {
        (raw.to_string(), false)
    }
}

/// Run one collection cycle for all instances.
pub async fn run_collection_cycle<P: PiCollector>(
    pi: &P,
    instances: &[AuroraInstance],
    region: &str,
    config: &CollectionConfig,
    metrics: &Arc<Metrics>,
    _semaphore: &Arc<tokio::sync::Semaphore>,
) -> (usize, usize) {
    let mut collected = 0;
    let mut failed = 0;

    for instance in instances {
        let labels = InstanceLabels::from_instance(instance, region);
        let mut last_error = None;

        for attempt in 0..config.retry.max_attempts {
            match collect_instance_metrics(pi, instance, region, config).await {
                Ok(snapshot) => {
                    metrics.apply_snapshot(&snapshot);
                    collected += 1;
                    last_error = None;
                    break;
                }
                Err(e) => {
                    last_error = Some(e.clone());
                    if attempt + 1 < config.retry.max_attempts {
                        let delay = config.retry.base_delay_ms * 2u64.pow(attempt);
                        tracing::warn!(
                            instance = %instance.db_instance_identifier,
                            error = %e,
                            retry_attempt = attempt + 1,
                            next_retry_ms = delay,
                            "PI API call failed. Retrying"
                        );
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    }
                }
            }
        }

        if let Some(e) = last_error {
            tracing::warn!(
                instance = %instance.db_instance_identifier,
                error = %e,
                max_attempts = config.retry.max_attempts,
                "Instance collection failed after all retries. Marking up=0"
            );
            metrics.mark_instance_down(&labels);
            failed += 1;
        }
    }

    (collected, failed)
}

/// Run the collection loop as a background task (without leader election).
#[allow(dead_code)]
pub async fn collection_loop<P: PiCollector + 'static>(
    pi: Arc<P>,
    instances_state: Arc<RwLock<Vec<AuroraInstance>>>,
    region: String,
    config: CollectionConfig,
    metrics: Arc<Metrics>,
    ready_flag: Arc<RwLock<bool>>,
) {
    let semaphore = Arc::new(tokio::sync::Semaphore::new(
        config.max_concurrent_api_calls,
    ));
    let mut interval =
        tokio::time::interval(std::time::Duration::from_secs(config.interval_seconds));
    let mut cycle: u64 = 0;

    loop {
        interval.tick().await;
        cycle += 1;

        let instances = instances_state.read().await.clone();
        if instances.is_empty() {
            tracing::debug!(cycle, "No instances discovered. Skipping collection");
            continue;
        }

        tracing::info!(cycle, instances = instances.len(), "Collection cycle started");
        let start = std::time::Instant::now();

        let (collected, failed) =
            run_collection_cycle(&*pi, &instances, &region, &config, &metrics, &semaphore).await;

        let duration = start.elapsed();
        metrics
            .scrape_duration_seconds
            .set(duration.as_secs_f64());

        tracing::info!(
            cycle,
            instances_collected = collected,
            instances_failed = failed,
            total_duration_ms = duration.as_millis() as u64,
            "Collection cycle completed"
        );

        // Enable readiness after first successful collection
        let mut ready = ready_flag.write().await;
        if !*ready && collected > 0 {
            *ready = true;
            tracing::info!("Readiness probe enabled after first successful collection");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_sql_short() {
        let (text, truncated) = truncate_sql("SELECT 1");
        assert_eq!(text, "SELECT 1");
        assert!(!truncated);
    }

    #[test]
    fn test_truncate_sql_exact_limit() {
        let input = "x".repeat(SQL_TEXT_MAX_LEN);
        let (text, truncated) = truncate_sql(&input);
        assert_eq!(text, input);
        assert!(!truncated);
    }

    #[test]
    fn test_truncate_sql_over_limit() {
        let input = "x".repeat(SQL_TEXT_MAX_LEN + 50);
        let (text, truncated) = truncate_sql(&input);
        assert_eq!(text.len(), SQL_TEXT_MAX_LEN + 3); // +3 for "..."
        assert!(text.ends_with("..."));
        assert!(truncated);
    }

    struct MockPiCollector {
        wait_events: Vec<(String, String, f64)>,
        sql_keys: Vec<DimensionKeyResult>,
        users: Vec<(String, String, f64)>,
        hosts: Vec<(String, String, f64)>,
    }

    impl MockPiCollector {
        fn new() -> Self {
            Self {
                wait_events: vec![
                    ("CPU".to_string(), "cpu".to_string(), 1.5),
                    ("IO".to_string(), "io/table/sql/handler".to_string(), 0.8),
                ],
                sql_keys: vec![DimensionKeyResult {
                    dimensions: vec![
                        ("db.sql_tokenized.id".to_string(), "SQL_ABC".to_string()),
                        (
                            "db.sql_tokenized.statement".to_string(),
                            "SELECT * FROM orders WHERE id = ?".to_string(),
                        ),
                    ],
                    value: 1.2,
                }],
                users: vec![("db.user".to_string(), "app_user".to_string(), 2.0)],
                hosts: vec![("db.host".to_string(), "10.0.1.100".to_string(), 1.5)],
            }
        }
    }

    impl PiCollector for MockPiCollector {
        async fn get_resource_metrics_grouped(
            &self,
            _resource_id: &str,
            group: &str,
            _limit: Option<i32>,
            _period: i32,
        ) -> Result<Vec<(String, String, f64)>, String> {
            match group {
                "db.wait_event" => Ok(self.wait_events.clone()),
                "db.user" => Ok(self.users.clone()),
                "db.host" => Ok(self.hosts.clone()),
                _ => Ok(vec![]),
            }
        }

        async fn describe_dimension_keys(
            &self,
            _resource_id: &str,
            _group: &str,
            _limit: i32,
            _period: i32,
        ) -> Result<Vec<DimensionKeyResult>, String> {
            Ok(self.sql_keys.clone())
        }
    }

    fn test_instance() -> AuroraInstance {
        AuroraInstance {
            dbi_resource_id: "db-TEST".to_string(),
            db_instance_identifier: "test-writer".to_string(),
            engine: "aurora-mysql".to_string(),
            db_cluster_identifier: "test-cluster".to_string(),
            db_instance_class: "db.r6g.large".to_string(),
            vcpu: 2,
            exported_tags: vec![],
        }
    }

    #[tokio::test]
    async fn test_collect_instance_metrics() {
        let pi = MockPiCollector::new();
        let instance = test_instance();
        let config = CollectionConfig::default();

        let snapshot = collect_instance_metrics(&pi, &instance, "ap-northeast-2", &config)
            .await
            .unwrap();

        assert_eq!(snapshot.db_load, 2.3); // 1.5 + 0.8
        assert_eq!(snapshot.db_load_cpu, 1.5);
        assert!((snapshot.db_load_non_cpu - 0.8).abs() < 0.001);
        assert_eq!(snapshot.vcpu, 2);
        assert_eq!(snapshot.wait_events.len(), 2);
        assert_eq!(snapshot.top_sql.len(), 1);
        assert_eq!(snapshot.top_sql[0].sql_id, "SQL_ABC");
        assert!(!snapshot.top_sql[0].sql_text_truncated);
        assert_eq!(snapshot.users.len(), 1);
        assert_eq!(snapshot.hosts.len(), 1);
        assert_eq!(snapshot.labels.instance, "test-writer");
    }

    #[tokio::test]
    async fn test_collect_instance_cpu_non_cpu_split() {
        let mut pi = MockPiCollector::new();
        pi.wait_events = vec![
            ("CPU".to_string(), "cpu".to_string(), 3.0),
            ("IO".to_string(), "io/read".to_string(), 1.0),
            ("Lock".to_string(), "lock/row".to_string(), 0.5),
        ];
        let instance = test_instance();
        let config = CollectionConfig::default();

        let snapshot = collect_instance_metrics(&pi, &instance, "us-east-1", &config)
            .await
            .unwrap();

        assert_eq!(snapshot.db_load, 4.5);
        assert_eq!(snapshot.db_load_cpu, 3.0);
        assert!((snapshot.db_load_non_cpu - 1.5).abs() < 0.001);
    }

    #[tokio::test]
    async fn test_run_collection_cycle_success() {
        let pi = MockPiCollector::new();
        let instances = vec![test_instance()];
        let config = CollectionConfig::default();
        let metrics = Arc::new(Metrics::new(&[]));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(5));

        let (collected, failed) = run_collection_cycle(
            &pi,
            &instances,
            "ap-northeast-2",
            &config,
            &metrics,
            &semaphore,
        )
        .await;

        assert_eq!(collected, 1);
        assert_eq!(failed, 0);

        // Verify metrics were applied
        let output = metrics.encode();
        assert!(output.contains("aurora_dbinsights_db_load{"));
        assert!(output.contains("test-writer"));
    }

    struct FailingPiCollector;

    impl PiCollector for FailingPiCollector {
        async fn get_resource_metrics_grouped(
            &self,
            _resource_id: &str,
            _group: &str,
            _limit: Option<i32>,
            _period: i32,
        ) -> Result<Vec<(String, String, f64)>, String> {
            Err("ThrottlingException: Rate exceeded".to_string())
        }

        async fn describe_dimension_keys(
            &self,
            _resource_id: &str,
            _group: &str,
            _limit: i32,
            _period: i32,
        ) -> Result<Vec<DimensionKeyResult>, String> {
            Err("ThrottlingException".to_string())
        }
    }

    #[tokio::test]
    async fn test_run_collection_cycle_failure() {
        let pi = FailingPiCollector;
        let instances = vec![test_instance()];
        let mut config = CollectionConfig::default();
        config.retry.max_attempts = 1; // Fast failure
        config.retry.base_delay_ms = 1;
        let metrics = Arc::new(Metrics::new(&[]));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(5));

        let (collected, failed) = run_collection_cycle(
            &pi,
            &instances,
            "ap-northeast-2",
            &config,
            &metrics,
            &semaphore,
        )
        .await;

        assert_eq!(collected, 0);
        assert_eq!(failed, 1);

        // up should be 0
        let labels = InstanceLabels::from_instance(&instances[0], "ap-northeast-2");
        let up_val = metrics.up.with_label_values(&labels.as_vec()).get();
        assert_eq!(up_val, 0.0);
    }

    #[test]
    fn test_sql_text_truncation_in_snapshot() {
        let long_sql = "x".repeat(300);
        let (text, truncated) = truncate_sql(&long_sql);
        assert!(truncated);
        assert!(text.len() <= SQL_TEXT_MAX_LEN + 3);
    }

    #[tokio::test]
    async fn test_run_collection_cycle_empty_instances() {
        let pi = MockPiCollector::new();
        let instances: Vec<AuroraInstance> = vec![];
        let config = CollectionConfig::default();
        let metrics = Arc::new(Metrics::new(&[]));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(5));

        let (collected, failed) = run_collection_cycle(
            &pi,
            &instances,
            "ap-northeast-2",
            &config,
            &metrics,
            &semaphore,
        )
        .await;

        assert_eq!(collected, 0);
        assert_eq!(failed, 0);
    }

    #[tokio::test]
    async fn test_run_collection_cycle_multiple_instances() {
        let pi = MockPiCollector::new();
        let instances = vec![
            test_instance(),
            AuroraInstance {
                dbi_resource_id: "db-TEST2".to_string(),
                db_instance_identifier: "test-reader".to_string(),
                engine: "aurora-mysql".to_string(),
                db_cluster_identifier: "test-cluster".to_string(),
                db_instance_class: "db.r6g.xlarge".to_string(),
                vcpu: 4,
                exported_tags: vec![],
            },
        ];
        let config = CollectionConfig::default();
        let metrics = Arc::new(Metrics::new(&[]));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(5));

        let (collected, failed) = run_collection_cycle(
            &pi,
            &instances,
            "ap-northeast-2",
            &config,
            &metrics,
            &semaphore,
        )
        .await;

        assert_eq!(collected, 2);
        assert_eq!(failed, 0);

        let output = metrics.encode();
        assert!(output.contains("test-writer"));
        assert!(output.contains("test-reader"));
    }

    #[tokio::test]
    async fn test_run_collection_cycle_retry_then_fail() {
        let pi = FailingPiCollector;
        let instances = vec![test_instance()];
        let mut config = CollectionConfig::default();
        config.retry.max_attempts = 2;
        config.retry.base_delay_ms = 1;
        let metrics = Arc::new(Metrics::new(&[]));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(5));

        let (collected, failed) = run_collection_cycle(
            &pi,
            &instances,
            "us-east-1",
            &config,
            &metrics,
            &semaphore,
        )
        .await;

        assert_eq!(collected, 0);
        assert_eq!(failed, 1);

        // Error counter should be 1
        let err = metrics
            .collection_errors_total
            .with_label_values(&["test-writer"])
            .get();
        assert_eq!(err, 1.0);
    }

    #[tokio::test]
    async fn test_collect_instance_with_empty_wait_events() {
        let mut pi = MockPiCollector::new();
        pi.wait_events = vec![];
        let instance = test_instance();
        let config = CollectionConfig::default();

        let snapshot = collect_instance_metrics(&pi, &instance, "us-east-1", &config)
            .await
            .unwrap();

        assert_eq!(snapshot.db_load, 0.0);
        assert_eq!(snapshot.db_load_cpu, 0.0);
        assert_eq!(snapshot.db_load_non_cpu, 0.0);
        assert!(snapshot.wait_events.is_empty());
    }

    #[tokio::test]
    async fn test_collect_instance_with_long_sql() {
        let long_sql = "x".repeat(300);
        let mut pi = MockPiCollector::new();
        pi.sql_keys = vec![DimensionKeyResult {
            dimensions: vec![
                ("db.sql_tokenized.id".to_string(), "LONG1".to_string()),
                (
                    "db.sql_tokenized.statement".to_string(),
                    long_sql,
                ),
            ],
            value: 5.0,
        }];
        let instance = test_instance();
        let config = CollectionConfig::default();

        let snapshot = collect_instance_metrics(&pi, &instance, "us-east-1", &config)
            .await
            .unwrap();

        assert_eq!(snapshot.top_sql.len(), 1);
        assert!(snapshot.top_sql[0].sql_text_truncated);
        assert!(snapshot.top_sql[0].sql_text.ends_with("..."));
        assert_eq!(snapshot.top_sql[0].sql_id, "LONG1");
    }
}
