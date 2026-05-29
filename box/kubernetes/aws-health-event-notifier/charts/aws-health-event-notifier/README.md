# aws-health-event-notifier

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Receives AWS Health events and posts them to Slack

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/aws-health-event-notifier
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `aws-health-event-notifier`:

```console
helm install aws-health-event-notifier oci://ghcr.io/younsl/charts/aws-health-event-notifier
```

Install with custom values:

```console
helm install aws-health-event-notifier oci://ghcr.io/younsl/charts/aws-health-event-notifier -f values.yaml
```

Install a specific version:

```console
helm install aws-health-event-notifier oci://ghcr.io/younsl/charts/aws-health-event-notifier --version 0.1.0
```

### Install from local chart

Download aws-health-event-notifier chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/aws-health-event-notifier --untar --version 0.1.0
helm install aws-health-event-notifier ./aws-health-event-notifier
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade aws-health-event-notifier oci://ghcr.io/younsl/charts/aws-health-event-notifier
```

## Uninstall

```console
helm uninstall aws-health-event-notifier
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| replicaCount | int | `1` | Number of replicas to run. |
| revisionHistoryLimit | int | `10` | Number of old ReplicaSets to retain for rollback. |
| image.registry | string | `"ghcr.io"` | Container image registry host. Empty = no prefix (use local Docker daemon / OCI default). Examples: "ghcr.io", "docker.io", "123456789012.dkr.ecr.us-east-1.amazonaws.com". |
| image.repository | string | `"younsl/aws-health-event-notifier"` | Image repository path (without the registry prefix). |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| image.tag | string | `""` | Image tag. Defaults to `.Chart.AppVersion` if empty. |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries. |
| nameOverride | string | `""` | Override the resource name (truncated to 63 chars). |
| fullnameOverride | string | `""` | Override the fullname template result (truncated to 63 chars). |
| serviceAccount.create | bool | `true` | Whether to create a ServiceAccount. |
| serviceAccount.name | string | `""` | ServiceAccount name. Defaults to the fullname template if empty. |
| serviceAccount.annotations | object | `{}` | Annotations to add to the ServiceAccount (e.g., IRSA role ARN). |
| serviceAccount.automountServiceAccountToken | bool | `true` | Automount API credentials for the ServiceAccount. |
| resources | object | `{"limits":{"memory":"80Mi"},"requests":{"cpu":"20m","memory":"30Mi"}}` | Container resource requests and limits. |
| resizePolicy | list | `[{"resourceName":"cpu","restartPolicy":"NotRequired"},{"resourceName":"memory","restartPolicy":"RestartContainer"}]` | In-place resize policies for container resources. |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true,"runAsNonRoot":true,"runAsUser":65532}` | Container security context (locked-down by default). |
| podSecurityContext | object | `{"seccompProfile":{"type":"RuntimeDefault"}}` | Pod security context. |
| service.type | string | `"ClusterIP"` | Service type. Only exposes the admin (health + metrics) port. |
| service.adminPort | int | `8081` | Admin port exposed by the Service. |
| service.annotations | object | `{}` | Annotations to add to the Service. |
| service.trafficDistribution | string | `""` | Traffic routing preference (e.g., `PreferClose` for topology-aware routing). Empty omits the field. |
| poller.intervalSeconds | int | `60` | Poll interval in seconds. |
| poller.initialLookbackSeconds | int | `3600` | On cold start, fetch events updated within this many seconds. |
| poller.coldStartSuppress | bool | `true` | On cold start, populate dedup without sending. Prevents replay floods on restart. |
| poller.eventLocale | string | `"en"` | Locale passed to `DescribeEventDetails` (AWS accepts en, ja, zh — not en_US). |
| poller.reminderOffsetsHours | list | `[24]` | Reminder offsets in hours before `startTime`. A reminder fires once per `(eventArn, offset)` when `startTime - now <= offset`. Reminders only fire for events that have an `endTime` set (i.e., scheduled-window events). Empty list disables reminders. |
| rbac.create | bool | `true` | Create a Role + RoleBinding granting create/patch on Events. Disable to manage the RBAC yourself (the SA still needs those verbs). |
| podDisruptionBudget.enabled | bool | `true` | Whether to create a PodDisruptionBudget. |
| podDisruptionBudget.maxUnavailable | int | `1` | Maximum number of pods that can be unavailable during disruption. |
| podDisruptionBudget.unhealthyPodEvictionPolicy | string | `"IfHealthyBudget"` | Eviction policy for unhealthy pods. One of `IfHealthyBudget` or `AlwaysAllow`. |
| serviceMonitor.enabled | bool | `false` | Whether to create a ServiceMonitor for Prometheus Operator scraping. |
| serviceMonitor.interval | string | `"30s"` | Scrape interval. |
| serviceMonitor.scrapeTimeout | string | `""` | Scrape timeout. Empty uses Prometheus global default. |
| serviceMonitor.additionalLabels | object | `{}` | Additional labels to add to the ServiceMonitor resource. |
| slack.webhookUrl | string | `""` | Slack Incoming Webhook URL. Required when slack.existingSecret is empty. |
| slack.existingSecret | string | `""` | Name of an existing Secret with the webhook URL. Takes precedence over webhookUrl when set. |
| slack.existingSecretKey | string | `"webhook-url"` | Key inside the existing Secret that holds the URL. |
| slack.channel | string | `""` | Default Slack channel override (optional; webhook URL channel wins when empty). |
| slack.username | string | `"AWS Health Event Notifier"` | Username shown in Slack messages. |
| slack.iconEmoji | string | `":cloud:"` | Emoji used as bot avatar. |
| slack.timeoutSeconds | int | `10` | Slack request timeout in seconds. |
| logging.level | string | `"info"` | Log level filter (e.g., info, debug, aws_health_event_notifier=debug). |
| logging.json | bool | `true` | Emit logs as JSON. |
| filter.allowCategories | list | `[]` | Allowed `eventTypeCategory` values. Empty = allow all. One of: issue, scheduledChange, accountNotification, investigation, securityNotification. |
| filter.denyCategories | list | `[]` | Denied `eventTypeCategory` values (wins over allow). |
| filter.allowServices | list | `[]` | Allowed AWS service codes (case-insensitive). Empty = allow all. |
| filter.denyServices | list | `[]` | Denied AWS service codes (wins over allow). |
| extraEnv | object | `{}` | Extra environment variables to inject into the pod. |
| nodeSelector | object | `{}` | Node selector for pod scheduling. |
| tolerations | list | `[]` | Tolerations for pod scheduling. |
| affinity | object | `{}` | Affinity rules for pod scheduling. |
| topologySpreadConstraints | list | `[]` | Topology spread constraints. |
| extraObjects | list | `[]` | Extra Kubernetes manifests to apply with the release. |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/aws-health-event-notifier>

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
