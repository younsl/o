# kubernetes

<img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/kubernetes/kubernetes-plain.svg" width="40" height="40"/>

This directory contains [Kubernetes](https://kubernetes.io/) related resources including CLI tools, YAML manifests, helm charts, and controller source code.

## Core Principles

Built on the [Unix philosophy](https://en.wikipedia.org/wiki/Unix_philosophy): "Do One Thing and Do It Well". Each Kubernetes addon solves one specific operational problem, and internally, the application architecture follows the same principle with small, focused modules.

All applications are built with **[Rust](https://github.com/rust-lang/rust) 1.93+**. Rust provides key operational benefits: minimal container sizes, low memory footprint, single static binaries with no runtime dependencies, memory safety preventing null pointer and buffer overflow crashes, and compile-time guarantees ensuring system stability in production.

## List of Contents

Kubernetes tools, policy resources, and architecture documentation organized by category.

| Category | Name | Language | Status | Description |
|----------|------|----------|--------|-------------|
| Kubernetes Addon | [gss](./gss/) | [Rust](./gss/Cargo.toml) | Active | GHES scheduled workflow scanner running as Kubernetes [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) with Slack Canvas integration (Helm chart available) |
| Kubernetes Addon | [elasticache-backup](./elasticache-backup/) | [Rust](./elasticache-backup/Cargo.toml) | Active | ElastiCache snapshot backup to S3 automation running as Kubernetes [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) (Helm chart available) |
| Kubernetes Addon | [redis-console](./redis-console/) | [Rust](./redis-console/Cargo.toml) | Active | Centralized terminal running as Kubernetes [Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/) for managing multiple Redis and AWS ElastiCache clusters (Helm chart available) |
| Kubernetes Addon | [trivy-collector](./trivy-collector/) | [Rust](./trivy-collector/Cargo.toml) | Active | Multi-cluster [Trivy Operator](https://github.com/aquasecurity/trivy-operator) report collector and viewer running as Kubernetes [Deployment](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/) with Web UI (Helm chart available) |
| Kubernetes Operator | [kuo](./kubernetes-upgrade-operator/) | [Rust](./kubernetes-upgrade-operator/Cargo.toml) | Active | Kubernetes Upgrade Operator that watches EKSUpgrade CRD and performs declarative EKS cluster upgrades with sequential control plane upgrades, add-on updates, and managed node group rolling updates |
| Helm Chart | [grafana-dashboards](./grafana-dashboards/) | [Helm](./grafana-dashboards/Chart.yaml) | Active | Helm chart that deploys Grafana dashboards as Kubernetes [ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/) for sidecar provisioning |
| Tools | [karc](./karc/) | [Rust](./karc/Cargo.toml) | Active | Karpenter NodePool consolidation manager CLI with disruption schedule timetable and pause/resume support |

## Related

Standalone Helm charts are also hosted in [younsl/charts](https://github.com/younsl/charts), a separate OCI-based Helm chart repository independent from this monorepo.

## License

All tools and resources in this directory are licensed under the repository's main [MIT License](../../LICENSE).
