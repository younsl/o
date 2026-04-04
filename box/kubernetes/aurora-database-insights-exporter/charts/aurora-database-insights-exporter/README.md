# aurora-database-insights-exporter

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Prometheus exporter for AWS Aurora MySQL Database Insights metrics

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/aurora-database-insights-exporter
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `aurora-database-insights-exporter`:

```console
helm install aurora-database-insights-exporter oci://ghcr.io/younsl/charts/aurora-database-insights-exporter
```

Install with custom values:

```console
helm install aurora-database-insights-exporter oci://ghcr.io/younsl/charts/aurora-database-insights-exporter -f values.yaml
```

Install a specific version:

```console
helm install aurora-database-insights-exporter oci://ghcr.io/younsl/charts/aurora-database-insights-exporter --version 0.1.0
```

### Install from local chart

Download aurora-database-insights-exporter chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/aurora-database-insights-exporter --untar --version 0.1.0
helm install aurora-database-insights-exporter ./aurora-database-insights-exporter
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade aurora-database-insights-exporter oci://ghcr.io/younsl/charts/aurora-database-insights-exporter
```

## Uninstall

```console
helm uninstall aurora-database-insights-exporter
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| replicaCount | int | `1` | Number of replicas |
| revisionHistoryLimit | int | `3` | Number of old ReplicaSets to retain |
| podAnnotations | object | `{}` | Additional pod annotations |
| image.repository | string | `"ghcr.io/younsl/aurora-database-insights-exporter"` | Container image repository |
| image.tag | string | `""` | Image tag (defaults to chart appVersion) |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| serviceAccount.create | bool | `true` | Create a ServiceAccount |
| serviceAccount.name | string | `""` | ServiceAccount name (defaults to fullname template) |
| serviceAccount.annotations | object | `{}` | Annotations for the ServiceAccount (e.g., IRSA role ARN) |
| serviceAccount.automountServiceAccountToken | bool | `true` | Automount API credentials for the ServiceAccount |
| service.type | string | `"ClusterIP"` | Service type |
| service.port | int | `9090` | Service port |
| service.trafficDistribution | string | `""` | Traffic distribution policy |
| serviceMonitor.enabled | bool | `true` | Enable ServiceMonitor for Prometheus Operator |
| serviceMonitor.interval | string | `"60s"` | Scrape interval |
| serviceMonitor.scrapeTimeout | string | `"30s"` | Scrape timeout |
| serviceMonitor.labels | object | `{}` | Additional labels for ServiceMonitor |
| serviceMonitor.metricRelabelings | list | `[]` | Metric relabeling rules applied after scrape |
| prometheusRules.enabled | bool | `false` | Enable PrometheusRule for Prometheus Operator |
| prometheusRules.namespace | string | `""` | Namespace override for PrometheusRule |
| prometheusRules.labels | object | `{}` | Additional labels for PrometheusRule |
| prometheusRules.rules | list | See `values.yaml` | Alerting rules |
| config | object | `{"aws":{"region":"ap-northeast-2"},"collection":{"intervalSeconds":60,"topHostLimit":20,"topSqlLimit":10},"discovery":{"exportedTags":[],"intervalSeconds":300}}` | adie config (mounted as ConfigMap) |
| config.aws.region | string | `"ap-northeast-2"` | AWS region |
| config.discovery.intervalSeconds | int | `300` | Discovery interval in seconds |
| config.discovery.exportedTags | list | `[]` | AWS tags to export as Prometheus labels (YACE-style exportedTags) |
| config.collection.intervalSeconds | int | `60` | Collection interval in seconds |
| config.collection.topSqlLimit | int | `10` | Top SQL limit per instance |
| config.collection.topHostLimit | int | `20` | Top host limit per instance |
| resizePolicy | list | See `values.yaml` | Container resize policy for in-place resource updates (requires InPlacePodVerticalScaling feature gate) |
| resources.requests.cpu | string | `"30m"` | CPU request |
| resources.requests.memory | string | `"64Mi"` | Memory request |
| resources.limits.memory | string | `"128Mi"` | Memory limit |
| priorityClassName | string | `""` | Priority class name for the pod |
| podSecurityContext | object | See `values.yaml` | Pod-level security context |
| securityContext | object | See `values.yaml` | Container-level security context |
| pdb.enabled | bool | `false` | Enable PodDisruptionBudget |
| pdb.maxUnavailable | int | `1` | Maximum number of pods that can be unavailable during disruption |
| pdb.unhealthyPodEvictionPolicy | string | `"IfReady"` | Unhealthy pod eviction policy (IfReady or AlwaysAllow) |
| nodeSelector | object | `{}` | Node selector |
| tolerations | list | `[]` | Tolerations |
| affinity | object | `{}` | Affinity rules |
| topologySpreadConstraints | list | `[]` | Topology spread constraints |
| extraObjects | list | `[]` | Extra Kubernetes objects to deploy with tpl support |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/aurora-database-insights-exporter>

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| younsl | <cysl@kakao.com> | <https://github.com/younsl> |

## License

This chart is licensed under the Apache License 2.0. See [LICENSE](https://github.com/younsl/o/blob/main/LICENSE) for details.

## Contributing

This repository does not accept external contributions. Pull requests and issues are disabled.

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
