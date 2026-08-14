# external-ebs-autoresizer

![Version: 0.5.0](https://img.shields.io/badge/Version-0.5.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.5.0](https://img.shields.io/badge/AppVersion-0.5.0-informational?style=flat-square)

Auto-expands the root filesystem (ext2/3/4 or XFS) of standalone EC2 instances via EBS ModifyVolume and SSM

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/external-ebs-autoresizer
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `external-ebs-autoresizer`:

```console
helm install external-ebs-autoresizer oci://ghcr.io/younsl/charts/external-ebs-autoresizer
```

Install with custom values:

```console
helm install external-ebs-autoresizer oci://ghcr.io/younsl/charts/external-ebs-autoresizer -f values.yaml
```

Install a specific version:

```console
helm install external-ebs-autoresizer oci://ghcr.io/younsl/charts/external-ebs-autoresizer --version 0.5.0
```

### Install from local chart

Download external-ebs-autoresizer chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/external-ebs-autoresizer --untar --version 0.5.0
helm install external-ebs-autoresizer ./external-ebs-autoresizer
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade external-ebs-autoresizer oci://ghcr.io/younsl/charts/external-ebs-autoresizer
```

## Uninstall

```console
helm uninstall external-ebs-autoresizer
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| image.registry | string | `"ghcr.io"` | Container image registry host |
| image.repository | string | `"younsl/external-ebs-autoresizer"` | Container image repository path without registry prefix |
| image.tag | string | `""` | Image tag; defaults to the chart appVersion when empty |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| nameOverride | string | `""` | Override the chart name |
| fullnameOverride | string | `""` | Override the fully qualified release name |
| replicaCount | int | `1` | Number of replicas. Setting this above 1 automatically enables leader election so only one replica reconciles. |
| revisionHistoryLimit | int | `3` | Number of old ReplicaSets to retain for rollback |
| strategy | object | `{"rollingUpdate":{"maxSurge":"25%","maxUnavailable":"25%"},"type":"RollingUpdate"}` | Deployment update strategy |
| strategy.rollingUpdate.maxSurge | string|int | `"25%"` | Max Pods created above desired count during an update |
| strategy.rollingUpdate.maxUnavailable | string|int | `"25%"` | Max Pods unavailable during an update |
| config.region | string | `""` | AWS region to operate in (required) |
| config.tagFilters | string | `""` | Comma-separated Key=Value tag filters selecting target instances; empty scans every instance in the account/region |
| config.excludeEKSNodes | bool | `true` | Exclude EKS cluster nodes (managed node groups, self-managed, Karpenter) so only standalone EC2 instances are managed |
| config.reconcileInterval | string | `"5m"` | Reconcile loop interval as a Go duration; supports h, m, s and combinations (e.g. 30s, 5m, 1h, 1h30m) |
| config.reconcileConcurrency | int | `10` | Max instances reconciled in parallel per pass |
| config.defaultPolicy | object | `{"alertEnabled":true,"growAmount":"10GiB","growMode":"percent","growPercent":10,"maxVolumeSizeGiB":1000,"paused":false,"usageThresholdPercent":80}` | Default-policy volume-expansion settings applied to every instance not matched by a named policy. usageThresholdPercent and growMode are REQUIRED; the rest are optional. |
| config.defaultPolicy.usageThresholdPercent | int | `80` | REQUIRED. Root filesystem usage percent that triggers a resize |
| config.defaultPolicy.growMode | string | `"percent"` | REQUIRED. Growth mode: "percent" grows by growPercent, "absolute" grows by growAmount |
| config.defaultPolicy.paused | bool | `false` | Pause the default policy: skip (never resize) every instance not matched by a named policy |
| config.defaultPolicy.alertEnabled | bool | `true` | Alert switch for instances not matched by a named policy: false mutes their Alertmanager alerts. Named policies can override it per group via resize.alertEnabled. Only consulted when alertmanager.enabled is true |
| config.defaultPolicy.growPercent | int | `10` | EBS volume growth percent per resize (used when growMode is percent) |
| config.defaultPolicy.growAmount | string | `"10GiB"` | Absolute growth per resize with a MiB or GiB unit, e.g. 10GiB or 5120MiB (used when growMode is absolute); MiB rounds up to whole GiB |
| config.defaultPolicy.maxVolumeSizeGiB | int | `1000` | Maximum volume size in GiB; resizes that would exceed it are skipped |
| config.policies | list | `[]` | Per-instance-group resize policies. Each entry selects a group of instances via instanceSelector (tag equality and/or a Name regex) and overrides a subset of the default-policy resize settings for that group under its own resize block. When several policies match one instance the highest weight wins; ties fall back to list order. Instances matching no policy use defaultPolicy. Empty means all instances use defaultPolicy. |
| config.ssmCommandTimeout | string | `"5m"` | SSM command poll timeout as a Go duration |
| config.ssmPollInterval | string | `"1s"` | Delay between SSM command and volume modification status polls as a Go duration |
| config.volumeModifyTimeout | string | `"10m"` | ModifyVolume optimizing-wait timeout as a Go duration |
| config.dryRun | bool | `false` | Measure and decide only, never modify resources |
| config.logLevel | string | `"info"` | Log level: debug, info, warn, error |
| config.logFormat | string | `"json"` | Log format: json or text |
| config.alertmanager.enabled | bool | `false` | Enable Alertmanager alerting on resize outcomes; requires url when true |
| config.alertmanager.url | string | `""` | Alertmanager v2 base URL, e.g. http://alertmanager-operated.monitoring:9093; required when enabled |
| config.alertmanager.timeout | string | `"5s"` | Timeout for each Alertmanager POST as a Go duration |
| config.alertmanager.labels | object | `{}` | Static Key: Value labels merged into every alert for routing (e.g. cluster: prod) |
| config.alertmanager.notifyOn | string | `"success"` | Which resize outcomes to alert: all, success, or failure |
| config.alertmanager.dashboardUrl | string | `""` | Optional dashboard URL template appended to each alert's description as a Slack link; supports {instance_id}, {volume_id}, {device}, {instance_name} placeholders. Empty disables the link |
| config.grafanaAnnotation.enabled | bool | `false` | Enable Grafana annotations on resize outcomes; requires url and a token when true |
| config.grafanaAnnotation.url | string | `"http://grafana.monitoring:3000"` | Grafana base URL; required when enabled |
| config.grafanaAnnotation.timeout | string | `"5s"` | Timeout for each Grafana annotation POST as a Go duration |
| config.grafanaAnnotation.tags | list | `["event:ebs-resize"]` | Base tags merged into every annotation and subscribed to by dashboards |
| config.grafanaAnnotation.annotateOn | string | `"all"` | Which resize outcomes to annotate: all, success, or failure |
| config.grafanaAnnotation.apiToken | string | `""` | Grafana service account token; ignored when existingSecret is set. Stored in a generated Secret and injected via GRAFANA_API_TOKEN env, never written to the config file. For production prefer existingSecret. |
| config.grafanaAnnotation.existingSecret | string | `""` | Name of an existing Secret holding the Grafana token; takes precedence over apiToken |
| config.grafanaAnnotation.existingSecretKey | string | `"token"` | Key within existingSecret (or the generated Secret) holding the token |
| config.throughputRecommendation | object | `{"enabled":false,"interval":"30m","lookbackWindow":"7d","metricNodeNameLabel":"node","prometheusTenantId":"","prometheusUrl":""}` | Node EBS throughput recommendations. A second loop reads node exporter counters from a Prometheus-compatible backend and publishes a recommended gp3 throughput as annotations on each in-cluster Node. It never modifies a volume: an operator reviews the annotation and applies it. Targets in-cluster Nodes, unlike the resize loop above, which excludes them by default. Everything not listed here (the observation quantile, headroom, recommendation step, device matcher, annotation prefix) is fixed policy in the addon rather than a setting. |
| config.throughputRecommendation.enabled | bool | `false` | Enable node throughput recommendations; requires prometheusUrl when true. Also creates the ClusterRole granting get/list/patch on nodes and create/patch on events, since a Node's Events are stored outside the release namespace. |
| config.throughputRecommendation.prometheusUrl | string | `""` | Base URL of a Prometheus server or a Mimir query-frontend/gateway; required when enabled. The /prometheus API prefix Mimir usually serves under may be included or omitted, since it is probed at startup. |
| config.throughputRecommendation.prometheusTenantId | string | `""` | Tenant sent as the X-Scope-OrgID header, which Mimir requires when multi-tenancy is enabled. Leave empty for Prometheus, which ignores it. For a gateway needing token auth, inject PROMETHEUS_BEARER_TOKEN via extraEnv from a Secret. |
| config.throughputRecommendation.metricNodeNameLabel | string | `"node"` | Metric label carrying the Kubernetes node name. kube-prometheus-stack relabels it to "node"; a plain node exporter scrape leaves only "instance". There is no default that is right for both. |
| config.throughputRecommendation.lookbackWindow | string | `"7d"` | How far back the observation window reaches, as a Prometheus duration (7d, 12h), not a Go duration. Bounded by the metrics backend's retention. |
| config.throughputRecommendation.interval | string | `"30m"` | How often recommendations are recomputed, as a Go duration. Separate from reconcileInterval and higher on purpose: the observation window spans days, so a much shorter interval only re-runs the most expensive query the addon issues. |
| extraEnv | list | `[]` | Additional environment variables for the container (raw EnvVar entries) |
| extraEnvFrom | list | `[]` | Additional envFrom sources for the container (configMapRef/secretRef entries) |
| ports.health | int | `8080` | Port serving /healthz and /readyz |
| ports.metrics | int | `8081` | Port serving Prometheus /metrics |
| rbac.create | bool | `true` | Create the Role and RoleBinding granting create/patch on Events for Kubernetes Event publishing, plus the ClusterRole and ClusterRoleBinding granting get/list/patch on nodes when config.throughputRecommendation.enabled is true |
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
| resources | object | `{"limits":{"memory":"128Mi"},"requests":{"cpu":"25m","memory":"64Mi"}}` | Pod resource requests and limits |
| resizePolicy | list | `[{"resourceName":"cpu","restartPolicy":"NotRequired"},{"resourceName":"memory","restartPolicy":"NotRequired"}]` | Container resize policy for in-place vertical scaling (requires Kubernetes 1.27+); empty omits the field |
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

* <https://github.com/younsl/o/tree/main/box/kubernetes/external-ebs-autoresizer>

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
