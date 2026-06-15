# forklift

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.1.0](https://img.shields.io/badge/AppVersion-0.1.0-informational?style=flat-square)

Lightweight Kubernetes-native artifact repository (Maven, npm, Cargo, Go) with proxy caching and supply-chain age policy

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/forklift
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `forklift`:

```console
helm install forklift oci://ghcr.io/younsl/charts/forklift
```

Install with custom values:

```console
helm install forklift oci://ghcr.io/younsl/charts/forklift -f values.yaml
```

Install a specific version:

```console
helm install forklift oci://ghcr.io/younsl/charts/forklift --version 0.1.0
```

### Install from local chart

Download forklift chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/forklift --untar --version 0.1.0
helm install forklift ./forklift
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade forklift oci://ghcr.io/younsl/charts/forklift
```

## Uninstall

```console
helm uninstall forklift
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| replicaCount | int | `2` | Number of replicas. With 2+ replicas, enable ha to elect a single active writer. |
| revisionHistoryLimit | int | `10` | Number of old ReplicaSets to retain for rollback. |
| image.repository | string | `"ghcr.io/younsl/forklift"` | Container image repository. |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| image.tag | string | `""` | Image tag. Defaults to the chart appVersion when empty. |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries. |
| nameOverride | string | `""` | Override the chart name portion of resource names. |
| fullnameOverride | string | `""` | Override the fully qualified resource name. |
| ha.enabled | bool | `nil` | Enable leader election. Auto-derived from replicaCount > 1 when left null. |
| ha.leaseName | string | `""` | Lease object name. Defaults to the release fullname when empty. |
| ha.leaseDuration | string | `"15s"` | Duration that non-leader candidates wait before attempting to acquire leadership. |
| ha.renewDeadline | string | `"10s"` | Deadline for the leader to renew the lease before giving up leadership. |
| ha.retryPeriod | string | `"2s"` | Interval between leadership acquisition attempts. |
| replication.enabled | bool | `false` | Enable PV-based replication (StatefulSet + per-pod RWO PVC). Use with replicaCount 2. Mutually exclusive with the shared RWX volume mode. |
| replication.interval | string | `"30s"` | Standby pull interval; also the bounded data-loss window on failover. |
| replication.token | string | `""` | Shared bearer token for the internal replication endpoints. If empty a random token is generated into the chart Secret and preserved. |
| persistence.enabled | bool | `true` | Enable persistent storage. When false, data is lost on pod restart. |
| persistence.storageClass | string | `""` | StorageClass for the PVC. Uses the cluster default when empty. |
| persistence.accessModes | list | `["ReadWriteMany"]` | PVC access modes. MUST be ReadWriteMany for replicaCount > 1. |
| persistence.size | string | `"20Gi"` | PVC storage size. |
| persistence.annotations | object | `{}` | Annotations to add to the PVC. |
| auth.anonymousRead | bool | `false` | Allow unauthenticated read (pull) access. |
| auth.sessionTTL | string | `"12h"` | Session cookie lifetime. |
| auth.sessionSecret | string | `""` | Secret used to sign session cookies; MUST be shared across replicas. If empty a value is generated into the chart Secret on first install and preserved. |
| auth.bootstrap.adminUser | string | `"admin"` | Admin username seeded on first run (no users yet). |
| auth.bootstrap.adminPassword | string | `""` | Admin password seeded on first run. If empty a random password is generated into the chart Secret (key: bootstrap-admin-password) and preserved across upgrades. Rotate after first login. Retrieve a generated password with:   kubectl get secret <release>-forklift -o jsonpath='{.data.bootstrap-admin-password}' | base64 -d |
| auth.oidc.enabled | bool | `false` | Enable OIDC single sign-on. |
| auth.oidc.issuerURL | string | `""` | OIDC issuer URL. |
| auth.oidc.clientID | string | `""` | OIDC client ID. |
| auth.oidc.clientSecret | string | `""` | OIDC client secret. |
| auth.oidc.redirectURL | string | `""` | OIDC redirect URL. |
| auth.oidc.usernameClaim | string | `"preferred_username"` | Token claim used as the username. |
| auth.oidc.groupsClaim | string | `"groups"` | Token claim used for group membership. |
| auth.rbac.enabled | bool | `true` | Enable declarative RBAC. When false, no policy is mounted and authorization relies solely on roles managed through the UI/API. |
| auth.rbac.policyDefault | string | `"readonly"` | Default role granted to every authenticated user, even with no explicit role or group mapping (ArgoCD policy.default). Empty disables it (deny-all until a role is granted). The default `readonly` role below grants read (pull) access to all repositories for any signed-in user. |
| auth.rbac.policy | string | `"# Read-only access to every repository (default role for all users).\np, readonly, repo, read, *, allow\n\n# Full administrative access.\np, admins, repo, admin, *, allow\n\n# Example: developers can pull and push to team repositories.\n# p, developer, repo, read, team-a-*, allow\n# p, developer, repo, write, team-a-*, allow\n\n# Example: map a Keycloak group and a specific user to roles.\n# g, group:/platform-admins, admins\n# g, user:alice, developer\n"` | ArgoCD-style policy. Permission lines:   p, <role>, repo, <action>, <repo-glob>, allow where <action> is read|write|delete|approve|admin (or '*' = admin). Grant lines:   g, <subject>, <role> where <subject> is `group:<keycloak-group>`, `user:<username>`, or a bare name (treated as a user). Lines starting with '#' are comments. |
| auth.rbac.accounts | list | `[]` | Local (password) accounts to provision declaratively. Each gets a password generated into the chart Secret (key: local-user-<name>-password) and preserved across upgrades, or set `password` explicitly. Grant roles to them with `g, user:<name>, <role>` lines above. Existing accounts (incl. the bootstrap admin) are never overwritten. |
| audit.enabled | bool | `true` | Enable the audit log. |
| audit.retention | string | `"2160h"` | Retention period; the leader prunes older entries. "0" keeps them forever. |
| seedDefaultRepos | bool | `true` | Seed default repositories on first run, like a fresh Nexus install: a proxy of each public registry (Maven Central, npm, crates.io, Go proxy) plus one local hosted repository per format. Idempotent. Set false to start with no repos. |
| log.level | string | `"info"` | Log level (debug, info, warn, error). |
| log.format | string | `"json"` | Log format (json, text). |
| serviceAccount.create | bool | `true` | Create a ServiceAccount. |
| serviceAccount.annotations | object | `{}` | Annotations to add to the ServiceAccount (e.g. IRSA role ARN). |
| serviceAccount.name | string | `""` | ServiceAccount name. Generated from the fullname when empty. |
| rbac.create | bool | `true` | Create namespaced Role/RoleBinding for the Lease used by leader election. Created when ha is on. |
| service.type | string | `"ClusterIP"` | Service type. |
| service.port | int | `80` | Service port for HTTP traffic. |
| service.metricsPort | int | `8081` | Service port exposing Prometheus metrics (container port 8081). |
| service.annotations | object | `{}` | Annotations to add to the Service. |
| ingress.enabled | bool | `false` | Enable Ingress. |
| ingress.className | string | `""` | IngressClass name. |
| ingress.annotations | object | `{}` | Annotations to add to the Ingress. |
| ingress.hosts | list | `[{"host":"forklift.example.com","paths":[{"path":"/","pathType":"Prefix"}]}]` | Ingress host rules. |
| ingress.tls | list | `[]` | Ingress TLS configuration. |
| gateway.enabled | bool | `false` | Enable HTTPRoute. |
| gateway.name | string | `""` | HTTPRoute name. Defaults to the release fullname when empty. |
| gateway.parentRefs | list | `[{"group":"gateway.networking.k8s.io","kind":"Gateway","name":"main-gateway","namespace":"gateway-system","sectionName":"https"}]` | Parent Gateway references. |
| gateway.hostnames | list | `["forklift.example.com"]` | Hostnames for the route. |
| gateway.rules | list | `[{"backendRefs":[{"group":"","kind":"Service","name":"","port":"","weight":1}],"filters":[],"matches":[{"path":{"type":"PathPrefix","value":"/"}}]}]` | HTTP route rules. |
| gateway.rules[0].filters | list | `[]` | HTTPRoute filters (RequestHeaderModifier, ResponseHeaderModifier, RequestRedirect, URLRewrite, RequestMirror, ExtensionRef). |
| gateway.rules[0].backendRefs | list | `[{"group":"","kind":"Service","name":"","port":"","weight":1}]` | HTTPBackendRefs. Empty `name` defaults to the chart Service and empty `port` to service.port at render time. |
| podAnnotations | object | `{}` | Annotations to add to pods. |
| podLabels | object | `{}` | Labels to add to pods. |
| podSecurityContext | object | `{"fsGroup":65532,"runAsGroup":65532,"runAsNonRoot":true,"runAsUser":65532}` | Pod-level security context. |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":true}` | Container-level security context. |
| resources | object | `{"limits":{"memory":"256Mi"},"requests":{"cpu":"50m","memory":"128Mi"}}` | Container resource requests and limits. |
| resizePolicy | list | `[]` | In-place pod vertical scaling policy (Kubernetes 1.27+ resize). Example:   - resourceName: memory     restartPolicy: NotRequired |
| livenessProbe | object | `{"httpGet":{"path":"/healthz","port":"http"},"initialDelaySeconds":5,"periodSeconds":10}` | Liveness probe configuration. |
| readinessProbe | object | `{"httpGet":{"path":"/readyz","port":"http"},"initialDelaySeconds":3,"periodSeconds":5}` | Readiness probe configuration. |
| podDisruptionBudget.enabled | bool | `true` | Create a PodDisruptionBudget to keep replicas available during disruptions. |
| podDisruptionBudget.minAvailable | int | `1` | Minimum number of available replicas. |
| serviceMonitor.enabled | bool | `false` | Create a Prometheus Operator ServiceMonitor. |
| serviceMonitor.interval | string | `"30s"` | Scrape interval. |
| serviceMonitor.scrapeTimeout | string | `""` | Scrape timeout. Uses the Prometheus default when empty. |
| serviceMonitor.additionalLabels | object | `{}` | Additional labels for the ServiceMonitor (e.g. release selector). |
| nodeSelector | object | `{}` | Node selector for pod scheduling. |
| tolerations | list | `[]` | Tolerations for pod scheduling. |
| affinity | object | `{}` | Affinity rules for pod scheduling. |
| topologySpreadConstraints | list | `[]` | Topology spread constraints for pod scheduling. |
| extraEnv | list | `[]` | Raw environment variables appended to the container. |
| extraObjects | list | `[]` | Arbitrary additional manifests to render (each value is templated). |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/forklift>

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
