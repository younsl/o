# Prometheus Metrics

trivy-collector exposes Prometheus metrics via OpenMetrics format at the health server's `/metrics` endpoint (default port `8080`). Metrics are mode-specific — Server and Collector register different metrics based on their operational role.

**Target audience**: Platform Engineers and SREs configuring monitoring and alerting for trivy-collector.

## Endpoint

| Path | Port | Format |
|------|------|--------|
| `/metrics` | `8080` (health port) | OpenMetrics text |

The `/metrics` endpoint shares the same health server as `/healthz` and `/readyz`. No separate port is required.

## Common Metrics

Available in both Server and Collector modes.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `trivy_collector_info` | Gauge | `version`, `mode` | Build information (always 1) |

## Server Mode Metrics

### HTTP

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `trivy_collector_http_requests_total` | Counter | `method`, `status` | Total HTTP requests |
| `trivy_collector_http_request_duration_seconds` | Histogram | `method` | HTTP request duration |

Histogram buckets: `0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0`

Excluded paths (not counted): `/healthz`, `/readyz`, `/metrics`, `/assets/*`, `/static/*`

### Reports

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `trivy_collector_reports_received_total` | Counter | `cluster`, `report_type` | Reports received from collectors |

### Database

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `trivy_collector_db_size_bytes` | Gauge | — | SQLite database file size |
| `trivy_collector_db_reports_total` | Gauge | `report_type` | Stored report count per type |
| `trivy_collector_api_logs_total` | Gauge | — | API log entry count |

Database gauges are refreshed every **60 seconds** by a background task.

### Log Cleanup

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `trivy_collector_api_logs_cleanup_runs_total` | Counter | `result` | Cleanup executions (`success`/`error`) |
| `trivy_collector_api_logs_cleanup_deleted_total` | Counter | — | Cumulative deleted log entries |

Log cleanup runs every **6 hours** (retention: 7 days).

## Collector Mode Metrics

### Report Sending

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `trivy_collector_reports_sent_total` | Counter | `report_type`, `result` | Reports sent to server (`success`/`error`) |
| `trivy_collector_reports_send_duration_seconds` | Histogram | `report_type` | Send duration per report |
| `trivy_collector_send_retries_total` | Counter | `report_type` | Send retry count |

Histogram buckets: `0.01, 0.05, 0.1, 0.5, 1.0, 5.0, 10.0, 30.0`

### Kubernetes Watcher

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `trivy_collector_watcher_events_total` | Counter | `report_type`, `event_type` | K8s watcher events |

`event_type` values: `apply`, `init_apply`, `delete`, `init`, `init_done`

### Server Connectivity

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `trivy_collector_server_up` | Gauge | — | Central server status (`1`=up, `0`=down) |

Updated by periodic health checker. Not registered when `HEALTH_CHECK_INTERVAL_SECS=0`.

## ServiceMonitor

Enable Prometheus Operator scraping via Helm values:

```yaml
serviceMonitor:
  enabled: true
  interval: 30s
  scrapeTimeout: ""
  additionalLabels: {}
```

The chart creates:
- A **Service** (both modes) with a `metrics` port (8080) targeting the health server
- A **ServiceMonitor** resource pointing to `port: metrics`, `path: /metrics`

Requires `monitoring.coreos.com/v1` API (Prometheus Operator CRD) to be present in the cluster.

## No Data Prevention

All counters are pre-initialized with zero values at startup to ensure Prometheus time series exist from the first scrape. This prevents "No data" in Grafana dashboards when no events have occurred yet.

## Example PromQL

```promql
# HTTP error rate (server mode)
sum(rate(trivy_collector_http_requests_total{status=~"5.."}[5m]))
/ sum(rate(trivy_collector_http_requests_total[5m]))

# Report send failure rate (collector mode)
sum(rate(trivy_collector_reports_sent_total{result="error"}[5m]))
/ sum(rate(trivy_collector_reports_sent_total[5m]))

# Server connectivity (collector mode)
trivy_collector_server_up == 0

# Database growth rate (server mode)
deriv(trivy_collector_db_size_bytes[1h])
```
