# trivy-collector

![Version: 0.6.0](https://img.shields.io/badge/Version-0.6.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 1.4.0](https://img.shields.io/badge/AppVersion-1.4.0-informational?style=flat-square)

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
helm install trivy-collector oci://ghcr.io/younsl/charts/trivy-collector --version 0.6.0
```

### Install from local chart

Download trivy-collector chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/trivy-collector --untar --version 0.6.0
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
| replicaCount | int | `1` | Number of replicas for the deployment |
| revisionHistoryLimit | int | `10` | Number of old ReplicaSets to retain for rollback |
| image | object | `{"pullPolicy":"IfNotPresent","repository":"ghcr.io/younsl/trivy-collector","tag":""}` | Container image configuration |
| image.repository | string | `"ghcr.io/younsl/trivy-collector"` | Image repository |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| image.tag | string | `""` | Image tag (defaults to chart appVersion) |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| nameOverride | string | `""` | Override the name of the chart |
| fullnameOverride | string | `""` | Override the full name of the chart |
| serviceAccount | object | `{"annotations":{},"automount":true,"create":true,"name":""}` | ServiceAccount configuration |
| serviceAccount.create | bool | `true` | Create a ServiceAccount |
| serviceAccount.automount | bool | `true` | Automount service account token |
| serviceAccount.annotations | object | `{}` | Annotations to add to the ServiceAccount |
| serviceAccount.name | string | `""` | Name of the ServiceAccount (auto-generated if empty) |
| podAnnotations | object | `{}` | Annotations to add to the pod |
| podLabels | object | `{}` | Labels to add to the pod |
| podSecurityContext | object | `{"fsGroup":1000,"runAsGroup":1000,"runAsNonRoot":true,"runAsUser":1000}` | Pod security context configuration |
| podSecurityContext.runAsNonRoot | bool | `true` | Run as non-root user |
| podSecurityContext.runAsUser | int | `1000` | User ID to run as |
| podSecurityContext.runAsGroup | int | `1000` | Group ID to run as |
| podSecurityContext.fsGroup | int | `1000` | Filesystem group ID |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true}` | Container security context configuration |
| securityContext.allowPrivilegeEscalation | bool | `false` | Disallow privilege escalation |
| securityContext.capabilities | object | `{"drop":["ALL"]}` | Capabilities to drop |
| securityContext.readOnlyRootFilesystem | bool | `true` | Mount root filesystem as read-only |
| mode | string | collector | Deployment mode: "collector" (Edge clusters) or "server" (Central cluster) |
| clusterName | string | `"local"` | Cluster name identifier |
| collector | object | `{"collectSbomReports":true,"collectVulnerabilityReports":true,"namespaces":[],"retryAttempts":3,"retryDelaySecs":5,"serverUrl":""}` | Collector mode configuration (for Edge clusters) |
| collector.serverUrl | string | `""` | Central server URL (required for collector mode) |
| collector.namespaces | list | `[]` | Namespaces to watch (empty = all namespaces) |
| collector.collectVulnerabilityReports | bool | `true` | Collect VulnerabilityReports |
| collector.collectSbomReports | bool | `true` | Collect SbomReports |
| collector.retryAttempts | int | `3` | Number of retry attempts on failure |
| collector.retryDelaySecs | int | `5` | Delay between retries in seconds |
| server | object | `{"gateway":{"enabled":false,"hostnames":["trivy.example.com"],"name":"","parentRefs":[{"group":"gateway.networking.k8s.io","kind":"Gateway","name":"main-gateway","namespace":"gateway-system","sectionName":"https"}],"rules":[{"backendRefs":[{"name":"","port":3000}],"filters":[],"matches":[{"path":{"type":"PathPrefix","value":"/"}}]}]},"ingress":{"annotations":{},"className":"","enabled":false,"hosts":[{"host":"trivy.example.com","paths":[{"path":"/","pathType":"Prefix"}]}],"tls":[]},"persistence":{"accessMode":"ReadWriteOnce","annotations":{},"enabled":true,"existingClaim":"","labels":{},"size":"1Gi","storageClass":""},"port":3000}` | Server mode configuration (for Central cluster) |
| server.port | int | `3000` | HTTP server port |
| server.persistence | object | `{"accessMode":"ReadWriteOnce","annotations":{},"enabled":true,"existingClaim":"","labels":{},"size":"1Gi","storageClass":""}` | Persistent volume configuration |
| server.persistence.enabled | bool | `true` | Enable persistent storage |
| server.persistence.existingClaim | string | `""` | Use existing PVC instead of creating one |
| server.persistence.storageClass | string | `""` | Storage class for dynamic provisioning |
| server.persistence.accessMode | string | `"ReadWriteOnce"` | PVC access mode |
| server.persistence.size | string | `"1Gi"` | Storage size |
| server.persistence.labels | object | `{}` | Labels to add to the PVC |
| server.persistence.annotations | object | `{}` | Annotations to add to the PVC |
| server.ingress | object | `{"annotations":{},"className":"","enabled":false,"hosts":[{"host":"trivy.example.com","paths":[{"path":"/","pathType":"Prefix"}]}],"tls":[]}` | Ingress configuration |
| server.ingress.enabled | bool | `false` | Enable Ingress |
| server.ingress.className | string | `""` | Ingress class name |
| server.ingress.annotations | object | `{}` | Annotations to add to the Ingress |
| server.ingress.hosts | list | `[{"host":"trivy.example.com","paths":[{"path":"/","pathType":"Prefix"}]}]` | Ingress hosts configuration |
| server.ingress.tls | list | `[]` | TLS configuration for Ingress |
| server.gateway | object | `{"enabled":false,"hostnames":["trivy.example.com"],"name":"","parentRefs":[{"group":"gateway.networking.k8s.io","kind":"Gateway","name":"main-gateway","namespace":"gateway-system","sectionName":"https"}],"rules":[{"backendRefs":[{"name":"","port":3000}],"filters":[],"matches":[{"path":{"type":"PathPrefix","value":"/"}}]}]}` | Gateway API HTTPRoute configuration (alternative to Ingress) |
| server.gateway.enabled | bool | `false` | Enable HTTPRoute |
| server.gateway.name | string | `""` | HTTPRoute name (defaults to fullname) |
| server.gateway.parentRefs | list | `[{"group":"gateway.networking.k8s.io","kind":"Gateway","name":"main-gateway","namespace":"gateway-system","sectionName":"https"}]` | Parent Gateway references |
| server.gateway.hostnames | list | `["trivy.example.com"]` | Hostnames for the route |
| server.gateway.rules | list | `[{"backendRefs":[{"name":"","port":3000}],"filters":[],"matches":[{"path":{"type":"PathPrefix","value":"/"}}]}]` | HTTP route rules |
| server.gateway.rules[0].filters | list | `[]` | HTTPRoute filters (RequestHeaderModifier, ResponseHeaderModifier, RequestRedirect, URLRewrite, RequestMirror, ExtensionRef) |
| service | object | `{"port":3000,"type":"ClusterIP"}` | Service configuration |
| service.type | string | `"ClusterIP"` | Service type |
| service.port | int | `3000` | Service port |
| health | object | `{"port":8080}` | Health check configuration |
| health.port | int | `8080` | Health check server port |
| logging | object | `{"format":"json","level":"info"}` | Logging configuration |
| logging.format | string | `"json"` | Log format: "json" or "pretty" |
| logging.level | string | `"info"` | Log level: trace, debug, info, warn, error |
| resources | object | `{"limits":{"memory":"64Mi"},"requests":{"cpu":"20m","memory":"32Mi"}}` | Resource requests and limits |
| resources.limits.memory | string | `"64Mi"` | Memory limit |
| resources.requests.cpu | string | `"20m"` | CPU request |
| resources.requests.memory | string | `"32Mi"` | Memory request |
| resizePolicy | list | [] | Container resize policy for in-place resource updates |
| livenessProbe | object | `{"failureThreshold":3,"httpGet":{"path":"/healthz","port":"health"},"initialDelaySeconds":10,"periodSeconds":30,"timeoutSeconds":5}` | Liveness probe configuration |
| livenessProbe.initialDelaySeconds | int | `10` | Initial delay before starting probes |
| livenessProbe.periodSeconds | int | `30` | Probe interval |
| livenessProbe.timeoutSeconds | int | `5` | Probe timeout |
| livenessProbe.failureThreshold | int | `3` | Number of failures before marking unhealthy |
| readinessProbe | object | `{"failureThreshold":3,"httpGet":{"path":"/readyz","port":"health"},"initialDelaySeconds":5,"periodSeconds":10,"timeoutSeconds":5}` | Readiness probe configuration |
| readinessProbe.initialDelaySeconds | int | `5` | Initial delay before starting probes |
| readinessProbe.periodSeconds | int | `10` | Probe interval |
| readinessProbe.timeoutSeconds | int | `5` | Probe timeout |
| readinessProbe.failureThreshold | int | `3` | Number of failures before marking not ready |
| nodeSelector | object | `{}` | Node selector for pod scheduling |
| tolerations | list | `[]` | Tolerations for pod scheduling |
| affinity | object | `{}` | Affinity rules for pod scheduling |
| dnsPolicy | string | "" | DNS policy for the pod (ClusterFirst, ClusterFirstWithHostNet, Default, None) |
| dnsConfig | object | {} | DNS configuration for the pod |

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
