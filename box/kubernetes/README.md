# Kubernetes

[Kubernetes](https://kubernetes.io/) addons, operators, and CLI tools. Rust-based components follow the [Unix philosophy](https://en.wikipedia.org/wiki/Unix_philosophy): do one thing and do it well.

## Kubernetes Addons

### Cluster Operations Automation

- [kuo](./kubernetes-upgrade-operator/) — Declarative EKS cluster upgrade operator
- [karc](./karc/) — Karpenter NodePool consolidation manager CLI
- [redis-console](./redis-console/) — Interactive multi-cluster Redis management CLI
- [elasticache-backup](./elasticache-backup/) — ElastiCache snapshot backup to S3 (CronJob)
- [gss](./gss/) — GHES scheduled workflow scanner with Slack Canvas integration (CronJob)
- [filesystem-cleaner](./filesystem-cleaner/) — Kubernetes filesystem cleanup sidecar/init container
- [charts](./charts/) — Standalone Helm charts distributed via OCI artifacts on GHCR

### Observability

- [aurora-database-insights-exporter](./aurora-database-insights-exporter/) — Prometheus exporter for Aurora MySQL Database Insights
- [trivy-collector](./trivy-collector/) — Multi-cluster Trivy report collector with Web UI

### Developer Platform

- [backstage](./backstage/) — Internal Developer Portal with 7 custom plugins (Node.js)
- [logstash-with-opensearch-plugin](./logstash-with-opensearch-plugin/) — Logstash with OpenSearch output plugin for ECK (JVM)

## License

[MIT License](../../LICENSE)
