# aurora-database-insights-exporter

[![Rust](https://img.shields.io/badge/rust-1.94-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

Prometheus exporter for AWS Aurora MySQL [Database Insights](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_PerfInsights.html) (Performance Insights) metrics. Binary name: `adie`.

## Overview

Collects DB Load metrics from the AWS Performance Insights API and exposes them as Prometheus metrics. Designed for Aurora MySQL with YACE-style auto-discovery.

```
Aurora MySQL → PI API → adie → /metrics → Prometheus → Grafana
```

## Features

- **Auto-discovery**: Discovers Aurora MySQL instances via `rds:DescribeDBInstances`
- **DB Load breakdown**: Wait events, Top SQL, per-user, per-host
- **Exported tags**: AWS tags as Prometheus labels (YACE-style `exported_tags`)
- **Background collection**: Cached metrics, no API calls during scrape
- **Cycle reset**: Dynamic labels reset every collection cycle to prevent cardinality explosion
- **K8s native**: Helm chart with ServiceMonitor, IRSA/EKS Pod Identity support

## Metrics

| Metric | Description | Dynamic Labels |
|--------|-------------|----------------|
| `aurora_dbinsights_db_load` | DB Load (AAS) | — |
| `aurora_dbinsights_db_load_cpu` | CPU-attributed DB Load | — |
| `aurora_dbinsights_db_load_non_cpu` | Non-CPU DB Load | — |
| `aurora_dbinsights_db_load_by_wait_event` | DB Load by wait event | `wait_event`, `wait_event_type` |
| `aurora_dbinsights_db_load_by_sql` | DB Load by top SQL | `sql_id` |
| `aurora_dbinsights_db_load_by_user` | DB Load by database user | `db_user` |
| `aurora_dbinsights_db_load_by_host` | DB Load by client host | `client_host` |
| `aurora_dbinsights_sql_info` | SQL text info (value=1) | `sql_id`, `sql_text`, `sql_text_truncated` |
| `aurora_dbinsights_vcpu` | vCPU count | — |
| `aurora_dbinsights_up` | Collection status (1/0) | — |
| `aurora_dbinsights_scrape_duration_seconds` | Collection duration | — |
| `aurora_dbinsights_discovery_instances_total` | Discovered instance count | — |
| `aurora_dbinsights_collection_errors_total` | PI API error counter | `instance` |
| `aurora_dbinsights_discovery_duration_seconds` | Discovery duration | — |

Common labels on all instance metrics: `instance`, `resource_id`, `engine`, `region`, `cluster` + exported tag labels (`tag_*`).

## Getting Started

### Configuration

```yaml
server:
  listen_address: "0.0.0.0:9090"

aws:
  region: "ap-northeast-2"

discovery:
  interval_seconds: 300
  exported_tags:
    - Team
    - Environment
  include:
    identifier: ["^prod-"]
  exclude:
    identifier: ["-test$"]

collection:
  interval_seconds: 60
  top_sql_limit: 10
  top_host_limit: 20
```

### Run locally

```bash
adie --config config.example.yaml --log-format text --log-level debug
```

### IAM Permissions

```json
{
  "Action": [
    "rds:DescribeDBInstances",
    "pi:GetResourceMetrics",
    "pi:DescribeDimensionKeys",
    "pi:GetDimensionKeyDetails",
    "pi:ListAvailableResourceMetrics"
  ]
}
```

See [`iam-policy.json`](iam-policy.json) for full policy document.

## Helm

```bash
helm install adie charts/aurora-database-insights-exporter \
  --set config.aws.region=ap-northeast-2 \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789012:role/adie
```

## Development

```bash
make build     # Debug build
make test      # Run tests
make lint      # Clippy
make coverage  # llvm-cov report
make release   # Release build
```

## Related

- [awslabs/prometheus-cloudwatch-database-insights-exporter](https://github.com/awslabs/prometheus-cloudwatch-database-insights-exporter) — AWS official exporter (Go, all PI metrics)
- [qonto/prometheus-rds-exporter](https://github.com/qonto/prometheus-rds-exporter) — RDS CloudWatch metrics exporter
