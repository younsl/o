# kuo

![Version: 0.2.0](https://img.shields.io/badge/Version-0.2.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.2.0](https://img.shields.io/badge/AppVersion-0.2.0-informational?style=flat-square)

Kubernetes Upgrade Operator for EKS clusters

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/kuo
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `kuo`:

```console
helm install kuo oci://ghcr.io/younsl/charts/kuo
```

Install with custom values:

```console
helm install kuo oci://ghcr.io/younsl/charts/kuo -f values.yaml
```

Install a specific version:

```console
helm install kuo oci://ghcr.io/younsl/charts/kuo --version 0.2.0
```

### Install from local chart

Download kuo chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/kuo --untar --version 0.2.0
helm install kuo ./kuo
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade kuo oci://ghcr.io/younsl/charts/kuo
```

## Uninstall

```console
helm uninstall kuo
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| crds.install | bool | `true` | Whether to install CRDs. Set to false if CRDs are managed externally. |
| crds.annotations | object | `{}` | Annotations to add to the CRD resources. |
| replicaCount | int | `1` | Number of operator replicas to run. |
| image.repository | string | `"ghcr.io/younsl/kuo"` | Container image repository. |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| image.tag | string | `""` | Image tag. Defaults to `.Chart.AppVersion` if empty. |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries. |
| serviceAccount.create | bool | `true` | Whether to create a ServiceAccount. |
| serviceAccount.annotations | object | `{}` | Annotations to add to the ServiceAccount. |
| serviceAccount.name | string | `""` | ServiceAccount name. Defaults to the fullname template if empty. |
| resources.limits.memory | string | `"64Mi"` | Memory limit. |
| resources.requests.cpu | string | `"25m"` | CPU request. |
| resources.requests.memory | string | `"32Mi"` | Memory request. |
| resizePolicy | list | `[{"resourceName":"cpu","restartPolicy":"NotRequired"},{"resourceName":"memory","restartPolicy":"RestartContainer"}]` | In-place resize policies for container resources |
| podDisruptionBudget.enabled | bool | `true` | Whether to create a PodDisruptionBudget. |
| podDisruptionBudget.maxUnavailable | int | `1` | Maximum number of pods that can be unavailable during disruption. |
| podDisruptionBudget.unhealthyPodEvictionPolicy | string | `"IfHealthyBudget"` | Eviction policy for unhealthy pods. One of `IfHealthyBudget` or `AlwaysAllow` |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true,"runAsNonRoot":true,"runAsUser":65532}` | Container security context. |
| serviceMonitor.enabled | bool | `false` | Whether to create a ServiceMonitor for Prometheus scraping. |
| serviceMonitor.interval | string | `"30s"` | Scrape interval for the ServiceMonitor. |
| serviceMonitor.scrapeTimeout | string | `""` | Scrape timeout for the ServiceMonitor. Defaults to Prometheus global setting if empty. |
| serviceMonitor.additionalLabels | object | `{}` | Additional labels to add to the ServiceMonitor resource. |
| nodeSelector | object | `{}` | Node selector for pod scheduling. |
| tolerations | list | `[]` | Tolerations for pod scheduling. |
| affinity | object | `{}` | Affinity rules for pod scheduling. |
| slack.enabled | bool | `false` | Whether to create a Slack webhook Secret and inject the URL into the operator. |
| slack.webhookUrl | string | `""` | Slack Incoming Webhook URL. |
| eksUpgrades | list | `[]` | EKSUpgrade custom resources to create. Each entry creates an EKSUpgrade CR that the operator will reconcile. |
| extraObjects | list | `[]` | Additional Kubernetes resources to create alongside the chart. |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/kubernetes-upgrade-operator>

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| younsl | <cysl@kakao.com> | <https://github.com/younsl> |

## License

This chart is licensed under the Apache License 2.0. See [LICENSE](https://github.com/younsl/o/blob/main/LICENSE) for details.

## Contributing

Contributions are welcome! Please feel free to submit a [Pull Request](https://github.com/younsl/o/pulls).

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
