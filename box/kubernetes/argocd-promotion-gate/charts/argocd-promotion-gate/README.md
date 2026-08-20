# argocd-promotion-gate

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Admission gate that blocks an Argo CD Application sync until the same app is promoted in the upstream environment

**Homepage:** <https://github.com/younsl/o>

## Requirements

Kubernetes: `>=1.30.0-0`

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/argocd-promotion-gate
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `argocd-promotion-gate`:

```console
helm install argocd-promotion-gate oci://ghcr.io/younsl/charts/argocd-promotion-gate
```

Install with custom values:

```console
helm install argocd-promotion-gate oci://ghcr.io/younsl/charts/argocd-promotion-gate -f values.yaml
```

Install a specific version:

```console
helm install argocd-promotion-gate oci://ghcr.io/younsl/charts/argocd-promotion-gate --version 0.1.0
```

### Install from local chart

Download argocd-promotion-gate chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/argocd-promotion-gate --untar --version 0.1.0
helm install argocd-promotion-gate ./argocd-promotion-gate
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade argocd-promotion-gate oci://ghcr.io/younsl/charts/argocd-promotion-gate
```

## Uninstall

```console
helm uninstall argocd-promotion-gate
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| replicaCount | int | `1` | Number of gate replicas. Keep above one while `webhook.failurePolicy` is `Fail` |
| image.registry | string | `"ghcr.io"` | Container image registry host |
| image.repository | string | `"younsl/argocd-promotion-gate"` | Container image repository path without registry prefix |
| image.tag | string | `""` | Image tag; defaults to the chart appVersion when empty |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| nameOverride | string | `""` | Overrides the chart name used in resource names |
| fullnameOverride | string | `""` | Overrides the full generated resource name |
| serviceAccount.create | bool | `true` | Create a ServiceAccount for the gate |
| serviceAccount.annotations | object | `{}` | Annotations added to the ServiceAccount |
| serviceAccount.name | string | `""` | Existing ServiceAccount name when `create` is false |
| rbac.create | bool | `true` | Create the Role and RoleBinding granting read-only access to Applications |
| podAnnotations | object | `{}` | Annotations added to the gate pods |
| podLabels | object | `{}` | Labels added to the gate pods |
| podSecurityContext | object | `{"runAsGroup":65532,"runAsNonRoot":true,"runAsUser":65532,"seccompProfile":{"type":"RuntimeDefault"}}` | Pod-level security context |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true}` | Container-level security context |
| resources | object | `{"limits":{"memory":"128Mi"},"requests":{"cpu":"20m","memory":"64Mi"}}` | Resource requests and limits. No CPU limit: throttling admission turns latency into failed syncs |
| nodeSelector | object | `{}` | Node selector for the gate pods |
| tolerations | list | `[]` | Tolerations for the gate pods |
| topologySpreadConstraints | list | `[{"labelSelector":{"matchLabels":{"app.kubernetes.io/name":"argocd-promotion-gate"}},"maxSkew":1,"topologyKey":"kubernetes.io/hostname","whenUnsatisfiable":"ScheduleAnyway"}]` | Topology spread constraints. Spreading replicas keeps one node loss from failing every gated sync |
| affinity | object | `{}` | Affinity rules for the gate pods |
| podDisruptionBudget.enabled | bool | `true` | Create a PodDisruptionBudget |
| podDisruptionBudget.minAvailable | int/string | `1` | Minimum available replicas during voluntary disruption |
| service.type | string | `"ClusterIP"` | Service type |
| service.trafficDistribution | string | `""` | Endpoint routing preference. `PreferSameZone` or `PreferSameNode`, or the deprecated `PreferClose`. Empty leaves it unset |
| service.webhookPort | int | `443` | Port the API server calls for admission review |
| service.adminPort | int | `8080` | Port serving probes, metrics, and the UI extension API |
| serviceMonitor.enabled | bool | `false` | Create a Prometheus Operator ServiceMonitor |
| serviceMonitor.interval | string | `"30s"` | Scrape interval |
| serviceMonitor.scrapeTimeout | string | `"10s"` | Scrape timeout |
| serviceMonitor.labels | object | `{}` | Extra labels for Prometheus Operator selection |
| logging.level | string | `"info"` | Log level: debug, info, warn, error |
| logging.format | string | `"json"` | Log format: json or text |
| webhook.failurePolicy | string | `"Fail"` | `Fail` keeps the gate from being bypassed by an outage. `Ignore` trades enforcement for availability |
| webhook.timeoutSeconds | int | `5` | Admission timeout. Keep above `gate.argocd.timeoutSeconds` |
| webhook.certValidityDays | int | `3650` | Serving certificate lifetime in days. The Secret is reused across upgrades |
| webhook.extraMatchConditions | list | `[]` | Extra CEL match conditions appended to the generated ones |
| uiExtension.name | string | `"promotion-gate"` | Name argocd-server proxies under `/extensions/<name>/...`. Must match argocd-cm |
| gate.chain | list | `["stage","prod"]` | Promotion order lowest first. Env names are Argo CD projects and apps are named `<project>-<app>` |
| gate.gatedEnvs | list | `["prod"]` | Environments the gate enforces. Empty means the whole chain except its head |
| gate.require.sync | bool | `true` | Upstream must report `status.sync.status: Synced` |
| gate.require.health | bool | `true` | Upstream must report `status.health.status: Healthy` |
| gate.imageTag.enabled | bool | `true` | Compare image tags on top of the upstream sync and health checks |
| gate.imageTag.mode | string | `"warn"` | `warn` reports a mismatch and lets the sync through. `enforce` denies it |
| gate.imageTag.kinds | list | `["Deployment","StatefulSet","DaemonSet","CronJob","Rollout"]` | Workload kinds queried for desired images |
| gate.imageTag.ignoreRepos | list | `[]` | Repository basenames excluded from comparison. A trailing `*` globs |
| gate.imageTag.onError | string | `"deny"` | Verdict when the desired image lookup fails: `allow` or `deny` |
| gate.rollback.allowPreviouslyDeployedRevision | bool | `true` | Allow a sync whose target revision this Application already deployed. This is what makes rollback possible |
| gate.exempt.usernames | list | `["system:serviceaccount:argocd:argocd-application-controller"]` | Principals whose sync requests bypass the gate. Keep the application controller listed |
| gate.exempt.automated | bool | `true` | Bypass the gate when Argo CD marks the operation automated |
| gate.exempt.annotation | string | `"promotion-gate.younsl.github.io/skip"` | Application annotation that opts one app out when set to `"true"` |
| gate.argocd.namespace | string | `"argocd"` | Namespace holding the Application resources |
| gate.argocd.serverAddress | string | `"https://argocd-server"` | Base URL of argocd-server. Its certificate has no SAN for the fully qualified name |
| gate.argocd.insecureSkipVerify | bool | `false` | Disable TLS verification against argocd-server. Prefer `caSecret` |
| gate.argocd.timeoutSeconds | int | `3` | Per-request timeout for argocd-server calls |
| gate.argocd.cacheTtlSeconds | int | `30` | How long a desired image lookup is reused |
| gate.argocd.caSecret.enabled | bool | `true` | Mount a CA bundle for argocd-server |
| gate.argocd.caSecret.name | string | `"argocd-secret"` | Secret holding the CA. Argo CD's certificate is its own issuer |
| gate.argocd.caSecret.key | string | `"tls.crt"` | Key inside the Secret |
| gate.argocd.tokenSecret.name | string | `"argocd-promotion-gate-token"` | Secret holding the Argo CD API token for the desired image lookup |
| gate.argocd.tokenSecret.key | string | `"token"` | Key inside the Secret |
| extraObjects | list | `[]` | Extra manifests rendered as-is and templated with the release context |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/argocd-promotion-gate>

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
