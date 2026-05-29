//! Snowflake collector: runs all ACCOUNT_USAGE queries and updates Prometheus metrics.

use std::sync::Arc;

use async_trait::async_trait;
use serde_json::Value;

use crate::error::Result;
use crate::observability::metrics::Metrics;
use crate::snowflake::client::{Rows, SnowflakeClient, as_f64, as_str};
use crate::snowflake::queries;

/// Query executor abstraction so the collector can be unit-tested against
/// an in-memory mock without reaching Snowflake.
#[async_trait]
pub trait QueryExecutor: Send + Sync {
    async fn query(&self, sql: &str, query_timeout_seconds: u64) -> Result<Rows>;
}

#[async_trait]
impl QueryExecutor for SnowflakeClient {
    async fn query(&self, sql: &str, query_timeout_seconds: u64) -> Result<Rows> {
        SnowflakeClient::query(self, sql, query_timeout_seconds).await
    }
}

pub struct Collector {
    client: Arc<dyn QueryExecutor>,
    query_timeout: u64,
    exclude_deleted: bool,
    enable_serverless_detail: bool,
}

impl Collector {
    pub fn new(
        client: Arc<dyn QueryExecutor>,
        query_timeout: u64,
        exclude_deleted: bool,
        enable_serverless_detail: bool,
    ) -> Self {
        Self {
            client,
            query_timeout,
            exclude_deleted,
            enable_serverless_detail,
        }
    }

    /// Run every collector once. Returns `true` if all sub-collections
    /// succeeded (equivalent to `snowflake_up=1`).
    pub async fn run(&self, metrics: &Metrics) -> bool {
        metrics.reset_dynamic_labels();

        let core = tokio::join!(
            self.collect_storage(metrics),
            self.collect_database_storage(metrics),
            self.collect_credits(metrics),
            self.collect_warehouse_credits(metrics),
            self.collect_logins(metrics),
            self.collect_warehouse_load(metrics),
            self.collect_auto_clustering(metrics),
            self.collect_table_storage(metrics),
            self.collect_deleted_tables(metrics),
            self.collect_replication(metrics),
            self.collect_query_stats(metrics),
        );

        let mut outcomes: Vec<(&'static str, Result<()>)> = vec![
            ("storage", core.0),
            ("database_storage", core.1),
            ("credits", core.2),
            ("warehouse_credits", core.3),
            ("logins", core.4),
            ("warehouse_load", core.5),
            ("auto_clustering", core.6),
            ("table_storage", core.7),
            ("deleted_tables", core.8),
            ("replication", core.9),
            ("query_stats", core.10),
        ];

        if self.enable_serverless_detail {
            let sl = tokio::join!(
                self.collect_pipe_usage(metrics),
                self.collect_serverless_task(metrics),
                self.collect_mv_refresh(metrics),
            );
            outcomes.push(("pipe_usage", sl.0));
            outcomes.push(("serverless_task", sl.1));
            outcomes.push(("mv_refresh", sl.2));
        }

        let mut ok = true;
        for (name, result) in outcomes {
            if let Err(e) = result {
                tracing::warn!(collector = name, error = %e, "sub-collection failed");
                ok = false;
            }
        }
        ok
    }

    async fn collect_storage(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::STORAGE, self.query_timeout)
            .await?;
        if let Some(row) = rows.into_iter().next() {
            if let Some(v) = row.first().and_then(as_f64) {
                m.storage_bytes.set(v);
            }
            if let Some(v) = row.get(1).and_then(as_f64) {
                m.stage_bytes.set(v);
            }
            if let Some(v) = row.get(2).and_then(as_f64) {
                m.failsafe_bytes.set(v);
            }
        }
        Ok(())
    }

    async fn collect_database_storage(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::DATABASE_STORAGE, self.query_timeout)
            .await?;
        for row in rows {
            let name = as_str(row.first().unwrap_or(&Value::Null));
            let id = as_str(row.get(1).unwrap_or(&Value::Null));
            if let Some(v) = row.get(2).and_then(as_f64) {
                m.database_bytes.with_label_values(&[&name, &id]).set(v);
            }
            if let Some(v) = row.get(3).and_then(as_f64) {
                m.database_failsafe_bytes
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
        }
        Ok(())
    }

    async fn collect_credits(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::CREDIT, self.query_timeout)
            .await?;
        for row in rows {
            let service_type = as_str(row.first().unwrap_or(&Value::Null));
            let service = as_str(row.get(1).unwrap_or(&Value::Null));
            if let Some(v) = row.get(2).and_then(as_f64) {
                m.used_compute_credits
                    .with_label_values(&[&service_type, &service])
                    .set(v);
            }
            if let Some(v) = row.get(3).and_then(as_f64) {
                m.used_cloud_services_credits
                    .with_label_values(&[&service_type, &service])
                    .set(v);
            }
        }
        Ok(())
    }

    async fn collect_warehouse_credits(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::WAREHOUSE_CREDIT, self.query_timeout)
            .await?;
        for row in rows {
            let name = as_str(row.first().unwrap_or(&Value::Null));
            let id = as_str(row.get(1).unwrap_or(&Value::Null));
            if let Some(v) = row.get(2).and_then(as_f64) {
                m.warehouse_used_compute_credits
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
            if let Some(v) = row.get(3).and_then(as_f64) {
                m.warehouse_used_cloud_service_credits
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
        }
        Ok(())
    }

    async fn collect_logins(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::LOGIN, self.query_timeout)
            .await?;
        for row in rows {
            let client_type = as_str(row.first().unwrap_or(&Value::Null));
            let client_version = as_str(row.get(1).unwrap_or(&Value::Null));
            let failures = row.get(2).and_then(as_f64);
            let successes = row.get(3).and_then(as_f64);
            let total = row.get(4).and_then(as_f64);

            if let Some(t) = total {
                m.login_rate
                    .with_label_values(&[&client_type, &client_version])
                    .set(t / 24.0);
            }
            if let Some(f) = failures {
                m.failed_login_rate
                    .with_label_values(&[&client_type, &client_version])
                    .set(f / 24.0);
            }
            if let Some(s) = successes {
                m.successful_login_rate
                    .with_label_values(&[&client_type, &client_version])
                    .set(s / 24.0);
            }
        }
        Ok(())
    }

    async fn collect_warehouse_load(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::WAREHOUSE_LOAD, self.query_timeout)
            .await?;
        for row in rows {
            let name = as_str(row.first().unwrap_or(&Value::Null));
            let id = as_str(row.get(1).unwrap_or(&Value::Null));
            if let Some(v) = row.get(2).and_then(as_f64) {
                m.warehouse_executed_queries
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
            if let Some(v) = row.get(3).and_then(as_f64) {
                m.warehouse_overloaded_queue_size
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
            if let Some(v) = row.get(4).and_then(as_f64) {
                m.warehouse_provisioning_queue_size
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
            if let Some(v) = row.get(5).and_then(as_f64) {
                m.warehouse_blocked_queries
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
        }
        Ok(())
    }

    async fn collect_auto_clustering(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::AUTO_CLUSTERING, self.query_timeout)
            .await?;
        for row in rows {
            let table = as_str(row.first().unwrap_or(&Value::Null));
            let table_id = as_str(row.get(1).unwrap_or(&Value::Null));
            let schema = as_str(row.get(2).unwrap_or(&Value::Null));
            let schema_id = as_str(row.get(3).unwrap_or(&Value::Null));
            let db = as_str(row.get(4).unwrap_or(&Value::Null));
            let db_id = as_str(row.get(5).unwrap_or(&Value::Null));
            let labels = [
                table.as_str(),
                table_id.as_str(),
                schema.as_str(),
                schema_id.as_str(),
                db.as_str(),
                db_id.as_str(),
            ];
            if let Some(v) = row.get(6).and_then(as_f64) {
                m.auto_clustering_credits.with_label_values(&labels).set(v);
            }
            if let Some(v) = row.get(7).and_then(as_f64) {
                m.auto_clustering_bytes.with_label_values(&labels).set(v);
            }
            if let Some(v) = row.get(8).and_then(as_f64) {
                m.auto_clustering_rows.with_label_values(&labels).set(v);
            }
        }
        Ok(())
    }

    async fn collect_table_storage(&self, m: &Metrics) -> Result<()> {
        let sql = if self.exclude_deleted {
            queries::TABLE_STORAGE_EXCLUDE_DELETED
        } else {
            queries::TABLE_STORAGE
        };
        let rows = self.client.query(sql, self.query_timeout).await?;
        for row in rows {
            let table = as_str(row.first().unwrap_or(&Value::Null));
            let table_id = as_str(row.get(1).unwrap_or(&Value::Null));
            let schema = as_str(row.get(2).unwrap_or(&Value::Null));
            let schema_id = as_str(row.get(3).unwrap_or(&Value::Null));
            let db = as_str(row.get(4).unwrap_or(&Value::Null));
            let db_id = as_str(row.get(5).unwrap_or(&Value::Null));
            let labels = [
                table.as_str(),
                table_id.as_str(),
                schema.as_str(),
                schema_id.as_str(),
                db.as_str(),
                db_id.as_str(),
            ];
            if let Some(v) = row.get(6).and_then(as_f64) {
                m.table_active_bytes.with_label_values(&labels).set(v);
            }
            if let Some(v) = row.get(7).and_then(as_f64) {
                m.table_time_travel_bytes.with_label_values(&labels).set(v);
            }
            if let Some(v) = row.get(8).and_then(as_f64) {
                m.table_failsafe_bytes.with_label_values(&labels).set(v);
            }
            if let Some(v) = row.get(9).and_then(as_f64) {
                m.table_clone_bytes.with_label_values(&labels).set(v);
            }
        }
        Ok(())
    }

    async fn collect_deleted_tables(&self, m: &Metrics) -> Result<()> {
        if self.exclude_deleted {
            return Ok(());
        }
        let rows = self
            .client
            .query(queries::DELETED_TABLES, self.query_timeout)
            .await?;
        if let Some(row) = rows.into_iter().next()
            && let Some(v) = row.first().and_then(as_f64)
        {
            m.table_deleted_tables.set(v);
        }
        Ok(())
    }

    async fn collect_replication(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::REPLICATION, self.query_timeout)
            .await?;
        for row in rows {
            let db = as_str(row.first().unwrap_or(&Value::Null));
            let db_id = as_str(row.get(1).unwrap_or(&Value::Null));
            if let Some(v) = row.get(2).and_then(as_f64) {
                m.db_replication_used_credits
                    .with_label_values(&[&db, &db_id])
                    .set(v);
            }
            if let Some(v) = row.get(3).and_then(as_f64) {
                m.db_replication_transferred_bytes
                    .with_label_values(&[&db, &db_id])
                    .set(v);
            }
        }
        Ok(())
    }

    async fn collect_query_stats(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::QUERY_STATS, self.query_timeout)
            .await?;
        for row in rows {
            let name = as_str(row.first().unwrap_or(&Value::Null));
            let id = as_str(row.get(1).unwrap_or(&Value::Null));
            if let Some(v) = row.get(2).and_then(as_f64) {
                m.warehouse_successful_queries
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
            if let Some(v) = row.get(3).and_then(as_f64) {
                m.warehouse_failed_queries
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
            // Snowflake returns elapsed/queued in milliseconds; convert to seconds.
            if let Some(v) = row.get(4).and_then(as_f64) {
                m.warehouse_query_avg_elapsed_seconds
                    .with_label_values(&[&name, &id])
                    .set(v / 1000.0);
            }
            if let Some(v) = row.get(5).and_then(as_f64) {
                m.warehouse_query_avg_queued_seconds
                    .with_label_values(&[&name, &id])
                    .set(v / 1000.0);
            }
            if let Some(v) = row.get(6).and_then(as_f64) {
                m.warehouse_query_avg_bytes_scanned
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
            if let Some(v) = row.get(7).and_then(as_f64) {
                m.warehouse_query_avg_cloud_services_credits
                    .with_label_values(&[&name, &id])
                    .set(v);
            }
        }
        Ok(())
    }

    async fn collect_pipe_usage(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::PIPE_USAGE, self.query_timeout)
            .await?;
        for row in rows {
            let pipe = as_str(row.first().unwrap_or(&Value::Null));
            if let Some(v) = row.get(1).and_then(as_f64) {
                m.pipe_credits_used.with_label_values(&[&pipe]).set(v);
            }
            if let Some(v) = row.get(2).and_then(as_f64) {
                m.pipe_bytes_inserted.with_label_values(&[&pipe]).set(v);
            }
            if let Some(v) = row.get(3).and_then(as_f64) {
                m.pipe_files_inserted.with_label_values(&[&pipe]).set(v);
            }
        }
        Ok(())
    }

    async fn collect_serverless_task(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::SERVERLESS_TASK, self.query_timeout)
            .await?;
        for row in rows {
            let task = as_str(row.first().unwrap_or(&Value::Null));
            let db = as_str(row.get(1).unwrap_or(&Value::Null));
            let schema = as_str(row.get(2).unwrap_or(&Value::Null));
            if let Some(v) = row.get(3).and_then(as_f64) {
                m.serverless_task_credits_used
                    .with_label_values(&[&task, &db, &schema])
                    .set(v);
            }
        }
        Ok(())
    }

    async fn collect_mv_refresh(&self, m: &Metrics) -> Result<()> {
        let rows = self
            .client
            .query(queries::MV_REFRESH, self.query_timeout)
            .await?;
        for row in rows {
            let db = as_str(row.first().unwrap_or(&Value::Null));
            let schema = as_str(row.get(1).unwrap_or(&Value::Null));
            let table = as_str(row.get(2).unwrap_or(&Value::Null));
            if let Some(v) = row.get(3).and_then(as_f64) {
                m.materialized_view_refresh_credits_used
                    .with_label_values(&[&db, &schema, &table])
                    .set(v);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::collections::HashMap;
    use std::sync::Mutex;

    use crate::error::Error;
    use crate::observability::metrics::Metrics;

    /// In-memory mock that returns preconfigured rows per SQL string.
    /// Any query not preconfigured returns an empty result set (no error).
    #[derive(Default)]
    struct MockExecutor {
        rows_by_sql: HashMap<&'static str, Rows>,
        fail_queries: Mutex<Vec<&'static str>>,
        calls: Mutex<Vec<String>>,
    }

    impl MockExecutor {
        fn new() -> Self {
            Self::default()
        }

        fn with_rows(mut self, sql: &'static str, rows: Rows) -> Self {
            self.rows_by_sql.insert(sql, rows);
            self
        }

        fn fail(self, sql: &'static str) -> Self {
            self.fail_queries.lock().unwrap().push(sql);
            self
        }
    }

    #[async_trait]
    impl QueryExecutor for MockExecutor {
        async fn query(&self, sql: &str, _timeout: u64) -> Result<Rows> {
            self.calls.lock().unwrap().push(sql.to_string());
            if self
                .fail_queries
                .lock()
                .unwrap()
                .iter()
                .any(|q| sql.starts_with(q))
            {
                return Err(Error::Query {
                    query: sql.chars().take(40).collect(),
                    message: "mock failure".to_string(),
                });
            }
            Ok(self
                .rows_by_sql
                .iter()
                .find(|(k, _)| sql.starts_with(*k))
                .map(|(_, v)| v.clone())
                .unwrap_or_default())
        }
    }

    fn s(s: &str) -> Value {
        Value::String(s.to_string())
    }

    fn make_rows(rows: &[&[&str]]) -> Rows {
        rows.iter()
            .map(|r| r.iter().map(|c| s(c)).collect())
            .collect()
    }

    fn mock_all_tables() -> MockExecutor {
        MockExecutor::new()
            .with_rows(
                "SELECT STORAGE_BYTES",
                make_rows(&[&["100", "200", "300"]]),
            )
            .with_rows(
                "SELECT DATABASE_NAME, DATABASE_ID, AVERAGE_DATABASE_BYTES",
                make_rows(&[&["PROD", "db-1", "1024", "128"]]),
            )
            .with_rows(
                "SELECT SERVICE_TYPE, NAME, avg(CREDITS_USED_COMPUTE)",
                make_rows(&[&["WAREHOUSE_METERING", "METRICS_WH", "1.5", "0.2"]]),
            )
            .with_rows(
                "SELECT WAREHOUSE_NAME, WAREHOUSE_ID, avg(CREDITS_USED_COMPUTE)",
                make_rows(&[&["METRICS_WH", "wh-1", "1.5", "0.2"]]),
            )
            .with_rows(
                "SELECT REPORTED_CLIENT_TYPE",
                make_rows(&[&["SNOWFLAKE_DRIVER", "2.7.0", "24", "240", "264"]]),
            )
            .with_rows(
                "SELECT WAREHOUSE_NAME, WAREHOUSE_ID, avg(AVG_RUNNING)",
                make_rows(&[&["METRICS_WH", "wh-1", "3.0", "0.5", "0.1", "0.0"]]),
            )
            .with_rows(
                "SELECT TABLE_NAME, TABLE_ID, SCHEMA_NAME, SCHEMA_ID, DATABASE_NAME, DATABASE_ID, \
    sum(CREDITS_USED)",
                make_rows(&[&[
                    "T1", "t-1", "PUBLIC", "s-1", "PROD", "db-1", "0.5", "1024", "256",
                ]]),
            )
            .with_rows(
                "SELECT TABLE_NAME, ID, TABLE_SCHEMA, TABLE_SCHEMA_ID, TABLE_CATALOG, TABLE_CATALOG_ID, \
    sum(ACTIVE_BYTES), sum(TIME_TRAVEL_BYTES), sum(FAILSAFE_BYTES), sum(RETAINED_FOR_CLONE_BYTES) \
    FROM ACCOUNT_USAGE.TABLE_STORAGE_METRICS \
    WHERE TABLE_ENTERED_FAILSAFE",
                make_rows(&[&[
                    "T1", "id-1", "PUBLIC", "s-1", "PROD", "db-1", "1024", "512", "256", "128",
                ]]),
            )
            .with_rows(
                "SELECT COUNT(DISTINCT TABLE_NAME",
                make_rows(&[&["42"]]),
            )
            .with_rows(
                "SELECT DATABASE_NAME, DATABASE_ID, sum(CREDITS_USED)",
                make_rows(&[&["PROD", "db-1", "1.2", "2048"]]),
            )
            .with_rows(
                "SELECT WAREHOUSE_NAME, WAREHOUSE_ID, \
    sum(iff(EXECUTION_STATUS",
                make_rows(&[&[
                    "METRICS_WH", "wh-1", "1200", "7", "850.5", "12.3", "10485760", "0.00042",
                ]]),
            )
            .with_rows(
                "SELECT PIPE_NAME",
                make_rows(&[&["DB.SCHEMA.INGEST_PIPE", "0.12", "1048576", "42"]]),
            )
            .with_rows(
                "SELECT TASK_NAME, DATABASE_NAME, SCHEMA_NAME",
                make_rows(&[&["DAILY_ROLLUP", "PROD", "PUBLIC", "0.08"]]),
            )
            .with_rows(
                "SELECT DATABASE_NAME, SCHEMA_NAME, TABLE_NAME, \
    sum(CREDITS_USED) \
    FROM ACCOUNT_USAGE.MATERIALIZED_VIEW_REFRESH_HISTORY",
                make_rows(&[&["PROD", "ANALYTICS", "DAILY_AGG", "0.25"]]),
            )
    }

    #[tokio::test]
    async fn test_run_populates_all_metrics_and_returns_ok() {
        let metrics = Metrics::new().unwrap();
        let client: Arc<dyn QueryExecutor> = Arc::new(mock_all_tables());
        // enable_serverless_detail = true to exercise the optional collectors too
        let collector = Collector::new(client, 60, false, true);

        let ok = collector.run(&metrics).await;
        assert!(ok, "run should succeed when all mocks return rows");

        let out = metrics.encode();
        assert!(out.contains("snowflake_storage_bytes 100"));
        assert!(out.contains("snowflake_stage_bytes 200"));
        assert!(out.contains("snowflake_failsafe_bytes 300"));
        assert!(out.contains("snowflake_database_bytes"));
        assert!(out.contains("snowflake_used_compute_credits"));
        assert!(out.contains("snowflake_warehouse_used_compute_credits"));
        assert!(out.contains("snowflake_login_rate"));
        assert!(out.contains("snowflake_successful_login_rate"));
        assert!(out.contains("snowflake_failed_login_rate"));
        assert!(out.contains("snowflake_warehouse_executed_queries"));
        assert!(out.contains("snowflake_warehouse_overloaded_queue_size"));
        assert!(out.contains("snowflake_warehouse_provisioning_queue_size"));
        assert!(out.contains("snowflake_warehouse_blocked_queries"));
        assert!(out.contains("snowflake_auto_clustering_credits"));
        assert!(out.contains("snowflake_auto_clustering_bytes"));
        assert!(out.contains("snowflake_auto_clustering_rows"));
        assert!(out.contains("snowflake_table_active_bytes"));
        assert!(out.contains("snowflake_table_time_travel_bytes"));
        assert!(out.contains("snowflake_table_failsafe_bytes"));
        assert!(out.contains("snowflake_table_clone_bytes"));
        assert!(out.contains("snowflake_table_deleted_tables 42"));
        assert!(out.contains("snowflake_db_replication_used_credits"));
        assert!(out.contains("snowflake_db_replication_transferred_bytes"));

        // Query aggregates (always on)
        assert!(out.contains("snowflake_warehouse_successful_queries"));
        assert!(out.contains("snowflake_warehouse_failed_queries"));
        assert!(out.contains("snowflake_warehouse_query_avg_elapsed_seconds"));
        assert!(out.contains("snowflake_warehouse_query_avg_queued_seconds"));
        assert!(out.contains("snowflake_warehouse_query_avg_bytes_scanned"));
        assert!(out.contains("snowflake_warehouse_query_avg_cloud_services_credits"));

        // Serverless detail (enabled in this test)
        assert!(out.contains("snowflake_pipe_credits_used"));
        assert!(out.contains("snowflake_pipe_bytes_inserted"));
        assert!(out.contains("snowflake_pipe_files_inserted"));
        assert!(out.contains("snowflake_serverless_task_credits_used"));
        assert!(out.contains("snowflake_materialized_view_refresh_credits_used"));
    }

    #[tokio::test]
    async fn test_query_stats_converts_ms_to_seconds() {
        let metrics = Metrics::new().unwrap();
        let mock = MockExecutor::new().with_rows(
            "SELECT WAREHOUSE_NAME, WAREHOUSE_ID, \
    sum(iff(EXECUTION_STATUS",
            // avg_elapsed_ms = 2500, avg_queued_ms = 750
            make_rows(&[&["WH", "id-1", "100", "3", "2500", "750", "1000000", "0.001"]]),
        );
        let collector = Collector::new(Arc::new(mock), 60, false, false);
        let _ = collector.collect_query_stats(&metrics).await;

        assert_eq!(
            metrics
                .warehouse_query_avg_elapsed_seconds
                .with_label_values(&["WH", "id-1"])
                .get(),
            2.5
        );
        assert_eq!(
            metrics
                .warehouse_query_avg_queued_seconds
                .with_label_values(&["WH", "id-1"])
                .get(),
            0.75
        );
        assert_eq!(
            metrics
                .warehouse_successful_queries
                .with_label_values(&["WH", "id-1"])
                .get(),
            100.0
        );
        assert_eq!(
            metrics
                .warehouse_failed_queries
                .with_label_values(&["WH", "id-1"])
                .get(),
            3.0
        );
    }

    #[tokio::test]
    async fn test_serverless_detail_off_skips_queries() {
        let metrics = Metrics::new().unwrap();
        // Mock returns rows for pipe/task/mv, but collector should NOT call them
        // when enable_serverless_detail=false.
        let mock = MockExecutor::new()
            .with_rows("SELECT PIPE_NAME", make_rows(&[&["PIPE", "9.9", "1", "1"]]));
        let mock_arc = Arc::new(mock);
        let collector = Collector::new(mock_arc.clone(), 60, false, false);

        let _ = collector.run(&metrics).await;

        let calls = mock_arc.calls.lock().unwrap();
        assert!(
            !calls.iter().any(|q| q.starts_with("SELECT PIPE_NAME")),
            "pipe query must not run when enable_serverless_detail=false"
        );
        assert!(
            !calls.iter().any(|q| q.starts_with("SELECT TASK_NAME")),
            "serverless task query must not run when disabled"
        );
    }

    #[tokio::test]
    async fn test_run_returns_false_on_sub_collection_failure() {
        let metrics = Metrics::new().unwrap();
        let client: Arc<dyn QueryExecutor> = Arc::new(
            MockExecutor::new()
                .fail("SELECT STORAGE_BYTES")
                .with_rows("SELECT DATABASE_NAME", make_rows(&[&["P", "d", "1", "2"]])),
        );
        let collector = Collector::new(client, 60, false, false);
        let ok = collector.run(&metrics).await;
        assert!(!ok, "run should return false when any sub-query fails");
    }

    #[tokio::test]
    async fn test_login_rates_divide_by_24() {
        let metrics = Metrics::new().unwrap();
        let mock = MockExecutor::new().with_rows(
            "SELECT REPORTED_CLIENT_TYPE",
            make_rows(&[&["DRV", "1.0", "24", "240", "264"]]),
        );
        let collector = Collector::new(Arc::new(mock), 60, false, false);
        let _ = collector.collect_logins(&metrics).await;

        assert_eq!(
            metrics.login_rate.with_label_values(&["DRV", "1.0"]).get(),
            11.0
        );
        assert_eq!(
            metrics
                .successful_login_rate
                .with_label_values(&["DRV", "1.0"])
                .get(),
            10.0
        );
        assert_eq!(
            metrics
                .failed_login_rate
                .with_label_values(&["DRV", "1.0"])
                .get(),
            1.0
        );
    }

    #[tokio::test]
    async fn test_exclude_deleted_runs_alt_query_and_skips_count() {
        let metrics = Metrics::new().unwrap();
        let mock = MockExecutor::new()
            .with_rows(
                "SELECT TABLE_NAME, ID, TABLE_SCHEMA, TABLE_SCHEMA_ID, TABLE_CATALOG, TABLE_CATALOG_ID, \
    sum(ACTIVE_BYTES), sum(TIME_TRAVEL_BYTES), sum(FAILSAFE_BYTES), sum(RETAINED_FOR_CLONE_BYTES) \
    FROM ACCOUNT_USAGE.TABLE_STORAGE_METRICS \
    WHERE DELETED = FALSE",
                make_rows(&[&[
                    "T1", "id-1", "PUBLIC", "s-1", "PROD", "db-1", "10", "20", "30", "40",
                ]]),
            )
            // Deleted-table count should NOT be invoked.
            .with_rows("SELECT COUNT(DISTINCT TABLE_NAME", make_rows(&[&["999"]]));

        let mock = Arc::new(mock);
        let collector = Collector::new(mock.clone(), 60, true, false);

        let _ = collector.collect_table_storage(&metrics).await;
        let _ = collector.collect_deleted_tables(&metrics).await;

        let out = metrics.encode();
        assert!(out.contains("snowflake_table_active_bytes"));
        // Deleted count was skipped — gauge never set.
        assert!(!out.contains("snowflake_table_deleted_tables 999"));
    }

    #[tokio::test]
    async fn test_empty_rows_yields_no_error() {
        let metrics = Metrics::new().unwrap();
        let mock: Arc<dyn QueryExecutor> = Arc::new(MockExecutor::new());
        let collector = Collector::new(mock, 60, false, false);
        assert!(collector.run(&metrics).await);
    }

    #[tokio::test]
    async fn test_null_cells_do_not_panic() {
        let metrics = Metrics::new().unwrap();
        let rows = vec![vec![Value::Null, Value::Null, Value::Null]];
        let mock = MockExecutor::new().with_rows("SELECT STORAGE_BYTES", rows);
        let collector = Collector::new(Arc::new(mock), 60, false, false);
        let _ = collector.collect_storage(&metrics).await;
        // No panic; metric stays at default 0.
        assert_eq!(metrics.storage_bytes.get(), 0.0);
    }
}
