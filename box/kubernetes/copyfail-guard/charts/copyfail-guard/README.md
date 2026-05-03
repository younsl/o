# copyfail-guard

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Kubernetes DaemonSet that blocks AF_ALG socket creation to mitigate
CVE-2026-31431 (Copy.Fail) via eBPF LSM hook (preferred) or syscall
tracepoint (fallback). Built in Rust with cargo-zigbuild on a scratch
base image.

**Homepage:** <https://github.com/younsl/o>

## Requirements

Kubernetes: `>=1.27.0-0`

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/copyfail-guard
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `copyfail-guard`:

```console
helm install copyfail-guard oci://ghcr.io/younsl/charts/copyfail-guard
```

Install with custom values:

```console
helm install copyfail-guard oci://ghcr.io/younsl/charts/copyfail-guard -f values.yaml
```

Install a specific version:

```console
helm install copyfail-guard oci://ghcr.io/younsl/charts/copyfail-guard --version 0.1.0
```

### Install from local chart

Download copyfail-guard chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/copyfail-guard --untar --version 0.1.0
helm install copyfail-guard ./copyfail-guard
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade copyfail-guard oci://ghcr.io/younsl/charts/copyfail-guard
```

## Uninstall

```console
helm uninstall copyfail-guard
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| nameOverride | string | `""` | Override the chart name (defaults to the Chart.yaml `name`). |
| fullnameOverride | string | `""` | Override the fully qualified app name (defaults to release-name + chart name). |
| image.registry | string | `"ghcr.io"` | Container image registry. |
| image.repository | string | `"younsl/copyfail-guard"` | Container image repository. |
| image.tag | string | `""` | Container image tag. Defaults to `Chart.appVersion` when empty. |
| image.pullPolicy | string | `"IfNotPresent"` | Container image pull policy. |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries. |
| agent.mode | string | `"auto"` | Enforcement mode: `auto` (detect BPF LSM), `lsm` (force LSM hook), or `tracepoint` (force syscall killer). |
| agent.logFormat | string | `"json"` | Log format: `json` or `pretty`. |
| agent.logLevel | string | `"info"` | Log level: `trace`, `debug`, `info`, `warn`, `error`. |
| agent.extraEnv | list | `[]` | Extra environment variables passed to the agent container. |
| agent.extraArgs | list | `[]` | Extra CLI args appended to the entrypoint. |
| ports.health | int | `8080` | Port serving `/healthz` and `/readyz`. |
| ports.metrics | int | `8081` | Port serving Prometheus `/metrics`. |
| serviceAccount.create | bool | `true` | Create a dedicated ServiceAccount. |
| serviceAccount.annotations | object | `{}` | Annotations to add to the ServiceAccount (e.g. IRSA role ARN). |
| serviceAccount.name | string | `""` | Override the ServiceAccount name. Generated from fullname when empty. |
| podAnnotations | object | `{}` |  |
| podLabels | object | `{}` | Extra labels to add to the DaemonSet pod template. |
| podSecurityContext | object | `{}` | Pod-level security context. Required by eBPF: privileged + hostPID. |
| securityContext | object | `{"allowPrivilegeEscalation":true,"capabilities":{"add":["SYS_ADMIN","SYS_RESOURCE","BPF","PERFMON","SYS_PTRACE"],"drop":["ALL"]},"privileged":true,"readOnlyRootFilesystem":true,"runAsNonRoot":false,"runAsUser":0}` | Container-level security context. eBPF requires CAP_SYS_ADMIN, CAP_BPF, CAP_PERFMON, CAP_SYS_RESOURCE; running privileged is the simplest path. |
| hostPID | bool | `true` | Whether the pod uses the host PID namespace (required for `bpf_send_signal` and accurate process attribution). |
| hostNetwork | bool | `false` | Whether the pod uses the host network namespace. |
| dnsPolicy | string | `"ClusterFirst"` | Pod DNS policy. Set to `ClusterFirstWithHostNet` when `hostNetwork: true`. |
| resources | object | `{"limits":{"cpu":"100m","memory":"128Mi"},"requests":{"cpu":"10m","memory":"32Mi"}}` | Resource requests and limits. Conservative defaults; an event-driven eBPF agent has a small footprint. |
| nodeSelector | object | `{"kubernetes.io/os":"linux"}` | Node selector for DaemonSet pods. |
| tolerations | list | `[{"operator":"Exists"}]` | Tolerations. The default tolerates every taint so the agent reaches every node. |
| affinity | object | `{}` | Affinity rules. |
| priorityClassName | string | `"system-node-critical"` | Priority class name. Use `system-node-critical` to match other host-level agents. |
| updateStrategy | object | `{"rollingUpdate":{"maxUnavailable":1},"type":"RollingUpdate"}` | DaemonSet update strategy. |
| terminationGracePeriodSeconds | int | `30` | Termination grace period in seconds. |
| livenessProbe.enabled | bool | `true` | Enable the liveness probe. |
| livenessProbe.initialDelaySeconds | int | `15` | Initial delay before the first probe. |
| livenessProbe.periodSeconds | int | `20` | Probe interval. |
| livenessProbe.timeoutSeconds | int | `3` | Probe timeout. |
| livenessProbe.failureThreshold | int | `3` | Failure threshold before the container is restarted. |
| readinessProbe.enabled | bool | `true` | Enable the readiness probe. |
| readinessProbe.initialDelaySeconds | int | `5` | Initial delay before the first probe. |
| readinessProbe.periodSeconds | int | `10` | Probe interval. |
| readinessProbe.timeoutSeconds | int | `3` | Probe timeout. |
| readinessProbe.failureThreshold | int | `3` | Failure threshold before the pod is marked NotReady. |
| service.create | bool | `true` | Create a headless Service exposing the metrics port. |
| service.type | string | `"ClusterIP"` | Service type. |
| service.annotations | object | `{}` | Annotations to add to the Service. |
| serviceMonitor.enabled | bool | `false` | Create a Prometheus Operator `ServiceMonitor`. |
| serviceMonitor.namespace | string | `""` | Namespace where the ServiceMonitor is created. Defaults to release namespace. |
| serviceMonitor.interval | string | `"30s"` | Scrape interval. |
| serviceMonitor.scrapeTimeout | string | `"10s"` | Scrape timeout. |
| serviceMonitor.labels | object | `{}` | Extra labels added to the ServiceMonitor (e.g. `release: kube-prometheus-stack`). |
| serviceMonitor.metricRelabelings | list | `[]` | Metric relabeling rules. |
| serviceMonitor.relabelings | list | `[]` | Relabeling rules. |
| prometheusRule.enabled | bool | `false` | Create a Prometheus Operator `PrometheusRule` with default Copy.Fail alerts. |
| prometheusRule.namespace | string | `""` | Namespace where the PrometheusRule is created. Defaults to release namespace. |
| prometheusRule.labels | object | `{}` | Extra labels added to the PrometheusRule. |
| prometheusRule.additionalRules | list | `[]` | Additional rule groups appended to the default groups. |
| extraVolumes | list | `[]` | Extra volumes added to the pod (the chart already mounts `/sys/fs/bpf`, `/sys/kernel/debug`, `/sys/kernel/security`). |
| extraVolumeMounts | list | `[]` | Extra volume mounts added to the agent container. |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/copyfail-guard>

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| younsl |  | <https://github.com/younsl> |

## License

This chart is licensed under the Apache License 2.0. See [LICENSE](https://github.com/younsl/o/blob/main/LICENSE) for details.

## Contributing

This repository does not accept external contributions. Pull requests and issues are disabled.

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
