# Exported Metrics

All metrics are Prometheus **gauges** (`# TYPE <name> gauge`). They are
refreshed on the collection interval (`collection.interval_seconds`, default
`300s`) and cleared between cycles so that deleted databases, warehouses, or
tables do not linger as stale series.

Namespace: `snowflake_`

## Storage (account-wide)

| Metric | Type | Labels | Description | Source |
|--------|------|--------|-------------|--------|
| `snowflake_storage_bytes` | Gauge | — | Bytes of table storage used, including Time Travel. | `ACCOUNT_USAGE.STORAGE_USAGE` |
| `snowflake_stage_bytes` | Gauge | — | Bytes of stage storage used by all internal stages. | `ACCOUNT_USAGE.STORAGE_USAGE` |
| `snowflake_failsafe_bytes` | Gauge | — | Bytes of data in Fail-safe. | `ACCOUNT_USAGE.STORAGE_USAGE` |

## Storage (per database)

| Metric | Type | Labels | Description | Source |
|--------|------|--------|-------------|--------|
| `snowflake_database_bytes` | Gauge | `name`, `id` | Average bytes of database storage used (incl. Time Travel) over the last 24h. | `ACCOUNT_USAGE.DATABASE_STORAGE_USAGE_HISTORY` |
| `snowflake_database_failsafe_bytes` | Gauge | `name`, `id` | Average bytes of Fail-safe storage over the last 24h. | `ACCOUNT_USAGE.DATABASE_STORAGE_USAGE_HISTORY` |

## Credits

| Metric | Type | Labels | Description | Source |
|--------|------|--------|-------------|--------|
| `snowflake_used_compute_credits` | Gauge | `service_type`, `service` | Average credits billed per hour for virtual warehouses (24h). | `ACCOUNT_USAGE.METERING_HISTORY` |
| `snowflake_used_cloud_services_credits` | Gauge | `service_type`, `service` | Average credits billed per hour for cloud services (24h). | `ACCOUNT_USAGE.METERING_HISTORY` |
| `snowflake_warehouse_used_compute_credits` | Gauge | `name`, `id` | Average credits billed per hour for the warehouse (24h). | `ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY` |
| `snowflake_warehouse_used_cloud_service_credits` | Gauge | `name`, `id` | Average credits billed per hour for cloud services for the warehouse (24h). | `ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY` |

## Logins

Rates are reported per hour (24h aggregate divided by 24).

| Metric | Type | Labels | Description | Source |
|--------|------|--------|-------------|--------|
| `snowflake_login_rate` | Gauge | `client_type`, `client_version` | Total logins per hour. | `ACCOUNT_USAGE.LOGIN_HISTORY` |
| `snowflake_successful_login_rate` | Gauge | `client_type`, `client_version` | Successful logins per hour. | `ACCOUNT_USAGE.LOGIN_HISTORY` |
| `snowflake_failed_login_rate` | Gauge | `client_type`, `client_version` | Failed logins per hour. | `ACCOUNT_USAGE.LOGIN_HISTORY` |

## Warehouse load

| Metric | Type | Labels | Description | Source |
|--------|------|--------|-------------|--------|
| `snowflake_warehouse_executed_queries` | Gauge | `name`, `id` | Average query load for queries executed (24h). | `ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY` |
| `snowflake_warehouse_overloaded_queue_size` | Gauge | `name`, `id` | Average load for queries queued due to overload (24h). | `ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY` |
| `snowflake_warehouse_provisioning_queue_size` | Gauge | `name`, `id` | Average load for queries queued during provisioning (24h). | `ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY` |
| `snowflake_warehouse_blocked_queries` | Gauge | `name`, `id` | Average load for queries blocked by transaction locks (24h). | `ACCOUNT_USAGE.WAREHOUSE_LOAD_HISTORY` |

## Auto clustering

All labels: `table_name`, `table_id`, `schema_name`, `schema_id`, `database_name`, `database_id`.

| Metric | Type | Description | Source |
|--------|------|-------------|--------|
| `snowflake_auto_clustering_credits` | Gauge | Sum of credits billed for automatic reclustering (24h). | `ACCOUNT_USAGE.AUTOMATIC_CLUSTERING_HISTORY` |
| `snowflake_auto_clustering_bytes` | Gauge | Sum of bytes reclustered during automatic reclustering (24h). | `ACCOUNT_USAGE.AUTOMATIC_CLUSTERING_HISTORY` |
| `snowflake_auto_clustering_rows` | Gauge | Sum of rows reclustered during automatic reclustering (24h). | `ACCOUNT_USAGE.AUTOMATIC_CLUSTERING_HISTORY` |

## Table storage

Table-level series can be high-cardinality on large accounts. Consider
`metricRelabelings` in `values.yaml` to drop what you do not query.

Common labels: `table_name`, `table_id`, `schema_name`, `schema_id`, `database_name`, `database_id`.

| Metric | Type | Description | Source |
|--------|------|-------------|--------|
| `snowflake_table_active_bytes` | Gauge | Active bytes owned by the table. | `ACCOUNT_USAGE.TABLE_STORAGE_METRICS` |
| `snowflake_table_time_travel_bytes` | Gauge | Bytes in Time Travel state. | `ACCOUNT_USAGE.TABLE_STORAGE_METRICS` |
| `snowflake_table_failsafe_bytes` | Gauge | Bytes in Fail-Safe state. | `ACCOUNT_USAGE.TABLE_STORAGE_METRICS` |
| `snowflake_table_clone_bytes` | Gauge | Bytes retained after deletion due to clone references. | `ACCOUNT_USAGE.TABLE_STORAGE_METRICS` |
| `snowflake_table_deleted_tables` | Gauge | Count of tables purged from storage. Skipped when `collection.exclude_deleted_tables=true`. | `ACCOUNT_USAGE.TABLE_STORAGE_METRICS` |

When `collection.exclude_deleted_tables=true`, table storage uses the
`DELETED = FALSE` query variant and the deleted-tables count is not emitted.

## Replication

| Metric | Type | Labels | Description | Source |
|--------|------|--------|-------------|--------|
| `snowflake_db_replication_used_credits` | Gauge | `database_name`, `database_id` | Credits used for database replication (24h). | `ACCOUNT_USAGE.REPLICATION_USAGE_HISTORY` |
| `snowflake_db_replication_transferred_bytes` | Gauge | `database_name`, `database_id` | Bytes transferred for database replication (24h). | `ACCOUNT_USAGE.REPLICATION_USAGE_HISTORY` |

## Query aggregates

Warehouse-scoped aggregates over the last 24 hours. Averages are computed
across successful queries only to avoid skew from parse-time failures.

| Metric | Type | Labels | Description | Source |
|--------|------|--------|-------------|--------|
| `snowflake_warehouse_successful_queries` | Gauge | `name`, `id` | Number of queries that completed successfully (24h). | `ACCOUNT_USAGE.QUERY_HISTORY` |
| `snowflake_warehouse_failed_queries` | Gauge | `name`, `id` | Number of queries that ended with failure (24h). | `ACCOUNT_USAGE.QUERY_HISTORY` |
| `snowflake_warehouse_query_avg_elapsed_seconds` | Gauge | `name`, `id` | Average end-to-end query duration in seconds. | `ACCOUNT_USAGE.QUERY_HISTORY` |
| `snowflake_warehouse_query_avg_queued_seconds` | Gauge | `name`, `id` | Average time queries spent queued due to warehouse overload. | `ACCOUNT_USAGE.QUERY_HISTORY` |
| `snowflake_warehouse_query_avg_bytes_scanned` | Gauge | `name`, `id` | Average bytes scanned per successful query. | `ACCOUNT_USAGE.QUERY_HISTORY` |
| `snowflake_warehouse_query_avg_cloud_services_credits` | Gauge | `name`, `id` | Average cloud-services credits consumed per successful query. | `ACCOUNT_USAGE.QUERY_HISTORY` |

Suggested alerts:

```promql
# Failure rate > 5% over 24h
snowflake_warehouse_failed_queries
/ (snowflake_warehouse_successful_queries + snowflake_warehouse_failed_queries) > 0.05

# Query latency regressed 2x vs 7-day baseline
snowflake_warehouse_query_avg_elapsed_seconds
/ avg_over_time(snowflake_warehouse_query_avg_elapsed_seconds[7d] offset 1d) > 2
```

## Serverless detail (optional)

Gated by `collection.enableServerlessDetail=true`. **Off by default** because
cardinality scales with the number of pipes/tasks/materialized views.
Enable only when you need per-object cost attribution.

| Metric | Type | Labels | Description | Source |
|--------|------|--------|-------------|--------|
| `snowflake_pipe_credits_used` | Gauge | `pipe_name` | Credits used by the Snowpipe pipe (24h sum). | `ACCOUNT_USAGE.PIPE_USAGE_HISTORY` |
| `snowflake_pipe_bytes_inserted` | Gauge | `pipe_name` | Bytes ingested by the pipe (24h sum). | `ACCOUNT_USAGE.PIPE_USAGE_HISTORY` |
| `snowflake_pipe_files_inserted` | Gauge | `pipe_name` | Files ingested by the pipe (24h sum). | `ACCOUNT_USAGE.PIPE_USAGE_HISTORY` |
| `snowflake_serverless_task_credits_used` | Gauge | `task_name`, `database_name`, `schema_name` | Credits used by the serverless task (24h sum). | `ACCOUNT_USAGE.SERVERLESS_TASK_HISTORY` |
| `snowflake_materialized_view_refresh_credits_used` | Gauge | `database_name`, `schema_name`, `table_name` | Credits used to refresh the materialized view (24h sum). | `ACCOUNT_USAGE.MATERIALIZED_VIEW_REFRESH_HISTORY` |

## Exporter health

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `snowflake_up` | Gauge | — | `1` if the last collection cycle succeeded, `0` if any sub-query failed. |
| `snowflake_scrape_duration_seconds` | Gauge | — | Duration of the last collection cycle. |
| `snowflake_last_success_timestamp_seconds` | Gauge | — | Unix timestamp of the last fully successful cycle. |

## Data latency

`ACCOUNT_USAGE` views have documented latency (often 45 minutes to 3 hours
depending on the view). Metrics therefore trail live warehouse activity;
`snowflake_last_success_timestamp_seconds` reflects when the exporter last
succeeded, not when the underlying data was generated.
