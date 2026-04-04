# aurora-database-insights-exporter

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-aurora--database--insights--exporter-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/aurora-database-insights-exporter)
[![Helm Chart](https://img.shields.io/badge/ghcr.io-charts%2Faurora--database--insights--exporter-black?style=flat-square&logo=helm&logoColor=white)](https://github.com/younsl/o/pkgs/container/charts%2Faurora-database-insights-exporter)
[![Rust](https://img.shields.io/badge/rust-1.94.1-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
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
- **Leader election**: Kubernetes Lease-based, seamless by default
- **K8s native**: Helm chart with ServiceMonitor, IRSA/EKS Pod Identity support

## Documentation

- [Configuration](docs/configuration.md) — Config file, CLI flags, IAM permissions
- [Metrics](docs/metrics.md) — Metric list, label structure, cardinality estimate
- [Helm](docs/helm.md) — Chart installation and OCI registry usage
- [Comparison](docs/comparison.md) — Differences from mysqld_exporter

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
