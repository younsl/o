# Metrics

All Prometheus metrics exposed by aurora-database-insights-exporter.

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

## Instance-level metrics

Static labels per instance. Updated every collection cycle.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `aurora_dbinsights_db_load` | Gauge | base + tag_* | Total DB Load (Average Active Sessions) |
| `aurora_dbinsights_db_load_cpu` | Gauge | base + tag_* | DB Load attributed to CPU wait events |
| `aurora_dbinsights_db_load_non_cpu` | Gauge | base + tag_* | DB Load from non-CPU wait events (total - cpu) |
| `aurora_dbinsights_vcpu` | Gauge | base + tag_* | vCPU count derived from instance class |
| `aurora_dbinsights_up` | Gauge | base + tag_* | Collection status. 1=ok, 0=error |

## Breakdown metrics

Dynamic label metrics. **All previous time series are removed at the start of each cycle** before new values are set. This prevents stale time series from accumulating.

### Wait event

| Metric | Type | Labels | Limit |
|--------|------|--------|-------|
| `aurora_dbinsights_db_load_by_wait_event` | Gauge | base + tag_* + `wait_event`, `wait_event_type` | 25 |

Grouped by PI API `db.wait_event` dimension. The sum of entries where `wait_event_type=CPU` equals `db_load_cpu`.

### Top SQL

| Metric | Type | Labels | Limit |
|--------|------|--------|-------|
| `aurora_dbinsights_db_load_by_sql` | Gauge | base + tag_* + `sql_id` | 10/instance |
| `aurora_dbinsights_sql_info` | Gauge | base + tag_* + `sql_id`, `sql_text`, `sql_text_truncated` | 10/instance |

`by_sql` carries only `sql_id` to minimize cardinality. SQL text is separated into the `sql_info` info metric (value always 1). Join on `sql_id` in Grafana to display the statement. `sql_text` is truncated at 200 characters. When truncated, `sql_text_truncated="true"`.

### User

| Metric | Type | Labels | Limit |
|--------|------|--------|-------|
| `aurora_dbinsights_db_load_by_user` | Gauge | base + tag_* + `db_user` | — |

### Host

| Metric | Type | Labels | Limit |
|--------|------|--------|-------|
| `aurora_dbinsights_db_load_by_host` | Gauge | base + tag_* + `client_host` | 20/instance |

Capped by `top_host_limit` to prevent cardinality explosion from Kubernetes Pod IP churn during rolling deployments.

## Exporter internal metrics

Operational health of the exporter itself.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `aurora_dbinsights_scrape_duration_seconds` | Gauge | — | Time spent on the last collection cycle |
| `aurora_dbinsights_discovery_instances_total` | Gauge | — | Number of currently discovered instances |
| `aurora_dbinsights_collection_errors_total` | Counter | `instance` | Cumulative PI API error count |
| `aurora_dbinsights_discovery_duration_seconds` | Gauge | — | Time spent on the last discovery cycle |

## Cardinality estimate

Maximum time series with 10 instances.

| Category | Calculation | Time Series |
|----------|------------|-------------|
| Instance-level (5) | 5 × 10 | 50 |
| Wait event | 25 × 10 | 250 |
| Top SQL (`by_sql` + `sql_info`) | 10 × 2 × 10 | 200 |
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
