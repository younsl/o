# aws-vpn-maintenance-handler

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Owns AWS Site-to-Site VPN tunnel endpoint maintenance, applying it in a maintenance window after Slack approval instead of letting AWS pick the time

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/aws-vpn-maintenance-handler
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `aws-vpn-maintenance-handler`:

```console
helm install aws-vpn-maintenance-handler oci://ghcr.io/younsl/charts/aws-vpn-maintenance-handler
```

Install with custom values:

```console
helm install aws-vpn-maintenance-handler oci://ghcr.io/younsl/charts/aws-vpn-maintenance-handler -f values.yaml
```

Install a specific version:

```console
helm install aws-vpn-maintenance-handler oci://ghcr.io/younsl/charts/aws-vpn-maintenance-handler --version 0.1.0
```

### Install from local chart

Download aws-vpn-maintenance-handler chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/aws-vpn-maintenance-handler --untar --version 0.1.0
helm install aws-vpn-maintenance-handler ./aws-vpn-maintenance-handler
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade aws-vpn-maintenance-handler oci://ghcr.io/younsl/charts/aws-vpn-maintenance-handler
```

## Uninstall

```console
helm uninstall aws-vpn-maintenance-handler
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| nameOverride | string | `""` | Override the chart name |
| fullnameOverride | string | `""` | Override the fully qualified release name |
| image.registry | string | `"ghcr.io"` | Container image registry host |
| image.repository | string | `"younsl/aws-vpn-maintenance-handler"` | Container image repository path without registry prefix |
| image.tag | string | `""` | Image tag; defaults to the chart appVersion |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| replicaCount | int | `1` | Number of replicas. Above 1 enables leader election so only one replica reconciles. |
| revisionHistoryLimit | int | `3` | Number of old ReplicaSets to retain for rollback |
| stateConfigMapName | string | `""` | ConfigMap holding in-flight and cooldown state; defaults to `<fullname>-state`. No PersistentVolume needed. |
| strategy | object | `{"type":"Recreate"}` | Deployment update strategy |
| config.region | string | `""` | AWS region (required) |
| config.reconcileInterval | string | `"5m"` | Poll interval for telemetry and pending maintenance |
| config.dryRun | bool | `true` | Validate ReplaceVpnTunnel with the AWS DryRun flag instead of replacing |
| config.targets | object | `{"excludeConnectionIDs":[],"tagFilters":[{"key":"aws-vpn-maintenance-handler.networking.k8s.io/managed","value":"true"}]}` | Which VPN connections this controller owns |
| config.targets.tagFilters | list | `[{"key":"aws-vpn-maintenance-handler.networking.k8s.io/managed","value":"true"}]` | Tags that must all match. Required, so connections are opted in explicitly. |
| config.targets.excludeConnectionIDs | list | `[]` | VPN connection IDs to skip even when tags match |
| config.maintenanceWindow | object | `{"cronSchedule":"0 2 * * 2,3,4","duration":"3h","timezone":"UTC"}` | Window during which a replacement may start. Each cron firing opens it for `duration`. This is the only schedule to set: within the window, the moment is chosen by measuring traffic rather than by more configuration. |
| config.maintenanceWindow.timezone | string | `"UTC"` | IANA timezone the schedule is evaluated in |
| config.maintenanceWindow.cronSchedule | string | `"0 2 * * 2,3,4"` | Standard 5-field cron expression: minute hour dom month dow. Descriptors like `@daily` also work. |
| config.maintenanceWindow.duration | string | `"3h"` | How long the window stays open after each firing |
| config.safety | object | `{"escalateBefore":"168h","peerMinStableFor":null}` | Preflight and verification thresholds. Keys left out keep their built-in defaults. |
| config.safety.escalateBefore | string | `"168h"` | Raise notification severity, and let the traffic gate settle for a median moment instead of the quietest one, once the AWS auto-apply deadline is nearer than this |
| config.safety.peerMinStableFor | string | `nil` | How long a tunnel must have held UP before its sibling may be replaced. Unset means 5m. |
| config.approval | object | `{"progressHeartbeat":"5m","slackUserIDs":[],"timeout":"1h"}` | Human approval gate |
| config.approval.slackUserIDs | list | `[]` | Slack user IDs (Uxxxxxxxx) that receive the DM and may approve. Required. |
| config.approval.timeout | string | `"1h"` | Expire an unanswered request after this long |
| config.approval.progressHeartbeat | string | `"5m"` | How often to post a "still waiting" thread reply while verifying |
| config.trafficGate | object | `{"enabled":false,"endpoint":"","headers":{},"onError":"block","quietPercentile":20}` | Query Prometheus or Mimir so a replacement only runs at a quiet moment of the window. Which exporter publishes VPN traffic, what the connection normally carries, and when the window is calmest are all measured, so the only threshold is a percentile. |
| config.trafficGate.enabled | bool | `false` | Enable the traffic gate |
| config.trafficGate.endpoint | string | `""` | Query API base URL, the part before /api/v1/query. For Mimir usually the `.../prometheus` path. |
| config.trafficGate.quietPercentile | float | `20` | Share of what this connection carries during its own maintenance window that counts as quiet. 20 acts once traffic falls into the quietest fifth of the last four weeks of that window; lower waits for a calmer moment, higher acts sooner. Needs no knowledge of the connection: a busy VPN and an idle one both have a quietest fifth. |
| config.trafficGate.onError | string | `"block"` | What an unreadable metric source means: `block` (no evidence of quiet) or `allow` |
| config.trafficGate.headers | object | `{}` | Headers sent with every query, e.g. `X-Scope-OrgID` for a Mimir tenant |
| config.logLevel | string | `"info"` | Log level (debug, info, warn, error) |
| config.logFormat | string | `"json"` | Log format (json or text) |
| slack | object | `{"appToken":"","botToken":"","existingSecret":""}` | Slack credentials. Approvals arrive over Socket Mode, so no Ingress is needed. |
| slack.existingSecret | string | `""` | Existing Secret with `botToken` and `appToken` keys; skips Secret creation |
| slack.botToken | string | `""` | Slack bot token (xoxb-) with chat:write and im:write, plus users:read to log approver names |
| slack.appToken | string | `""` | Slack app-level token (xapp-) with connections:write |
| healthPort | int | `8081` | Port serving /healthz and /readyz |
| metricsPort | int | `9090` | Port serving /metrics |
| serviceAccount.create | bool | `true` | Create a ServiceAccount |
| serviceAccount.name | string | `""` | ServiceAccount name; defaults to the fullname |
| serviceAccount.annotations | object | `{}` | ServiceAccount annotations; put the IRSA role ARN here |
| rbac.create | bool | `true` | Create the Role and RoleBinding for the state ConfigMap, Lease, and Events |
| service.type | string | `"ClusterIP"` | Service type |
| service.annotations | object | `{}` | Service annotations |
| service.trafficDistribution | string | `""` | Traffic distribution, e.g. `PreferClose` (Kubernetes 1.31+); empty omits the field |
| serviceMonitor.enabled | bool | `false` | Create a Prometheus Operator ServiceMonitor |
| serviceMonitor.namespace | string | `""` | ServiceMonitor namespace; defaults to the release namespace |
| serviceMonitor.interval | string | `"60s"` | Scrape interval |
| serviceMonitor.scrapeTimeout | string | `"10s"` | Scrape timeout |
| serviceMonitor.labels | object | `{}` | Extra ServiceMonitor labels, e.g. the Prometheus release selector |
| podDisruptionBudget.enabled | bool | `false` | Create a PodDisruptionBudget |
| podDisruptionBudget.minAvailable | string|int | `1` | Minimum available Pods |
| podDisruptionBudget.unhealthyPodEvictionPolicy | string | `""` | Unhealthy Pod eviction policy, `IfHealthyBudget` or `AlwaysAllow` (Kubernetes 1.27+); empty omits the field |
| resources | object | `{"limits":{"memory":"128Mi"},"requests":{"cpu":"10m","memory":"64Mi"}}` | Resource requests and limits. No CPU limit, so verification is never throttled. |
| resizePolicy | list | `[{"resourceName":"cpu","restartPolicy":"NotRequired"},{"resourceName":"memory","restartPolicy":"RestartContainer"}]` | Container resize policy for in-place vertical scaling |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true,"runAsGroup":65532,"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}}` | Container security context |
| podSecurityContext | object | `{"fsGroup":65532}` | Pod security context |
| podAnnotations | object | `{}` | Pod annotations |
| podLabels | object | `{}` | Pod labels |
| priorityClassName | string | `""` | PriorityClass for the Pod, e.g. `system-cluster-critical`. Keeps the controller from being evicted mid-replacement. |
| nodeSelector | object | `{}` | Node selector |
| tolerations | list | `[]` | Tolerations |
| affinity | object | `{}` | Affinity rules |
| topologySpreadConstraints | list | `[]` | Topology spread constraints |
| dnsPolicy | string | `""` | DNS policy for the Pod |
| dnsConfig | object | `{}` | DNS configuration for the Pod |
| terminationGracePeriodSeconds | int | `60` | Termination grace period, long enough to post a closing Slack update |
| extraEnv | list | `[]` | Extra environment variables |
| extraObjects | list | `[]` | Extra manifests rendered through `tpl` |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/aws-vpn-maintenance-handler>

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| younsl | <cysl@kakao.com> | <https://github.com/younsl> |

## License

This chart is licensed under the Apache License 2.0. See the [LICENSE](https://github.com/younsl/o/blob/main/LICENSE) file for details.

## Contributing

This repository does not accept external contributions. Pull requests and issues are disabled.

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
