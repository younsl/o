# trivy-collector

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Multi-cluster Trivy report collector and viewer

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/trivy-collector
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `trivy-collector`:

```console
helm install trivy-collector oci://ghcr.io/younsl/charts/trivy-collector
```

Install with custom values:

```console
helm install trivy-collector oci://ghcr.io/younsl/charts/trivy-collector -f values.yaml
```

Install a specific version:

```console
helm install trivy-collector oci://ghcr.io/younsl/charts/trivy-collector --version 0.1.0
```

### Install from local chart

Download trivy-collector chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/trivy-collector --untar --version 0.1.0
helm install trivy-collector ./trivy-collector
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade trivy-collector oci://ghcr.io/younsl/charts/trivy-collector
```

## Uninstall

```console
helm uninstall trivy-collector
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` | Affinity rules for pod scheduling |
| clusterName | string | `"local"` | Cluster name identifier |
| collector | object | `{"collectSbomReports":true,"collectVulnerabilityReports":true,"namespaces":[],"retryAttempts":3,"retryDelaySecs":5,"serverUrl":""}` | Collector mode configuration (for Edge clusters) |
| collector.collectSbomReports | bool | `true` | Collect SbomReports |
| collector.collectVulnerabilityReports | bool | `true` | Collect VulnerabilityReports |
| collector.namespaces | list | `[]` | Namespaces to watch (empty = all namespaces) |
| collector.retryAttempts | int | `3` | Number of retry attempts on failure |
| collector.retryDelaySecs | int | `5` | Delay between retries in seconds |
| collector.serverUrl | string | `""` | Central server URL (required for collector mode) |
| fullnameOverride | string | `""` | Override the full name of the chart |
| health | object | `{"port":8080}` | Health check configuration |
| health.port | int | `8080` | Health check server port |
| image | object | `{"pullPolicy":"IfNotPresent","repository":"ghcr.io/younsl/trivy-collector","tag":""}` | Container image configuration |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| image.repository | string | `"ghcr.io/younsl/trivy-collector"` | Image repository |
| image.tag | string | `""` | Image tag (defaults to chart appVersion) |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| livenessProbe | object | `{"failureThreshold":3,"httpGet":{"path":"/healthz","port":"health"},"initialDelaySeconds":10,"periodSeconds":30,"timeoutSeconds":5}` | Liveness probe configuration |
| livenessProbe.failureThreshold | int | `3` | Number of failures before marking unhealthy |
| livenessProbe.initialDelaySeconds | int | `10` | Initial delay before starting probes |
| livenessProbe.periodSeconds | int | `30` | Probe interval |
| livenessProbe.timeoutSeconds | int | `5` | Probe timeout |
| logging | object | `{"format":"json","level":"info"}` | Logging configuration |
| logging.format | string | `"json"` | Log format: "json" or "pretty" |
| logging.level | string | `"info"` | Log level: trace, debug, info, warn, error |
| mode | string | collector | Deployment mode: "collector" (Edge clusters) or "server" (Central cluster) |
| nameOverride | string | `""` | Override the name of the chart |
| nodeSelector | object | `{}` | Node selector for pod scheduling |
| podAnnotations | object | `{}` | Annotations to add to the pod |
| podLabels | object | `{}` | Labels to add to the pod |
| podSecurityContext | object | `{"fsGroup":1000,"runAsGroup":1000,"runAsNonRoot":true,"runAsUser":1000}` | Pod security context configuration |
| podSecurityContext.fsGroup | int | `1000` | Filesystem group ID |
| podSecurityContext.runAsGroup | int | `1000` | Group ID to run as |
| podSecurityContext.runAsNonRoot | bool | `true` | Run as non-root user |
| podSecurityContext.runAsUser | int | `1000` | User ID to run as |
| readinessProbe | object | `{"failureThreshold":3,"httpGet":{"path":"/readyz","port":"health"},"initialDelaySeconds":5,"periodSeconds":10,"timeoutSeconds":5}` | Readiness probe configuration |
| readinessProbe.failureThreshold | int | `3` | Number of failures before marking not ready |
| readinessProbe.initialDelaySeconds | int | `5` | Initial delay before starting probes |
| readinessProbe.periodSeconds | int | `10` | Probe interval |
| readinessProbe.timeoutSeconds | int | `5` | Probe timeout |
| replicaCount | int | `1` | Number of replicas for the deployment |
| resizePolicy | list | [] | Container resize policy for in-place resource updates |
| resources | object | `{"limits":{"memory":"256Mi"},"requests":{"cpu":"100m","memory":"128Mi"}}` | Resource requests and limits |
| resources.limits.memory | string | `"256Mi"` | Memory limit |
| resources.requests.cpu | string | `"100m"` | CPU request |
| resources.requests.memory | string | `"128Mi"` | Memory request |
| revisionHistoryLimit | int | `10` | Number of old ReplicaSets to retain for rollback |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true}` | Container security context configuration |
| securityContext.allowPrivilegeEscalation | bool | `false` | Disallow privilege escalation |
| securityContext.capabilities | object | `{"drop":["ALL"]}` | Capabilities to drop |
| securityContext.readOnlyRootFilesystem | bool | `true` | Mount root filesystem as read-only |
| server | object | `{"gateway":{"enabled":false,"hostnames":["trivy.example.com"],"name":"","parentRefs":[{"group":"gateway.networking.k8s.io","kind":"Gateway","name":"main-gateway","namespace":"gateway-system","sectionName":"https"}],"rules":[{"backendRefs":[{"name":"","port":3000}],"filters":[],"matches":[{"path":{"type":"PathPrefix","value":"/"}}]}]},"ingress":{"annotations":{},"className":"","enabled":false,"hosts":[{"host":"trivy.example.com","paths":[{"path":"/","pathType":"Prefix"}]}],"tls":[]},"persistence":{"accessMode":"ReadWriteOnce","annotations":{},"enabled":true,"existingClaim":"","labels":{},"size":"5Gi","storageClass":""},"port":3000}` | Server mode configuration (for Central cluster) |
| server.gateway | object | `{"enabled":false,"hostnames":["trivy.example.com"],"name":"","parentRefs":[{"group":"gateway.networking.k8s.io","kind":"Gateway","name":"main-gateway","namespace":"gateway-system","sectionName":"https"}],"rules":[{"backendRefs":[{"name":"","port":3000}],"filters":[],"matches":[{"path":{"type":"PathPrefix","value":"/"}}]}]}` | Gateway API HTTPRoute configuration (alternative to Ingress) |
| server.gateway.enabled | bool | `false` | Enable HTTPRoute |
| server.gateway.hostnames | list | `["trivy.example.com"]` | Hostnames for the route |
| server.gateway.name | string | `""` | HTTPRoute name (defaults to fullname) |
| server.gateway.parentRefs | list | `[{"group":"gateway.networking.k8s.io","kind":"Gateway","name":"main-gateway","namespace":"gateway-system","sectionName":"https"}]` | Parent Gateway references |
| server.gateway.rules | list | `[{"backendRefs":[{"name":"","port":3000}],"filters":[],"matches":[{"path":{"type":"PathPrefix","value":"/"}}]}]` | HTTP route rules |
| server.gateway.rules[0].filters | list | `[]` | HTTPRoute filters (RequestHeaderModifier, ResponseHeaderModifier, RequestRedirect, URLRewrite, RequestMirror, ExtensionRef) |
| server.ingress | object | `{"annotations":{},"className":"","enabled":false,"hosts":[{"host":"trivy.example.com","paths":[{"path":"/","pathType":"Prefix"}]}],"tls":[]}` | Ingress configuration |
| server.ingress.annotations | object | `{}` | Annotations to add to the Ingress |
| server.ingress.className | string | `""` | Ingress class name |
| server.ingress.enabled | bool | `false` | Enable Ingress |
| server.ingress.hosts | list | `[{"host":"trivy.example.com","paths":[{"path":"/","pathType":"Prefix"}]}]` | Ingress hosts configuration |
| server.ingress.tls | list | `[]` | TLS configuration for Ingress |
| server.persistence | object | `{"accessMode":"ReadWriteOnce","annotations":{},"enabled":true,"existingClaim":"","labels":{},"size":"5Gi","storageClass":""}` | Persistent volume configuration |
| server.persistence.accessMode | string | `"ReadWriteOnce"` | PVC access mode |
| server.persistence.annotations | object | `{}` | Annotations to add to the PVC |
| server.persistence.enabled | bool | `true` | Enable persistent storage |
| server.persistence.existingClaim | string | `""` | Use existing PVC instead of creating one |
| server.persistence.labels | object | `{}` | Labels to add to the PVC |
| server.persistence.size | string | `"5Gi"` | Storage size |
| server.persistence.storageClass | string | `""` | Storage class for dynamic provisioning |
| server.port | int | `3000` | HTTP server port |
| service | object | `{"port":3000,"type":"ClusterIP"}` | Service configuration |
| service.port | int | `3000` | Service port |
| service.type | string | `"ClusterIP"` | Service type |
| serviceAccount | object | `{"annotations":{},"automount":true,"create":true,"name":""}` | ServiceAccount configuration |
| serviceAccount.annotations | object | `{}` | Annotations to add to the ServiceAccount |
| serviceAccount.automount | bool | `true` | Automount service account token |
| serviceAccount.create | bool | `true` | Create a ServiceAccount |
| serviceAccount.name | string | `""` | Name of the ServiceAccount (auto-generated if empty) |
| tolerations | list | `[]` | Tolerations for pod scheduling |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/trivy-collector>

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
