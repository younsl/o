# Kubernetes

[Kubernetes](https://kubernetes.io/) addons, operators, and CLI tools built with [Rust](https://github.com/rust-lang/rust) 1.94+. Each component follows the [Unix philosophy](https://en.wikipedia.org/wiki/Unix_philosophy): do one thing and do it well.

## Kubernetes Addons

- [aurora-database-insights-exporter](./aurora-database-insights-exporter/) — Prometheus exporter for Aurora MySQL Database Insights
- [elasticache-backup](./elasticache-backup/) — ElastiCache snapshot backup to S3 (CronJob)
- [gss](./gss/) — GHES scheduled workflow scanner with Slack Canvas integration (CronJob)
- [karc](./karc/) — Karpenter NodePool consolidation manager CLI
- [kuo](./kubernetes-upgrade-operator/) — Declarative EKS cluster upgrade operator
- [redis-console](./redis-console/) — Interactive multi-cluster Redis management CLI
- [trivy-collector](./trivy-collector/) — Multi-cluster Trivy report collector with Web UI
- [charts](./charts/) — Standalone Helm charts distributed via OCI artifacts on GHCR

## License

[MIT License](../../LICENSE)
