# gss

![Version: 0.1.0](https://img.shields.io/badge/Version-0.1.0-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.6.1](https://img.shields.io/badge/AppVersion-0.6.1-informational?style=flat-square)

A Helm chart for deploying the GHES Schedule Scanner

**Homepage:** <https://github.com/younsl/o>

## Installation

### List available versions

This chart is distributed via OCI registry, so you need to use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover available versions:

```console
crane ls ghcr.io/younsl/charts/gss
```

If you need to install crane on macOS, you can easily install it using [Homebrew](https://brew.sh/), the package manager.

```bash
brew install crane
```

### Install the chart

Install the chart with the release name `gss`:

```console
helm install gss oci://ghcr.io/younsl/charts/gss
```

Install with custom values:

```console
helm install gss oci://ghcr.io/younsl/charts/gss -f values.yaml
```

Install a specific version:

```console
helm install gss oci://ghcr.io/younsl/charts/gss --version 0.1.0
```

### Install from local chart

Download gss chart and install from local directory:

```console
helm pull oci://ghcr.io/younsl/charts/gss --untar --version 0.1.0
helm install gss ./gss
```

The `--untar` option downloads and unpacks the chart files into a directory for easy viewing and editing.

## Upgrade

```console
helm upgrade gss oci://ghcr.io/younsl/charts/gss
```

## Uninstall

```console
helm uninstall gss
```

## Configuration

The following table lists the configurable parameters and their default values.

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| nameOverride | string | `""` | Override the chart name |
| fullnameOverride | string | `""` | Override the full name template |
| image | object | `{"pullPolicy":"IfNotPresent","repository":"ghcr.io/younsl/gss","tag":null}` | Container image configuration |
| image.repository | string | `"ghcr.io/younsl/gss"` | Container image repository This value is used to specify the container image repository. |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy (Available values: Always, IfNotPresent, Never) |
| image.tag | string | `nil` | Container image tag (If not set, will use Chart's appVersion by default.) |
| imagePullSecrets | list | `[]` | Image pull secrets for private container registries |
| restartPolicy | string | `"Never"` | Restart policy. Available values: Always, Never, OnFailure (default: Never) |
| suspend | bool | `false` | Suspend the CronJob execution When set to true, all subsequent executions are suspended. This setting does not apply to already started executions. |
| schedule | string | `"0 1 * * *"` | CronJob schedule in Cron format (UTC) This value is used to configure the schedule for the CronJob. Cron expression details: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-7), `*` means all |
| concurrencyPolicy | string | `"Forbid"` | Concurrency policy for CronJob (Available values: Allow, Forbid, Replace) |
| timeZone | string | `"Etc/UTC"` | Timezone for the CronJob This value is used to configure the timezone for the CronJob. Available timezone list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones |
| ttlSecondsAfterFinished | int | `3600` | TTL in seconds for finished jobs This value is used to delete finished jobs after a certain period of time. This helps to reduce the number of old job pods that are kept in the cluster. |
| successfulJobsHistoryLimit | int | `3` | Number of successful jobs to keep in history This value is used to limit the number of successful jobs |
| failedJobsHistoryLimit | int | `1` | Number of failed jobs to keep in history This value is used to limit the number of failed jobs |
| dnsConfig | object | `{}` | DNS config for the CronJob pod |
| annotations | object | `{}` | CronJob annotations annotations are used to configure additional CronJob settings |
| podAnnotations | object | `{}` | Pod annotations annotations are used to configure additional pod settings |
| configMap | object | `{"data":{"CONCURRENT_SCANS":"10","GITHUB_BASE_URL":"https://github.example.com","GITHUB_ORG":"example-org","LOG_LEVEL":"INFO","PUBLISHER_TYPE":"slack-canvas","REQUEST_TIMEOUT":"60","SLACK_CANVAS_ID":null,"SLACK_CHANNEL_ID":null,"SLACK_TOKEN":null},"enabled":true,"name":""}` | ConfigMap data containing application configuration |
| configMap.enabled | bool | `true` | Enable ConfigMap creation |
| configMap.name | string | `""` | External ConfigMap name (used when enabled=false) Set this to use an existing ConfigMap instead of creating one. When configMap.enabled=false, this field is required. |
| configMap.data.GITHUB_ORG | string | `"example-org"` | GitHub Enterprise organization name Organization name is used to scan all repositories for the given organization |
| configMap.data.GITHUB_BASE_URL | string | `"https://github.example.com"` | GitHub Enterprise base URL The API endpoint will be automatically appended with '/api/v3' For example: https://github.example.com/api/v3 |
| configMap.data.LOG_LEVEL | string | `"INFO"` | Application log level |
| configMap.data.REQUEST_TIMEOUT | string | `"60"` | Timeout in seconds for GitHub API requests during repository scanning This applies to all GitHub API calls made while scanning repositories and fetching workflow files. If a request takes longer than this timeout, it will be cancelled and an error will be logged. Recommended value: 30-120 seconds depending on: - GitHub Enterprise Server performance - Repository size (large repos with many workflow files take longer) - Network latency between cluster and GitHub Enterprise Server |
| configMap.data.CONCURRENT_SCANS | string | `"10"` | Number of concurrent repository scans This value is used to limit the number of concurrent goroutines that are scanning repositories. Recommended CONCURRENT_SCANS value depends on several factors: - GitHub API rate limits - GitHub API response time (latency) - Network conditions between your cluster and GitHub Enterprise Typical values range from 10-50, but can be higher if needed. |
| configMap.data.SLACK_TOKEN | string | `nil` | Slack Bot Token to create a canvas page in Slack channel. Do not use a slack app token. How to get: 1. Go to https://api.slack.com/apps 2. Select your app > "OAuth & Permissions" 3. Copy "Bot User OAuth Token" starting with `xoxb-` |
| configMap.data.SLACK_CHANNEL_ID | string | `nil` | Slack Channel ID to create a canvas page in Slack channel How to get: 1. Click channel name in Slack 2. Click "View channel details" 3. Scroll to bottom and copy Channel ID starting with `C` |
| configMap.data.SLACK_CANVAS_ID | string | `nil` | Slack Canvas ID to update a canvas page in Slack channel. Slack Canvas URL have the following format: https://<WORKSPACE>.slack.com/docs/<CHANNEL_ID>/<CANVAS_ID> How to get: 1. Copy the last part from Canvas URL you want to update Canvas URL format: https://workspace.slack.com/docs/CHANNEL_ID/CANVAS_ID |
| configMap.data.PUBLISHER_TYPE | string | `"slack-canvas"` | Publisher type to use (Available values: console, slack-canvas) This value determines which publisher will be used to output scan results |
| secretName | string | `"gss-secret"` | Name of the secret containing sensitive data This secret is used to store the GitHub access token with permissions to scan repositories. |
| resources | object | `{"limits":{"cpu":"100m","memory":"128Mi"},"requests":{"cpu":"50m","memory":"64Mi"}}` | Container resource requirements |
| podSecurityContext | object | `{"fsGroup":1000,"runAsGroup":1000,"runAsNonRoot":true,"runAsUser":1000}` | Pod-level security context This applies to all containers in the pod |
| securityContext | object | `{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]},"readOnlyRootFilesystem":false,"runAsGroup":1000,"runAsNonRoot":true,"runAsUser":1000}` | Container-level security context This applies to the specific container |
| nodeSelector | object | `{}` | Node selector for pod assignment nodeSelector is used to configure additional pod settings |
| tolerations | list | `[]` | Pod tolerations tolerations are used to configure additional pod settings |
| affinity | object | `{}` | Pod affinity settings affinity is used to configure additional pod settings |
| topologySpreadConstraints | list | `[]` | Pod scheduling constraints for spreading pods across nodes or zones topologySpreadConstraints are used to configure additional pod settings |
| excludedRepositoriesList | list | `[]` | List of repositories to exclude from the scan Note: Please exclude the organization name, only the repository name. |

## Source Code

* <https://github.com/younsl/o/tree/main/box/kubernetes/gss>

## Maintainers

| Name | Email | Url |
| ---- | ------ | --- |
| younsl | <cysl@kakao.com> | <https://github.com/younsl> |
| ddukbg | <wowrebong@gmail.com> | <https://github.com/ddukbg> |

## License

This chart is licensed under the Apache License 2.0. See [LICENSE](https://github.com/younsl/o/blob/main/LICENSE) for details.

## Contributing

Contributions are welcome! Please feel free to submit a [Pull Request](https://github.com/younsl/o/pulls).

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
