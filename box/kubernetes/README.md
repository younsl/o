# Kubernetes

Addons and [operators](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/) for Kubernetes operations automation and [observability](https://opentelemetry.io/docs/concepts/observability-primer/), built with [Rust](https://www.rust-lang.org/) for system safety and minimal resource footprint.

## Kubernetes Addons

- [aurora-database-insights-exporter](./aurora-database-insights-exporter/) — Prometheus exporter for Aurora MySQL Database Insights
- [backstage](./backstage/) — Internal Developer Portal with 7 custom plugins (Node.js)
- [charts](./charts/) — Standalone Helm charts distributed via OCI artifacts on GHCR
- [elasticache-backup](./elasticache-backup/) — ElastiCache snapshot backup to S3 (CronJob)
- [filesystem-cleaner](./filesystem-cleaner/) — Kubernetes filesystem cleanup sidecar/init container
- [gss](./gss/) — GHES scheduled workflow scanner with Slack Canvas integration (CronJob)
- [karc](./karc/) — Karpenter NodePool consolidation manager CLI
- [kuo](./kubernetes-upgrade-operator/) — Declarative EKS cluster upgrade operator
- [logstash-with-opensearch-plugin](./logstash-with-opensearch-plugin/) — Logstash with OpenSearch output plugin for ECK (JVM)
- [redis-console](./redis-console/) — Interactive multi-cluster Redis management CLI
- [trivy-collector](./trivy-collector/) — Multi-cluster Trivy report collector with Web UI

## License

[MIT License](../../LICENSE)
