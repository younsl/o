# Metrics

14 Prometheus metrics exposed by aurora-database-insights-exporter.

## Label structure

### Base labels

Present on every instance-level metric.

| Label | Source | Example |
|-------|--------|---------|
| `instance` | `DBInstanceIdentifier` | `prod-aurora-writer` |
| `resource_id` | `DbiResourceId` | `db-ABCDEFGHIJK` |
| `engine` | `Engine` | `aurora-mysql` |
| `region` | Config | `ap-northeast-2` |
| `cluster` | `DBClusterIdentifier` | `prod-aurora-cluster` |

### Exported tag labels

AWS tags listed in `discovery.exported_tags` become dynamic labels. Keys are normalized to `tag_<lowercase_snake>`.

| AWS Tag Key | Prometheus Label | Example Value |
|-------------|-----------------|---------------|
| `Team` | `tag_team` | `platform` |
| `Environment` | `tag_environment` | `production` |
| `app-name` | `tag_app_name` | `order-service` |

## All metrics

Dynamic label metrics (marked with Reset=yes) are cleared and re-populated every collection cycle to prevent stale time series.

| # | Metric | Type | Labels | Reset | Limit | Description |
|---|--------|------|--------|-------|-------|-------------|
| 1 | `aurora_dbinsights_db_load` | Gauge | base + tag_* | — | — | Total DB Load (Average Active Sessions) |
| 2 | `aurora_dbinsights_db_load_cpu` | Gauge | base + tag_* | — | — | CPU-attributed DB Load |
| 3 | `aurora_dbinsights_db_load_non_cpu` | Gauge | base + tag_* | — | — | Non-CPU DB Load (total - cpu) |
| 4 | `aurora_dbinsights_vcpu` | Gauge | base + tag_* | — | — | vCPU count from instance class |
| 5 | `aurora_dbinsights_up` | Gauge | base + tag_* | — | — | Collection status (1=ok, 0=error) |
| 6 | `aurora_dbinsights_db_load_by_wait_event` | Gauge | base + tag_* + `wait_event`, `wait_event_type` | yes | 25 | DB Load by wait event |
| 7 | `aurora_dbinsights_db_load_by_sql` | Gauge | base + tag_* + `sql_id` | yes | 10/inst | DB Load by top SQL |
| 8 | `aurora_dbinsights_sql_info` | Gauge | base + tag_* + `sql_id`, `sql_text`, `sql_text_truncated` | yes | 10/inst | SQL text info (value=1) |
| 9 | `aurora_dbinsights_db_load_by_user` | Gauge | base + tag_* + `db_user` | yes | — | DB Load by database user |
| 10 | `aurora_dbinsights_db_load_by_host` | Gauge | base + tag_* + `client_host` | yes | 20/inst | DB Load by client host |
| 11 | `aurora_dbinsights_scrape_duration_seconds` | Gauge | — | — | — | Collection cycle duration |
| 12 | `aurora_dbinsights_discovery_instances_total` | Gauge | — | — | — | Discovered instance count |
| 13 | `aurora_dbinsights_collection_errors_total` | Counter | `instance` | — | — | Cumulative PI API error count |
| 14 | `aurora_dbinsights_discovery_duration_seconds` | Gauge | — | — | — | Discovery cycle duration |

Notes:
- `sql_info` is an info metric (value always 1) that separates `sql_text` from `by_sql` to isolate cardinality. Join on `sql_id` in Grafana.
- `sql_text` is truncated at 200 characters. When truncated, `sql_text_truncated="true"`.
- `by_host` is capped by `top_host_limit` to prevent cardinality explosion from Kubernetes Pod IP churn.

## Cardinality estimate

Maximum time series with 10 instances.

| Category | Calculation | Time Series |
|----------|------------|-------------|
| Instance-level (5) | 5 × 10 | 50 |
| Wait event | 25 × 10 | 250 |
| Top SQL (by_sql + sql_info) | 10 × 2 × 10 | 200 |
| User | ~10 × 10 | 100 |
| Host | 20 × 10 | 200 |
| Error counter | 10 | 10 |
| Internal (3) | 3 | 3 |
| **Total** | | **~813** |

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

4 PI API calls per instance per cycle.

| # | API Call | Metrics Produced |
|---|----------|-----------------|
| 1 | `pi:GetResourceMetrics` GroupBy `db.wait_event` | `db_load`, `db_load_cpu`, `db_load_non_cpu`, `db_load_by_wait_event` |
| 2 | `pi:DescribeDimensionKeys` GroupBy `db.sql_tokenized` | `db_load_by_sql`, `sql_info` |
| 3 | `pi:GetResourceMetrics` GroupBy `db.user` | `db_load_by_user` |
| 4 | `pi:GetResourceMetrics` GroupBy `db.host` | `db_load_by_host` |
