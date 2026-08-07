# Metrics

## Overview

This document is the reference for every Prometheus metric the daemon exports:
its name, labels, meaning, and the queries that turn them into alerts and
dashboards. It is written for **operators and SREs** running the service —
those building Grafana panels, writing alert rules, or debugging delivery
issues. Familiarity with PromQL is assumed.

The daemon exposes metrics at `GET /metrics` on the admin port
(`ADMIN_ADDR`, default `0.0.0.0:8081`).

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `aws_health_event_received_total` | Counter | `service`, `category`, `region` | Events received from the AWS Health API, before filtering. |
| `aws_health_event_filtered_total` | Counter | `reason` | Events dropped by the in-process filter. |
| `aws_health_event_slack_posts_total` | Counter | `outcome` | Slack webhook delivery attempts. |
| `aws_health_event_k8s_events_total` | Counter | `outcome` | Kubernetes Event creation attempts (only when running in-cluster). |
| `aws_health_event_reminders_sent_total` | Counter | `offset_hours` | Reminders fired, per configured offset. |
| `aws_health_event_poll_cycles_total` | Counter | `outcome` | AWS Health API poll cycles. |

## Label values

- `outcome`: `ok` | `error`.
- `reason` (drop cause): `deny_category` | `deny_service` | `deny_event_code` | `category_not_allowed` | `service_not_allowed` | `event_code_not_allowed` | `cold_start_suppressed`.
- `offset_hours`: the reminder offset that fired (e.g. `24`), from `REMINDER_OFFSETS_HOURS`.

## Notes

- A notification is published only when the Slack post succeeds. The
  Kubernetes Event is then emitted best-effort, so
  `aws_health_event_k8s_events_total{outcome="error"}` can advance while the
  Slack delivery still counts as `ok`.
- `aws_health_event_k8s_events_total` stays flat outside a cluster: emission is
  skipped when the pod identity (`POD_NAME` / `POD_NAMESPACE`, via the Downward
  API) is absent.
- `received_total - filtered_total` approximates the events forwarded per poll
  cycle.

## Example queries

**Slack delivery error rate (5m)** — fraction of webhook posts that failed.
Alert when sustained above a threshold; the primary signal that notifications
are not reaching the channel.

```promql
sum(rate(aws_health_event_slack_posts_total{outcome="error"}[5m]))
  / sum(rate(aws_health_event_slack_posts_total[5m]))
```

**Poll cycle failures** — rate of failed AWS Health API polls. Non-zero means
the daemon is not ingesting events (throttling, auth, or connectivity).

```promql
sum(rate(aws_health_event_poll_cycles_total{outcome="error"}[5m]))
```

**Events received by service** — hourly intake broken down by AWS service.
Useful for spotting which services drive volume and for dashboard breakdowns.

```promql
sum by (service) (rate(aws_health_event_received_total[1h]))
```
