use prometheus::{Gauge, GaugeVec, Opts, Registry, TextEncoder, core::Collector};

use crate::error::Result;

const NS: &str = "snowflake";

/// All Prometheus metrics exposed by the Snowflake exporter.
///
/// Metric names and label sets match the Grafana reference exporter.
/// All metrics are `GAUGE` because collection runs on a fixed interval and
/// overwrites the previous sample.
pub struct Metrics {
    pub registry: Registry,

    // Account-wide storage
    pub storage_bytes: Gauge,
    pub stage_bytes: Gauge,
    pub failsafe_bytes: Gauge,

    // Per-database storage
    pub database_bytes: GaugeVec,
    pub database_failsafe_bytes: GaugeVec,

    // Credits
    pub used_compute_credits: GaugeVec,
    pub used_cloud_services_credits: GaugeVec,
    pub warehouse_used_compute_credits: GaugeVec,
    pub warehouse_used_cloud_service_credits: GaugeVec,

    // Logins
    pub login_rate: GaugeVec,
    pub successful_login_rate: GaugeVec,
    pub failed_login_rate: GaugeVec,

    // Warehouse load
    pub warehouse_executed_queries: GaugeVec,
    pub warehouse_overloaded_queue_size: GaugeVec,
    pub warehouse_provisioning_queue_size: GaugeVec,
    pub warehouse_blocked_queries: GaugeVec,

    // Auto clustering
    pub auto_clustering_credits: GaugeVec,
    pub auto_clustering_bytes: GaugeVec,
    pub auto_clustering_rows: GaugeVec,

    // Table storage
    pub table_active_bytes: GaugeVec,
    pub table_time_travel_bytes: GaugeVec,
    pub table_failsafe_bytes: GaugeVec,
    pub table_clone_bytes: GaugeVec,
    pub table_deleted_tables: Gauge,

    // Replication
    pub db_replication_used_credits: GaugeVec,
    pub db_replication_transferred_bytes: GaugeVec,

    // Query aggregates (per warehouse, 24h)
    pub warehouse_successful_queries: GaugeVec,
    pub warehouse_failed_queries: GaugeVec,
    pub warehouse_query_avg_elapsed_seconds: GaugeVec,
    pub warehouse_query_avg_queued_seconds: GaugeVec,
    pub warehouse_query_avg_bytes_scanned: GaugeVec,
    pub warehouse_query_avg_cloud_services_credits: GaugeVec,

    // Serverless detail (optional, per pipe/task/MV)
    pub pipe_credits_used: GaugeVec,
    pub pipe_bytes_inserted: GaugeVec,
    pub pipe_files_inserted: GaugeVec,
    pub serverless_task_credits_used: GaugeVec,
    pub materialized_view_refresh_credits_used: GaugeVec,

    // Exporter-level
    pub up: Gauge,
    pub scrape_duration_seconds: Gauge,
    pub last_success_timestamp_seconds: Gauge,
}

impl Metrics {
    pub fn new() -> Result<Self> {
        let registry = Registry::new();

        let storage_bytes = Gauge::new(
            metric_name("", "storage_bytes"),
            "Number of bytes of table storage used, including bytes for data currently in Time Travel.",
        )?;
        let stage_bytes = Gauge::new(
            metric_name("", "stage_bytes"),
            "Number of bytes of stage storage used by files in all internal stages.",
        )?;
        let failsafe_bytes = Gauge::new(
            metric_name("", "failsafe_bytes"),
            "Number of bytes of data in Fail-safe.",
        )?;

        let database_bytes = gauge_vec(
            "database",
            "bytes",
            "Average number of bytes of database storage used, including data in Time Travel.",
            &["name", "id"],
        )?;
        let database_failsafe_bytes = gauge_vec(
            "database",
            "failsafe_bytes",
            "Average number of bytes of Fail-safe storage used.",
            &["name", "id"],
        )?;

        let used_compute_credits = gauge_vec(
            "",
            "used_compute_credits",
            "Average overall credits billed per hour for virtual warehouses over the last 24 hours.",
            &["service_type", "service"],
        )?;
        let used_cloud_services_credits = gauge_vec(
            "",
            "used_cloud_services_credits",
            "Average overall credits billed per hour for cloud services over the last 24 hours.",
            &["service_type", "service"],
        )?;
        let warehouse_used_compute_credits = gauge_vec(
            "warehouse",
            "used_compute_credits",
            "Average overall credits billed per hour for the warehouse over the last 24 hours.",
            &["name", "id"],
        )?;
        let warehouse_used_cloud_service_credits = gauge_vec(
            "warehouse",
            "used_cloud_service_credits",
            "Average overall credits billed per hour for cloud services for the warehouse over the last 24 hours.",
            &["name", "id"],
        )?;

        let login_rate = gauge_vec(
            "",
            "login_rate",
            "Rate of logins per-hour over the last 24 hours.",
            &["client_type", "client_version"],
        )?;
        let successful_login_rate = gauge_vec(
            "",
            "successful_login_rate",
            "Rate of successful logins per-hour over the last 24 hours.",
            &["client_type", "client_version"],
        )?;
        let failed_login_rate = gauge_vec(
            "",
            "failed_login_rate",
            "Rate of failed logins per-hour over the last 24 hours.",
            &["client_type", "client_version"],
        )?;

        let warehouse_executed_queries = gauge_vec(
            "warehouse",
            "executed_queries",
            "Average query load for queries executed over the last 24 hours.",
            &["name", "id"],
        )?;
        let warehouse_overloaded_queue_size = gauge_vec(
            "warehouse",
            "overloaded_queue_size",
            "Average load value for queries queued because the warehouse was overloaded over the last 24 hours.",
            &["name", "id"],
        )?;
        let warehouse_provisioning_queue_size = gauge_vec(
            "warehouse",
            "provisioning_queue_size",
            "Average load value for queries queued because the warehouse was being provisioned over the last 24 hours.",
            &["name", "id"],
        )?;
        let warehouse_blocked_queries = gauge_vec(
            "warehouse",
            "blocked_queries",
            "Average load value for queries blocked by a transaction lock over the last 24 hours.",
            &["name", "id"],
        )?;

        let table_labels = &[
            "table_name",
            "table_id",
            "schema_name",
            "schema_id",
            "database_name",
            "database_id",
        ];
        let auto_clustering_credits = gauge_vec(
            "auto_clustering",
            "credits",
            "Sum of the number of credits billed for automatic reclustering over the last 24 hours.",
            table_labels,
        )?;
        let auto_clustering_bytes = gauge_vec(
            "auto_clustering",
            "bytes",
            "Sum of the number of bytes reclustered during automatic reclustering over the last 24 hours.",
            table_labels,
        )?;
        let auto_clustering_rows = gauge_vec(
            "auto_clustering",
            "rows",
            "Sum of the number of rows clustered during automatic reclustering over the last 24 hours.",
            table_labels,
        )?;

        let table_active_bytes = gauge_vec(
            "table",
            "active_bytes",
            "Sum of active bytes owned by the table.",
            table_labels,
        )?;
        let table_time_travel_bytes = gauge_vec(
            "table",
            "time_travel_bytes",
            "Sum of bytes in Time Travel state owned by the table.",
            table_labels,
        )?;
        let table_failsafe_bytes = gauge_vec(
            "table",
            "failsafe_bytes",
            "Sum of bytes in Fail-Safe state owned by the table.",
            table_labels,
        )?;
        let table_clone_bytes = gauge_vec(
            "table",
            "clone_bytes",
            "Sum of bytes owned by the table that are retained after deletion because they are referenced by one or more clones.",
            table_labels,
        )?;
        let table_deleted_tables = Gauge::new(
            metric_name("table", "deleted_tables"),
            "Number of tables that have been purged from storage.",
        )?;

        let db_replication_used_credits = gauge_vec(
            "db_replication",
            "used_credits",
            "Sum of the number of credits used for database replication over the last 24 hours.",
            &["database_name", "database_id"],
        )?;
        let db_replication_transferred_bytes = gauge_vec(
            "db_replication",
            "transferred_bytes",
            "Sum of the number of transferred bytes for database replication over the last 24 hours.",
            &["database_name", "database_id"],
        )?;

        // Query aggregates
        let warehouse_successful_queries = gauge_vec(
            "warehouse",
            "successful_queries",
            "Number of queries that completed successfully on the warehouse over the last 24 hours.",
            &["name", "id"],
        )?;
        let warehouse_failed_queries = gauge_vec(
            "warehouse",
            "failed_queries",
            "Number of queries that ended in failure on the warehouse over the last 24 hours.",
            &["name", "id"],
        )?;
        let warehouse_query_avg_elapsed_seconds = gauge_vec(
            "warehouse",
            "query_avg_elapsed_seconds",
            "Average end-to-end query duration in seconds over successful queries in the last 24 hours.",
            &["name", "id"],
        )?;
        let warehouse_query_avg_queued_seconds = gauge_vec(
            "warehouse",
            "query_avg_queued_seconds",
            "Average time in seconds queries spent queued due to warehouse overload over the last 24 hours (successful queries only).",
            &["name", "id"],
        )?;
        let warehouse_query_avg_bytes_scanned = gauge_vec(
            "warehouse",
            "query_avg_bytes_scanned",
            "Average number of bytes scanned per successful query over the last 24 hours.",
            &["name", "id"],
        )?;
        let warehouse_query_avg_cloud_services_credits = gauge_vec(
            "warehouse",
            "query_avg_cloud_services_credits",
            "Average cloud-services credits consumed per successful query over the last 24 hours.",
            &["name", "id"],
        )?;

        // Serverless detail
        let pipe_credits_used = gauge_vec(
            "pipe",
            "credits_used",
            "Sum of credits used by the Snowpipe pipe over the last 24 hours.",
            &["pipe_name"],
        )?;
        let pipe_bytes_inserted = gauge_vec(
            "pipe",
            "bytes_inserted",
            "Sum of bytes ingested by the Snowpipe pipe over the last 24 hours.",
            &["pipe_name"],
        )?;
        let pipe_files_inserted = gauge_vec(
            "pipe",
            "files_inserted",
            "Sum of files ingested by the Snowpipe pipe over the last 24 hours.",
            &["pipe_name"],
        )?;
        let serverless_task_credits_used = gauge_vec(
            "serverless_task",
            "credits_used",
            "Sum of credits used by the serverless task over the last 24 hours.",
            &["task_name", "database_name", "schema_name"],
        )?;
        let materialized_view_refresh_credits_used = gauge_vec(
            "materialized_view",
            "refresh_credits_used",
            "Sum of credits used to refresh the materialized view over the last 24 hours.",
            &["database_name", "schema_name", "table_name"],
        )?;

        let up = Gauge::new(
            metric_name("", "up"),
            "Metric indicating the status of the exporter collection. 1=success, 0=failure.",
        )?;
        let scrape_duration_seconds = Gauge::new(
            metric_name("", "scrape_duration_seconds"),
            "Duration of the last Snowflake collection cycle in seconds.",
        )?;
        let last_success_timestamp_seconds = Gauge::new(
            metric_name("", "last_success_timestamp_seconds"),
            "Unix timestamp (seconds) of the last successful Snowflake collection cycle.",
        )?;

        let collectors: Vec<Box<dyn Collector>> = vec![
            Box::new(storage_bytes.clone()),
            Box::new(stage_bytes.clone()),
            Box::new(failsafe_bytes.clone()),
            Box::new(database_bytes.clone()),
            Box::new(database_failsafe_bytes.clone()),
            Box::new(used_compute_credits.clone()),
            Box::new(used_cloud_services_credits.clone()),
            Box::new(warehouse_used_compute_credits.clone()),
            Box::new(warehouse_used_cloud_service_credits.clone()),
            Box::new(login_rate.clone()),
            Box::new(successful_login_rate.clone()),
            Box::new(failed_login_rate.clone()),
            Box::new(warehouse_executed_queries.clone()),
            Box::new(warehouse_overloaded_queue_size.clone()),
            Box::new(warehouse_provisioning_queue_size.clone()),
            Box::new(warehouse_blocked_queries.clone()),
            Box::new(auto_clustering_credits.clone()),
            Box::new(auto_clustering_bytes.clone()),
            Box::new(auto_clustering_rows.clone()),
            Box::new(table_active_bytes.clone()),
            Box::new(table_time_travel_bytes.clone()),
            Box::new(table_failsafe_bytes.clone()),
            Box::new(table_clone_bytes.clone()),
            Box::new(table_deleted_tables.clone()),
            Box::new(db_replication_used_credits.clone()),
            Box::new(db_replication_transferred_bytes.clone()),
            Box::new(warehouse_successful_queries.clone()),
            Box::new(warehouse_failed_queries.clone()),
            Box::new(warehouse_query_avg_elapsed_seconds.clone()),
            Box::new(warehouse_query_avg_queued_seconds.clone()),
            Box::new(warehouse_query_avg_bytes_scanned.clone()),
            Box::new(warehouse_query_avg_cloud_services_credits.clone()),
            Box::new(pipe_credits_used.clone()),
            Box::new(pipe_bytes_inserted.clone()),
            Box::new(pipe_files_inserted.clone()),
            Box::new(serverless_task_credits_used.clone()),
            Box::new(materialized_view_refresh_credits_used.clone()),
            Box::new(up.clone()),
            Box::new(scrape_duration_seconds.clone()),
            Box::new(last_success_timestamp_seconds.clone()),
        ];
        for c in collectors {
            registry.register(c)?;
        }

        Ok(Self {
            registry,
            storage_bytes,
            stage_bytes,
            failsafe_bytes,
            database_bytes,
            database_failsafe_bytes,
            used_compute_credits,
            used_cloud_services_credits,
            warehouse_used_compute_credits,
            warehouse_used_cloud_service_credits,
            login_rate,
            successful_login_rate,
            failed_login_rate,
            warehouse_executed_queries,
            warehouse_overloaded_queue_size,
            warehouse_provisioning_queue_size,
            warehouse_blocked_queries,
            auto_clustering_credits,
            auto_clustering_bytes,
            auto_clustering_rows,
            table_active_bytes,
            table_time_travel_bytes,
            table_failsafe_bytes,
            table_clone_bytes,
            table_deleted_tables,
            db_replication_used_credits,
            db_replication_transferred_bytes,
            warehouse_successful_queries,
            warehouse_failed_queries,
            warehouse_query_avg_elapsed_seconds,
            warehouse_query_avg_queued_seconds,
            warehouse_query_avg_bytes_scanned,
            warehouse_query_avg_cloud_services_credits,
            pipe_credits_used,
            pipe_bytes_inserted,
            pipe_files_inserted,
            serverless_task_credits_used,
            materialized_view_refresh_credits_used,
            up,
            scrape_duration_seconds,
            last_success_timestamp_seconds,
        })
    }

    /// Encode all metrics as Prometheus text format.
    pub fn encode(&self) -> String {
        let encoder = TextEncoder::new();
        let metric_families = self.registry.gather();
        encoder
            .encode_to_string(&metric_families)
            .unwrap_or_default()
    }

    /// Drop every label combination for `GaugeVec` metrics that change across
    /// collection cycles. Prevents stale series from lingering when a
    /// database/warehouse/table is removed.
    pub fn reset_dynamic_labels(&self) {
        reset(&self.database_bytes);
        reset(&self.database_failsafe_bytes);
        reset(&self.used_compute_credits);
        reset(&self.used_cloud_services_credits);
        reset(&self.warehouse_used_compute_credits);
        reset(&self.warehouse_used_cloud_service_credits);
        reset(&self.login_rate);
        reset(&self.successful_login_rate);
        reset(&self.failed_login_rate);
        reset(&self.warehouse_executed_queries);
        reset(&self.warehouse_overloaded_queue_size);
        reset(&self.warehouse_provisioning_queue_size);
        reset(&self.warehouse_blocked_queries);
        reset(&self.auto_clustering_credits);
        reset(&self.auto_clustering_bytes);
        reset(&self.auto_clustering_rows);
        reset(&self.table_active_bytes);
        reset(&self.table_time_travel_bytes);
        reset(&self.table_failsafe_bytes);
        reset(&self.table_clone_bytes);
        reset(&self.db_replication_used_credits);
        reset(&self.db_replication_transferred_bytes);
        reset(&self.warehouse_successful_queries);
        reset(&self.warehouse_failed_queries);
        reset(&self.warehouse_query_avg_elapsed_seconds);
        reset(&self.warehouse_query_avg_queued_seconds);
        reset(&self.warehouse_query_avg_bytes_scanned);
        reset(&self.warehouse_query_avg_cloud_services_credits);
        reset(&self.pipe_credits_used);
        reset(&self.pipe_bytes_inserted);
        reset(&self.pipe_files_inserted);
        reset(&self.serverless_task_credits_used);
        reset(&self.materialized_view_refresh_credits_used);
    }
}

fn gauge_vec(subsystem: &str, name: &str, help: &str, labels: &[&str]) -> Result<GaugeVec> {
    let fq = metric_name(subsystem, name);
    let opts = Opts::new(fq, help);
    Ok(GaugeVec::new(opts, labels)?)
}

fn metric_name(subsystem: &str, name: &str) -> String {
    if subsystem.is_empty() {
        format!("{NS}_{name}")
    } else {
        format!("{NS}_{subsystem}_{name}")
    }
}

fn reset(gauge: &GaugeVec) {
    let families = gauge.collect();
    let desc_order: Vec<String> = gauge
        .desc()
        .first()
        .map(|d| d.variable_labels.to_vec())
        .unwrap_or_default();
    for mf in &families {
        for m in mf.get_metric() {
            let lp = m.get_label();
            let values: Vec<&str> = desc_order
                .iter()
                .map(|name| {
                    lp.iter()
                        .find(|p| p.get_name() == *name)
                        .map(|p| p.get_value())
                        .unwrap_or("")
                })
                .collect();
            let _ = gauge.remove_label_values(&values);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_metric_name_with_subsystem() {
        assert_eq!(
            metric_name("warehouse", "executed_queries"),
            "snowflake_warehouse_executed_queries"
        );
        assert_eq!(metric_name("", "up"), "snowflake_up");
    }

    #[test]
    fn test_metrics_new_registers_all() {
        let m = Metrics::new().unwrap();
        // Sample a known metric exists in the encoded output after setting a value.
        m.up.set(1.0);
        m.storage_bytes.set(100.0);
        let out = m.encode();
        assert!(out.contains("snowflake_up 1"));
        assert!(out.contains("snowflake_storage_bytes 100"));
    }

    #[test]
    fn test_reset_dynamic_labels_clears_gauge_vec() {
        let m = Metrics::new().unwrap();
        m.database_bytes
            .with_label_values(&["PROD_DB", "123"])
            .set(42.0);
        assert!(m.encode().contains("PROD_DB"));

        m.reset_dynamic_labels();
        assert!(!m.encode().contains("PROD_DB"));
    }
}
