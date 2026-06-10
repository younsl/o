# ec2-metadata-exporter

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Prometheus exporter that publishes every EC2 instance's private IP and Name tag via the DescribeInstances API

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/ec2-metadata-exporter
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `ec2-metadata-exporter`:

```console
helm install ec2-metadata-exporter oci://ghcr.io/younsl/charts/ec2-metadata-exporter
```

Install with custom values:

```console
helm install ec2-metadata-exporter oci://ghcr.io/younsl/charts/ec2-metadata-exporter -f values.yaml
```

Install a specific version:

```console
helm install ec2-metadata-exporter oci://ghcr.io/younsl/charts/ec2-metadata-exporter --version 0.1.0
```

### Install from local chart

Download ec2-metadata-exporter chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/ec2-metadata-exporter --untar --version 0.1.0
helm install ec2-metadata-exporter ./ec2-metadata-exporter
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade ec2-metadata-exporter oci://ghcr.io/younsl/charts/ec2-metadata-exporter
```

## Uninstall

```console
helm uninstall ec2-metadata-exporter
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| image.registry | string | `"ghcr.io/younsl"` | Container image registry |
| image.repository | string | `"ec2-metadata-exporter"` | Container image repository |
| image.tag | string | `""` | Image tag; defaults to the chart appVersion when empty |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| nameOverride | string | `""` | Override the chart name |
| fullnameOverride | string | `""` | Override the fully qualified release name |
| replicaCount | int | `1` | Number of replicas. Keep at 1; each replica polls the EC2 API independently and exposes identical series. |
| revisionHistoryLimit | int | `3` | Number of old ReplicaSets to retain for rollback |
| strategy | object | `{"rollingUpdate":{"maxSurge":"25%","maxUnavailable":"25%"},"type":"RollingUpdate"}` | Deployment update strategy |
| strategy.rollingUpdate.maxSurge | string|int | `"25%"` | Max Pods created above desired count during an update |
| strategy.rollingUpdate.maxUnavailable | string|int | `"25%"` | Max Pods unavailable during an update |
| config.region | string | `""` | AWS region to scan; empty falls back to the SDK default chain (IRSA, instance profile) |
| config.scrapeInterval | string | `"60s"` | EC2 API polling interval as a Go duration; supports h, m, s and combinations (e.g. 30s, 5m, 1h) |
| config.logLevel | string | `"info"` | Log level: debug, info, warn, error |
| config.logFormat | string | `"json"` | Log format: json or text |
| extraEnv | list | `[]` | Additional environment variables for the container (raw EnvVar entries) |
| extraEnvFrom | list | `[]` | Additional envFrom sources for the container (configMapRef/secretRef entries) |
| ports.health | int | `8080` | Port serving /healthz and /readyz |
| ports.metrics | int | `8081` | Port serving Prometheus /metrics |
| serviceAccount.create | bool | `true` | Create a ServiceAccount |
| serviceAccount.name | string | `""` | ServiceAccount name; defaults to the chart fullname when empty |
| serviceAccount.annotations | object | `{}` | ServiceAccount annotations, e.g. the IRSA role ARN |
| serviceAccount.automountServiceAccountToken | bool | `true` | Automount the ServiceAccount token |
| serviceAccount.imagePullSecrets | list | `[]` | Image pull secrets attached to the ServiceAccount, injected into Pods that use it |
| service.enabled | bool | `true` | Create a Service exposing health and metrics ports |
| service.type | string | `"ClusterIP"` | Service type |
| service.trafficDistribution | string | `""` | Traffic distribution preference, e.g. PreferClose (requires Kubernetes 1.31+); empty omits the field |
| serviceMonitor.enabled | bool | `false` | Create a Prometheus Operator ServiceMonitor |
| serviceMonitor.interval | string | `"30s"` | Scrape interval |
| serviceMonitor.scrapeTimeout | string | `"10s"` | Scrape timeout |
| serviceMonitor.labels | object | `{}` | Extra labels for the ServiceMonitor |
| serviceMonitor.honorLabels | bool | `false` | When true, honorLabels preserves the metric's labels when they collide with the target's labels. |
| serviceMonitor.relabelings | list | `[]` | Prometheus [RelabelConfigs] to apply to samples before scraping |
| serviceMonitor.metricRelabelings | list | `[]` | Prometheus [MetricRelabelConfigs] to apply to samples before ingestion |
| resources | object | `{"limits":{"memory":"128Mi"},"requests":{"cpu":"25m","memory":"64Mi"}}` | Pod resource requests and limits |
| resizePolicy | list | `[{"resourceName":"cpu","restartPolicy":"NotRequired"},{"resourceName":"memory","restartPolicy":"RestartContainer"}]` | Container resize policy for in-place vertical scaling (requires Kubernetes 1.27+); empty omits the field. CPU resizes in place without a restart; memory resizes restart the container. |
| podAnnotations | object | `{}` | Extra annotations for the pod |
| podLabels | object | `{}` | Extra labels for the pod |
| podSecurityContext | object | `{"fsGroup":65532,"runAsGroup":65532,"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}}` | Pod-level security context |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true}` | Container-level security context |
| nodeSelector | object | `{}` | Node selector for pod scheduling |
| tolerations | list | `[]` | Tolerations for pod scheduling |
| affinity | object | `{}` | Affinity rules for pod scheduling |
| dnsPolicy | string | `""` | Pod DNS policy, e.g. ClusterFirst or None; empty omits the field |
| dnsConfig | object | `{}` | Pod DNS config (used with dnsPolicy None); empty omits the field |
| extraObjects | list | `[]` | Additional Kubernetes manifests rendered verbatim |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/ec2-metadata-exporter>

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
