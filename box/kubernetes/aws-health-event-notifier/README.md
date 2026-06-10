# aws-health-event-notifier

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-aws--health--event--notifier-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/aws-health-event-notifier)
[![Helm Chart](https://img.shields.io/badge/ghcr.io-charts%2Faws--health--event--notifier-black?style=flat-square&logo=helm&logoColor=white)](https://github.com/younsl/o/pkgs/container/charts%2Faws-health-event-notifier)
[![Rust](https://img.shields.io/badge/rust-1.96.0-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

Polls the [AWS Health API](https://docs.aws.amazon.com/health/latest/ug/health-api.html) and posts events to Slack, emitting a Kubernetes Event alongside each published alarm.

## Overview

A pull-model daemon: the pod queries the AWS Health [DescribeEvents](https://docs.aws.amazon.com/health/latest/APIReference/API_DescribeEvents.html) API on an interval and forwards new events to a Slack Incoming Webhook — no EventBridge rule or push endpoint required. On cold start it suppresses the backlog by default, so a restart never floods the channel with already-seen events. Every published alarm also produces a Kubernetes Event on the daemon's own Pod (resolved via the Downward API), making AWS Health activity visible to kubectl get events and cluster event pipelines.

## Features

- **Pull model**: Polls the AWS Health API directly; no EventBridge or webhook ingress
- **Cold-start suppression**: Populates the dedup cache without sending on restart to prevent replay floods
- **In-process filtering**: Allow/deny by [event type category](https://docs.aws.amazon.com/health/latest/ug/aws-health-concepts-and-terms.html), AWS service code, and `SERVICE/EVENT_TYPE_CODE` pair (e.g. drop `VPN/AWS_VPN_REDUNDANCY_LOSS` while keeping other VPN events); the Helm chart manages all filter settings in a ConfigMap and rolls pods on change
- **Scheduled reminders**: Fires reminders at configurable offsets before a scheduled event's start time
- **Kubernetes Events**: Emits a K8s Event per alarm on its own Pod, best-effort alongside Slack
- **Interactive send**: send subcommand multi-selects recent events and forwards them on demand
- **K8s native**: Helm chart with ServiceMonitor and IRSA/[EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) support
- **Distroless**: musl static binary on scratch, runs as non-root (uid 65532)

## Documentation

- [Metrics](docs/metrics.md) — Prometheus metric list, label values, example queries
- [Helm values](charts/aws-health-event-notifier/values.yaml) — Chart configuration reference

## IAM permissions

The daemon needs read access to the AWS Health API, plus account identity for the message header. Attach this policy to the IRSA/Pod Identity role. [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) is strongly recommended over IRSA for associating the role.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AwsHealthRead",
      "Effect": "Allow",
      "Action": [
        "health:DescribeEvents",
        "health:DescribeEventDetails",
        "health:DescribeEventTypes",
        "health:DescribeAffectedEntities"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AccountIdentityForMessageHeader",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "iam:ListAccountAliases"
      ],
      "Resource": "*"
    }
  ]
}
```

> The AWS Health API requires a Business, Enterprise On-Ramp, or Enterprise Support plan. See [Getting started with the AWS Health API](https://docs.aws.amazon.com/health/latest/ug/health-api.html).

## Configuration

All settings are CLI flags backed by environment variables. Key ones:

| Env | Default | Description |
|-----|---------|-------------|
| SLACK_WEBHOOK_URL | _(required)_ | Slack Incoming Webhook URL |
| POLL_INTERVAL_SECS | 60 | Poll interval |
| INITIAL_LOOKBACK_SECS | 3600 | Cold-start lookback window |
| COLD_START_SUPPRESS | true | Seed dedup without sending on restart |
| ALLOW_CATEGORIES / DENY_CATEGORIES | _(empty)_ | Filter by event type category |
| ALLOW_SERVICES / DENY_SERVICES | _(empty)_ | Filter by AWS service code |
| ALLOW_EVENT_CODES / DENY_EVENT_CODES | _(empty)_ | Filter by `SERVICE/EVENT_TYPE_CODE` pair (e.g. VPN/AWS_VPN_REDUNDANCY_LOSS) |
| REMINDER_OFFSETS_HOURS | 24 | Reminder offsets before start time |
| ADMIN_ADDR | 0.0.0.0:8081 | Admin server (/healthz, /readyz, /metrics) |

## Development

```bash
make build     # Debug build
make test      # Run tests
make lint      # Clippy
make release   # Release build
make local-run # Run daemon locally (cold-start suppress ON)
```

## Related

- [AWS Health API reference](https://docs.aws.amazon.com/health/latest/APIReference/Welcome.html)
- [aws-samples/aws-health-aware](https://github.com/aws-samples/aws-health-aware) — AWS official, EventBridge push model (Python/Lambda)
