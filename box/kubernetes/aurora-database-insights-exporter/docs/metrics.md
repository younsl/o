# Metrics

22 Prometheus metrics exposed by aurora-database-insights-exporter.

## Label structure

### Base labels

Present on every instance-level metric.

| Label | Source | Example |
|-------|--------|---------|
| `instance` | `DBInstanceIdentifier` | `prod-aurora-writer` |
| `resource_id` | `DbiResourceId` | `db-ABCDEFGHIJK` |
| `engine` | `Engine` | `aurora-mysql` |
| `region` | Config | `ap-northeast-2` |
| `db_cluster` | `DBClusterIdentifier` | `prod-aurora-cluster` |

### Exported tag labels

AWS tags listed in `discovery.exported_tags` become dynamic labels. Keys are normalized to `tag_<lowercase_snake>`.

| AWS Tag Key | Prometheus Label | Example Value |
|-------------|-----------------|---------------|
| `Team` | `tag_team` | `platform` |
| `Environment` | `tag_environment` | `production` |
| `app-name` | `tag_app_name` | `order-service` |

## All metrics

Dynamic label metrics (marked with Reset=yes) are cleared and re-populated every collection cycle to prevent stale time series.

| # | Metric | Type | Labels | Reset | Limit | Engine | Description |
|---|--------|------|--------|-------|-------|--------|-------------|
| 1 | `aurora_dbinsights_db_load` | Gauge | base + tag_* | — | — | All | Total DB Load (Average Active Sessions) |
| 2 | `aurora_dbinsights_db_load_cpu` | Gauge | base + tag_* | — | — | All | CPU-attributed DB Load |
| 3 | `aurora_dbinsights_db_load_non_cpu` | Gauge | base + tag_* | — | — | All | Non-CPU DB Load (total - cpu) |
| 4 | `aurora_dbinsights_vcpu` | Gauge | base + tag_* | — | — | All | vCPU count from instance class |
| 5 | `aurora_dbinsights_up` | Gauge | base + tag_* | — | — | All | Collection status (1=ok, 0=error) |
| 6 | `aurora_dbinsights_db_load_by_wait_event` | Gauge | base + tag_* + `wait_event`, `wait_event_type` | yes | 25 | All | DB Load by wait event |
| 7 | `aurora_dbinsights_db_load_by_sql_tokenized` | Gauge | base + tag_* + `sql_tokenized_id` | yes | 10/inst | All | DB Load by tokenized SQL pattern |
| 8 | `aurora_dbinsights_sql_tokenized_info` | Gauge | base + tag_* + `sql_tokenized_id`, `sql_tokenized_text`, `sql_tokenized_text_truncated` | yes | 10/inst | All | Tokenized SQL text info (value=1) |
| 9 | `aurora_dbinsights_sql_tokenized_calls_per_sec` | Gauge | base + tag_* + `sql_tokenized_id` | yes | 10/inst | PostgreSQL | Calls/sec per tokenized SQL |
| 10 | `aurora_dbinsights_sql_tokenized_avg_latency_per_call` | Gauge | base + tag_* + `sql_tokenized_id` | yes | 10/inst | PostgreSQL | Avg latency per call (ms) |
| 11 | `aurora_dbinsights_sql_tokenized_rows_per_call` | Gauge | base + tag_* + `sql_tokenized_id` | yes | 10/inst | PostgreSQL | Avg rows per call |
| 12 | `aurora_dbinsights_db_load_by_sql` | Gauge | base + tag_* + `sql_id` | yes | 10/inst | All | DB Load by actual SQL statement |
| 13 | `aurora_dbinsights_sql_info` | Gauge | base + tag_* + `sql_id`, `sql_text`, `sql_full_text`, `sql_text_truncated` | yes | 10/inst | All | SQL text info with full statement (value=1) |
| 14 | `aurora_dbinsights_db_load_by_user` | Gauge | base + tag_* + `db_user` | yes | — | All | DB Load by database user |
| 15 | `aurora_dbinsights_db_load_by_host` | Gauge | base + tag_* + `client_host` | yes | 20/inst | All | DB Load by client host |
| 16 | `aurora_dbinsights_db_load_by_database` | Gauge | base + tag_* + `db_name` | yes | — | All | DB Load by database schema |
| 17 | `aurora_dbinsights_scrape_duration_seconds` | Gauge | — | — | — | All | Collection cycle duration |
| 18 | `aurora_dbinsights_discovery_instances_total` | Gauge | — | — | — | All | Discovered instance count |
| 19 | `aurora_dbinsights_collection_errors_total` | Counter | `instance` | — | — | All | Cumulative PI API error count |
| 20 | `aurora_dbinsights_discovery_duration_seconds` | Gauge | — | — | — | All | Discovery cycle duration |
| 21 | `aurora_dbinsights_last_success_timestamp_seconds` | Gauge | base + tag_* | — | — | All | Unix timestamp (seconds) of the last successful collection per instance |
| 22 | `aurora_dbinsights_pi_api_errors_total` | Counter | `instance`, `api`, `error_kind` | — | — | All | PI API call errors classified by API and error kind |

Notes:
- **Engine column**: `All` means the metric is available for both Aurora MySQL and Aurora PostgreSQL. `PostgreSQL` means the metric is only populated for Aurora PostgreSQL instances (sourced from `pg_stat_statements` via the PI API `AdditionalMetrics` parameter). Aurora MySQL does not support `AdditionalMetrics` — see [limitation.md](limitation.md) for details.
- Two levels of SQL metrics are collected: `db.sql_tokenized` (parameterized pattern, e.g. `WHERE id = ?`) and `db.sql` (actual statement with bind values, e.g. `WHERE id = 12345`).
- `sql_tokenized_info` is an info metric (value always 1) that separates tokenized SQL text from `by_sql_tokenized` to isolate cardinality. Join on `sql_tokenized_id` in Grafana.
- `sql_info` is an info metric (value always 1) for actual SQL statements. `sql_full_text` contains the full SQL from `GetDimensionKeyDetails` API. `sql_text` is truncated at 200 characters. Join on `sql_id` in Grafana.
- `sql_full_text` is the full SQL statement text including bind variable values, retrieved via `pi:GetDimensionKeyDetails`. Falls back to the `DescribeDimensionKeys` text on failure.
- `by_host` is capped by `top_host_limit` to prevent cardinality explosion from Kubernetes Pod IP churn.
- `by_database` uses PI API dimension group `db` (not `db.name`). The dimension key inside the response is `db.name`.
- `collection_errors_total` is initialized to 0 per instance on first successful collection to prevent No Data in alerting.
- `wait_event_type` contains the actual event type (`CPU`, `io`, `Lock`) resolved from the `db.wait_event.type` dimension key.
- `last_success_timestamp_seconds` is only updated when a full collection cycle for an instance succeeds. On failure the value is left untouched so that `time() - last_success_timestamp_seconds` grows until the next success. Shares the same label set as `up` and `db_load` so PromQL joins require no relabeling.
- `pi_api_errors_total` has `api` ∈ `{GetResourceMetrics, DescribeDimensionKeys, GetDimensionKeyDetails}` and `error_kind` ∈ `{throttle, auth, timeout, not_found, validation, other}`. Classification is pattern-based on the SDK error string; unknown messages fall back to `other`. Counter increments on every failed API call (including retry attempts), so rate-based alerts on `throttle` give a direct signal of PI API quota pressure.

## Cardinality estimate

Maximum time series with 10 instances.

| Category | Calculation | Time Series |
|----------|------------|-------------|
| Instance-level (5) | 5 × 10 | 50 |
| Wait event | 25 × 10 | 250 |
| Top SQL tokenized (by_sql_tokenized + sql_tokenized_info) | 10 × 2 × 10 | 200 |
| SQL tokenized additional (PostgreSQL only) | 10 × 3 × 10 | 300 |
| Top SQL actual (by_sql + sql_info) | 10 × 2 × 10 | 200 |
| User | ~10 × 10 | 100 |
| Host | 20 × 10 | 200 |
| Database | ~5 × 10 | 50 |
| Error counter | 10 | 10 |
| Internal (3) | 3 | 3 |
| Last success timestamp | 1 × 10 | 10 |
| PI API errors (api × kind, bounded) | ≤ 3 × 6 × 10 | ≤ 180 |
| **Total** | | **~1553** |

Cycle reset keeps the total bounded. Adding exported tags increases label count per series but does not increase the number of series.

## Collecting metrics with Prometheus Operator

When running [Prometheus Operator](https://github.com/prometheus-operator/prometheus-operator) in Kubernetes, the Helm chart deploys a `ServiceMonitor` resource that automatically registers aurora-database-insights-exporter as a scrape target. No manual Prometheus configuration is required.

The ServiceMonitor selects the exporter's Service by matching `app.kubernetes.io/name` and `app.kubernetes.io/instance` labels, then scrapes the `/metrics` endpoint on the `metrics` port.

```yaml
# Rendered ServiceMonitor (simplified)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: release-aurora-database-insights-exporter
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: aurora-database-insights-exporter
      app.kubernetes.io/instance: release
  endpoints:
    - port: metrics
      interval: 60s
      scrapeTimeout: 30s
      path: /metrics
```

### Helm values

| Value | Default | Description |
|-------|---------|-------------|
| `serviceMonitor.enabled` | `true` | Create the ServiceMonitor resource |
| `serviceMonitor.interval` | `60s` | How often Prometheus scrapes the exporter |
| `serviceMonitor.scrapeTimeout` | `30s` | Per-scrape timeout |
| `serviceMonitor.labels` | `{}` | Extra labels on the ServiceMonitor (useful when Prometheus uses `serviceMonitorSelector`) |

If the Prometheus instance uses a label selector to discover ServiceMonitors (e.g., `release: kube-prometheus-stack`), add the matching label:

```yaml
serviceMonitor:
  labels:
    release: kube-prometheus-stack
```

### Verifying the scrape target

After deploying, confirm the exporter appears in the Prometheus targets:

```bash
# Port-forward to Prometheus
kubectl port-forward svc/prometheus-operated 9090:9090

# Check targets page
open http://localhost:9090/targets
# Look for serviceMonitor/<namespace>/release-aurora-database-insights-exporter/0
```

## PI API call mapping

6 + N PI API calls per instance per cycle (N = number of top SQL statements, up to `top_sql_limit`).

| # | API Call | Metrics Produced |
|---|----------|-----------------|
| 1 | `pi:GetResourceMetrics` GroupBy `db.wait_event` | `db_load`, `db_load_cpu`, `db_load_non_cpu`, `db_load_by_wait_event` |
| 2 | `pi:DescribeDimensionKeys` GroupBy `db.sql_tokenized` (+ `AdditionalMetrics` for PostgreSQL) | `db_load_by_sql_tokenized`, `sql_tokenized_info`, `sql_tokenized_calls_per_sec`*, `sql_tokenized_avg_latency_per_call`*, `sql_tokenized_rows_per_call`* |
| 3 | `pi:DescribeDimensionKeys` GroupBy `db.sql` | `db_load_by_sql` |
| 3+N | `pi:GetDimensionKeyDetails` Group `db.sql` per sql_id | `sql_info` (`sql_full_text`) |
| 4 | `pi:GetResourceMetrics` GroupBy `db.user` | `db_load_by_user` |
| 5 | `pi:GetResourceMetrics` GroupBy `db.host` | `db_load_by_host` |
| 6 | `pi:GetResourceMetrics` GroupBy `db` | `db_load_by_database` |

## Reference

- [Performance Insights API - DimensionGroup](https://docs.aws.amazon.com/performance-insights/latest/APIReference/API_DimensionGroup.html) — Supported dimension groups and dimensions per engine
- [Performance Insights API - GetResourceMetrics](https://docs.aws.amazon.com/performance-insights/latest/APIReference/API_GetResourceMetrics.html) — Time-series metric retrieval
- [Performance Insights API - DescribeDimensionKeys](https://docs.aws.amazon.com/performance-insights/latest/APIReference/API_DescribeDimensionKeys.html) — Top N dimension key retrieval
- [Performance Insights API - GetDimensionKeyDetails](https://docs.aws.amazon.com/performance-insights/latest/APIReference/API_GetDimensionKeyDetails.html) — Full SQL statement text retrieval
- [Using the Performance Insights API](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.API.html) — Aurora User Guide overview
- [Prometheus Operator - ServiceMonitor](https://github.com/prometheus-operator/prometheus-operator/blob/main/Documentation/api-reference/api.md#monitoring.coreos.com/v1.ServiceMonitor) — ServiceMonitor CRD reference
