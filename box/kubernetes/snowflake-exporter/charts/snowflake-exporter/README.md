# snowflake-exporter

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Prometheus exporter for Snowflake account usage metrics

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/snowflake-exporter
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `snowflake-exporter`:

```console
helm install snowflake-exporter oci://ghcr.io/younsl/charts/snowflake-exporter
```

Install with custom values:

```console
helm install snowflake-exporter oci://ghcr.io/younsl/charts/snowflake-exporter -f values.yaml
```

Install a specific version:

```console
helm install snowflake-exporter oci://ghcr.io/younsl/charts/snowflake-exporter --version 0.1.0
```

### Install from local chart

Download snowflake-exporter chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/snowflake-exporter --untar --version 0.1.0
helm install snowflake-exporter ./snowflake-exporter
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade snowflake-exporter oci://ghcr.io/younsl/charts/snowflake-exporter
```

## Uninstall

```console
helm uninstall snowflake-exporter
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| replicaCount | int | `1` | Number of replicas. Snowflake ACCOUNT_USAGE views are account-wide, so running >1 replica only duplicates queries and credit usage. |
| revisionHistoryLimit | int | `3` | Number of old ReplicaSets to retain |
| podAnnotations | object | `{}` | Additional pod annotations |
| image.repository | string | `"ghcr.io/younsl/snowflake-exporter"` | Container image repository |
| image.tag | string | `""` | Image tag (defaults to chart appVersion) |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| serviceAccount.create | bool | `true` | Create a ServiceAccount |
| serviceAccount.name | string | `""` | ServiceAccount name (defaults to fullname template) |
| serviceAccount.annotations | object | `{}` | Annotations for the ServiceAccount |
| serviceAccount.automountServiceAccountToken | bool | `false` | Automount API credentials for the ServiceAccount |
| service.type | string | `"ClusterIP"` | Service type |
| service.port | int | `9975` | Service port |
| service.trafficDistribution | string | `""` | Traffic distribution policy (PreferClose, etc.) |
| serviceMonitor.enabled | bool | `true` | Enable ServiceMonitor for Prometheus Operator (requires monitoring.coreos.com/v1 CRD) |
| serviceMonitor.interval | string | `"60s"` | Scrape interval |
| serviceMonitor.scrapeTimeout | string | `"30s"` | Scrape timeout |
| serviceMonitor.labels | object | `{}` | Additional labels for ServiceMonitor |
| serviceMonitor.annotations | object | `{}` | Additional annotations for ServiceMonitor |
| serviceMonitor.metricRelabelings | list | `[]` | Metric relabeling rules applied after scrape |
| prometheusRules.enabled | bool | `false` | Enable PrometheusRule for Prometheus Operator (requires monitoring.coreos.com/v1 CRD) |
| prometheusRules.namespace | string | `""` | Namespace override for PrometheusRule |
| prometheusRules.labels | object | `{}` | Additional labels for PrometheusRule |
| prometheusRules.rules | list | See `values.yaml` | Alerting rules |
| config | object | `{"collection":{"enableServerlessDetail":false,"excludeDeletedTables":false,"intervalSeconds":300,"queryTimeoutSeconds":120},"logging":{"format":"json","level":"info"},"snowflake":{"account":"","database":"SNOWFLAKE","requestTimeoutSeconds":60,"role":"","warehouse":""}}` | snowflake-exporter config (mounted as ConfigMap) |
| config.snowflake.account | string | `""` | Snowflake account identifier (e.g. xy12345.ap-northeast-2.aws) |
| config.snowflake.role | string | `""` | Role for query execution. Ignored at auth time (PAT carries identity) but used in the SQL API request body |
| config.snowflake.warehouse | string | `""` | Warehouse used to run ACCOUNT_USAGE queries |
| config.snowflake.database | string | `"SNOWFLAKE"` | Database (default SNOWFLAKE which contains ACCOUNT_USAGE schema) |
| config.snowflake.requestTimeoutSeconds | int | `60` | HTTP request timeout in seconds for Snowflake SQL API v2 calls |
| config.collection.intervalSeconds | int | `300` | How often to re-query Snowflake in seconds. Set >= 300s to limit warehouse cost. |
| config.collection.excludeDeletedTables | bool | `false` | Skip the deleted-tables storage query (expensive on large accounts) |
| config.collection.enableServerlessDetail | bool | `false` | Emit per-pipe / per-task / per-materialized-view serverless credit metrics. Off by default — cardinality scales with the number of pipes/tasks/MVs. |
| config.collection.queryTimeoutSeconds | int | `120` | Server-side statement timeout per query in seconds |
| config.logging.level | string | `"info"` | Log level (trace, debug, info, warn, error) |
| config.logging.format | string | `"json"` | Log format (json or text) |
| auth | object | `{"createSecret":true,"existingSecret":"","token":"","tokenSecretKey":"token"}` | Snowflake Programmatic Access Token (PAT). Create with `ALTER USER <user> ADD PROGRAMMATIC ACCESS TOKEN ...` — the user binding and role restriction are set at PAT creation time. |
| auth.createSecret | bool | `true` | Create the Secret containing the PAT. Disable if managing the Secret externally (e.g. External Secrets Operator) |
| auth.existingSecret | string | `""` | Existing Secret name to consume instead of creating one |
| auth.tokenSecretKey | string | `"token"` | Secret key that holds the PAT string |
| auth.token | string | `""` | Raw PAT value (used only when createSecret is true). Prefer external secret management for production. |
| resizePolicy | list | See `values.yaml` | Container resize policy for in-place resource updates (requires InPlacePodVerticalScaling feature gate) |
| resources.requests.cpu | string | `"20m"` | CPU request |
| resources.requests.memory | string | `"32Mi"` | Memory request |
| resources.limits.memory | string | `"96Mi"` | Memory limit |
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

* <https://github.com/younsl/o/tree/main/box/kubernetes/snowflake-exporter>

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
