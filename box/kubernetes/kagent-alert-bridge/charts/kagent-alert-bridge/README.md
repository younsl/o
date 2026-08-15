# kagent-alert-bridge

![Version: 0.4.1](https://img.shields.io/badge/Version-0.4.1-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.3.2](https://img.shields.io/badge/AppVersion-0.3.2-informational?style=flat-square)

Posts Alertmanager alerts to Slack and replies in-thread with an analysis from a kagent agent over A2A

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/kagent-alert-bridge
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `kagent-alert-bridge`:

```console
helm install kagent-alert-bridge oci://ghcr.io/younsl/charts/kagent-alert-bridge
```

Install with custom values:

```console
helm install kagent-alert-bridge oci://ghcr.io/younsl/charts/kagent-alert-bridge -f values.yaml
```

Install a specific version:

```console
helm install kagent-alert-bridge oci://ghcr.io/younsl/charts/kagent-alert-bridge --version 0.4.1
```

### Install from local chart

Download kagent-alert-bridge chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/kagent-alert-bridge --untar --version 0.4.1
helm install kagent-alert-bridge ./kagent-alert-bridge
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade kagent-alert-bridge oci://ghcr.io/younsl/charts/kagent-alert-bridge
```

## Uninstall

```console
helm uninstall kagent-alert-bridge
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| image.registry | string | `"ghcr.io"` | Container image registry host |
| image.repository | string | `"younsl/kagent-alert-bridge"` | Container image repository path without registry prefix |
| image.tag | string | `""` | Image tag; defaults to the chart appVersion when empty |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy |
| imagePullSecrets | list | `[]` | Image pull secrets for private registries |
| nameOverride | string | `""` | Override the chart name |
| fullnameOverride | string | `""` | Override the fully qualified release name |
| replicaCount | int | `1` | Number of replicas. Each replica keeps its own in-memory deduplication state, so more than one replica can analyse the same alert group twice. |
| revisionHistoryLimit | int | `3` | Number of old ReplicaSets to retain for rollback |
| strategy | object | `{"rollingUpdate":{"maxSurge":"25%","maxUnavailable":"25%"},"type":"RollingUpdate"}` | Deployment update strategy |
| strategy.rollingUpdate.maxSurge | string|int | `"25%"` | Max Pods created above desired count during an update |
| strategy.rollingUpdate.maxUnavailable | string|int | `"25%"` | Max Pods unavailable during an update |
| slack.parentMode | string | `"lookup"` | How the thread parent is obtained. `lookup` leaves the alert notification to Alertmanager and finds it in channel history to reply under, which needs `channels:history` and `channels:read` (plus the `groups:*` equivalents for private channels). `post` makes the bridge publish the alert itself and needs only `chat:write`. |
| slack.lookupWindow | string | `"15m"` | How far back channel history is searched for the alert notification, as a Go duration. Only used in `lookup` mode. |
| slack.lookupAttempts | int | `3` | How many times to re-search before giving up. Alertmanager delivers the Slack notification and the webhook independently, so the first attempt can miss. Only used in `lookup` mode. |
| slack.investigatingReaction | string | `"telescope"` | Emoji (without colons) placed on the alert notification while the agent investigates and removed when the analysis lands. Needs `reactions:write`. Empty string disables it. |
| slack.completedReaction | string | `"white_check_mark"` | Emoji (without colons) that replaces the investigating reaction once the analysis has been posted. Needs `reactions:write`. Empty string disables it. |
| slack.defaultChannel | string | `""` | Channel used when the routing label is absent. A bare name is prefixed with #; a conversation ID is used as-is and skips the `channels:read` lookup. |
| slack.channelLabel | string | `"slack_channel"` | Alert label that selects the destination channel |
| slack.channelMap | object | `{}` | Mapping from routing label value to Slack channel, for labels whose value is not the channel name |
| slack.maxTextLength | int | `8000` | Maximum characters posted in one message; longer text is truncated |
| slack.apiURL | string | `"https://slack.com/api"` | Slack Web API base URL; override to route through an egress proxy |
| slack.existingSecret | string | `""` | Name of an existing Secret holding the bot token. Leave empty to create one from `slack.token`. |
| slack.existingSecretKey | string | `"SLACK_BOT_TOKEN"` | Key inside the Secret holding the bot token |
| slack.token | string | `""` | Bot token (xoxb-...). Only used when `slack.existingSecret` is empty; prefer an externally managed Secret. |
| slack.existingSecretAppTokenKey | string | `"SLACK_APP_TOKEN"` | Key inside `slack.existingSecret` holding the app-level token. Only read when `chat.enabled` is true. |
| slack.appToken | string | `""` | App-level token (xapp-...) that opens the Socket Mode connection carrying mentions. Created under Basic Information with the `connections:write` scope, which is not an OAuth scope. Only used when `slack.existingSecret` is empty. |
| chat.enabled | bool | `false` | Answer `@bot` mentions posted inside a Slack thread by running a kagent agent and replying in that thread. Needs an app-level token and the `app_mentions:read` bot scope, with Socket Mode and the `app_mention` event subscription enabled on the Slack app. Leaving this off keeps the binary behaving exactly as the alert-only build does. |
| chat.agent | string | `""` | Agent that answers mentions. Empty falls back to `kagent.agent`. |
| chat.agentMap | object | `{}` | Routing table from channel (name or ID) to the Agent resource answering there. A channel the table does not carry falls back to `chat.agent`. |
| chat.channels | list | `[]` | Channel names or IDs allowed to invoke the bot. Empty allows every channel the bot is a member of. |
| chat.allowedUsers | list | `[]` | Slack member IDs allowed to invoke the bot. Empty allows everyone in the allowed channels. |
| chat.instructions | string | `""` | Instructions appended to every mention prompt. Empty uses the built-in English instructions, which are separate from `analysis.instructions` because a question has no alert sections to fill. |
| chat.timeout | string | `"180s"` | Deadline for one whole turn including queueing, as a Go duration. The kagent controller caps a turn at 3 minutes in the v0.9.x line, so raising this above `180s` buys nothing; lowering it makes the bridge's own expiry fire first and cancel the task. |
| chat.sessionTTL | string | `"2h"` | How long a thread keeps its A2A `contextId` after its last turn, as a Go duration. Within it a follow-up mention continues the same agent session. `0s` makes every mention a cold turn. |
| chat.statusInterval | string | `"10s"` | How often the in-thread status message is rewritten while the agent works, as a Go duration. Each rewrite is one `chat.update` call, so a short interval buys a livelier status line at the cost of Slack rate limit budget. |
| chat.threadHint | string | `nil` | Ephemeral hint sent when the bot is mentioned at channel level instead of in a thread. `null` keeps the built-in text; an empty string drops the mention silently. |
| chat.deniedHint | string | `nil` | Ephemeral hint sent when the bot is mentioned in a channel outside `chat.channels`. `null` keeps the built-in text; an empty string drops the mention silently. |
| chat.maxConcurrent | int | `2` | Maximum mention turns running at once. Separate from `analysis.maxConcurrent` so a burst of questions cannot starve alert analysis of model concurrency. |
| kagent.url | string | `"http://kagent-controller.kagent:8083"` | Base URL of the kagent controller; the A2A path is appended to it |
| kagent.namespace | string | `"kagent"` | Namespace holding the Agent resource |
| kagent.agent | string | `"alert-triage-agent"` | Name of the Agent resource used when the routing label is absent or names no mapped agent |
| kagent.agentRoutingLabel | string | `""` | Alert label that routes an alert to an agent. Defaults to `slack.channelLabel` when empty, so one label can split both the channel and the agent. |
| kagent.agentRoutingMap | object | `{}` | Routing table from label value to the Agent resource that handles it, so one bridge can feed several specialised agents. Unlike `slack.channelMap` this is not an alias table: a value it does not carry falls back to `kagent.agent` instead of being used as an agent name. |
| kagent.userID | string | `"alert-bridge@kagent.dev"` | Identity sent as X-User-Id, which owns the kagent sessions the bridge creates |
| kagent.timeout | string | `"120s"` | Deadline for one whole analysis (queueing, parent lookup, and the polled agent run), as a Go duration. On expiry the task is cancelled on the controller so it stops consuming model tokens. |
| kagent.requestTimeout | string | `"30s"` | Timeout for a single HTTP call to the controller (submit, poll, or cancel), as a Go duration |
| kagent.pollInterval | string | `"5s"` | Wait between two task status polls, as a Go duration |
| analysis.severities | string | `"critical"` | Comma-separated severities to analyse; empty analyses every alert |
| analysis.label | string | `"analyze"` | Alert label that opts a rule in ("true") or out ("false") regardless of severity |
| analysis.resolved | bool | `false` | Analyse resolved notifications as well as firing ones |
| analysis.dedupeTTL | string | `"12h"` | How long a group stays suppressed after being analysed, as a Go duration. Should cover the Alertmanager repeat_interval. "0s" disables deduplication. |
| analysis.maxAlerts | int | `5` | Maximum alerts rendered into one prompt |
| analysis.maxConcurrent | int | `2` | Maximum analyses running at once, which bounds concurrent model spend |
| analysis.instructions | string | `""` | Instructions appended to every prompt. Empty uses the built-in English instructions; override to change the output language or sections. |
| webhook.path | string | `"/alert"` | Path Alertmanager posts to |
| webhook.existingSecret | string | `""` | Name of an existing Secret holding the bearer token the webhook requires. Leave empty to create one from `webhook.token`. |
| webhook.existingSecretKey | string | `"WEBHOOK_BEARER_TOKEN"` | Key inside the Secret holding the bearer token |
| webhook.token | string | `""` | Bearer token required on incoming webhooks. Empty disables authentication. |
| log.level | string | `"info"` | Log level: debug, info, warn, error |
| log.format | string | `"json"` | Log format: json or text |
| extraEnv | list | `[]` | Additional environment variables for the container (raw EnvVar entries) |
| extraEnvFrom | list | `[]` | Additional envFrom sources for the container (configMapRef/secretRef entries) |
| ports.http | int | `8080` | Port serving the webhook, /healthz and /readyz |
| ports.metrics | int | `8081` | Port serving Prometheus /metrics |
| serviceAccount.create | bool | `true` | Create a ServiceAccount |
| serviceAccount.name | string | `""` | ServiceAccount name; defaults to the chart fullname when empty |
| serviceAccount.annotations | object | `{}` | ServiceAccount annotations |
| serviceAccount.automountServiceAccountToken | bool | `false` | Automount the ServiceAccount token |
| serviceAccount.imagePullSecrets | list | `[]` | Image pull secrets attached to the ServiceAccount, injected into Pods that use it |
| service.enabled | bool | `true` | Create a Service exposing the webhook and metrics ports |
| service.type | string | `"ClusterIP"` | Service type |
| service.trafficDistribution | string | `""` | Traffic distribution preference, e.g. PreferClose (requires Kubernetes 1.31+); empty omits the field |
| serviceMonitor.enabled | bool | `false` | Create a Prometheus Operator ServiceMonitor |
| serviceMonitor.interval | string | `"30s"` | Scrape interval |
| serviceMonitor.scrapeTimeout | string | `"10s"` | Scrape timeout |
| serviceMonitor.labels | object | `{}` | Extra labels for the ServiceMonitor |
| serviceMonitor.honorLabels | bool | `false` | When true, honorLabels preserves the metric's labels when they collide with the target's labels. |
| serviceMonitor.relabelings | list | `[]` | Prometheus [RelabelConfigs] to apply to samples before scraping |
| serviceMonitor.metricRelabelings | list | `[]` | Prometheus [MetricRelabelConfigs] to apply to samples before ingestion |
| prometheusRule.enabled | bool | `false` | Create a Prometheus Operator PrometheusRule. Requires the monitoring.coreos.com/v1 CRD. |
| prometheusRule.namespace | string | `""` | Namespace for the PrometheusRule; empty uses the release namespace |
| prometheusRule.labels | object | `{}` | Extra labels for the PrometheusRule. Set whatever label the Prometheus instance selects rules by. |
| prometheusRule.annotations | object | `{}` | Annotations for the PrometheusRule |
| prometheusRule.groups | list | `[]` | Rule groups, passed through as written. Empty creates no rule, so enabling this alone alerts on nothing. |
| resources | object | `{"limits":{"memory":"128Mi"},"requests":{"cpu":"25m","memory":"64Mi"}}` | Pod resource requests and limits |
| resizePolicy | list | `[{"resourceName":"cpu","restartPolicy":"NotRequired"},{"resourceName":"memory","restartPolicy":"RestartContainer"}]` | Container resize policy for in-place vertical scaling (requires Kubernetes 1.27+); empty omits the field. CPU resizes in place without a restart; memory resizes restart the container. |
| terminationGracePeriodSeconds | int | `240` | Grace period for shutdown. Must exceed the longer of `kagent.timeout` and `chat.timeout`, plus the 30s drain margin, so a run already in flight still posts its thread reply. |
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

* <https://github.com/younsl/o/tree/main/box/kubernetes/kagent-alert-bridge>

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
