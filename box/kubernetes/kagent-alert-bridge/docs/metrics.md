# Metrics

## Overview

This document describes the Prometheus metrics that kagent-alert-bridge
exposes, what each metric means, and how to use them for dashboards and
alerts.

The bridge publishes metrics on the `/metrics` HTTP path. The default port is
`8081` and can be changed with the `METRICS_PORT` environment variable. All
metric names share the prefix `kagent_alert_bridge_`.

Labels are bounded by configuration or by a fixed set of outcomes. Alert
identity (alertname, fingerprint, group key) is deliberately not a label: it
belongs in the logs, where it costs one line, instead of in a time series,
where it costs one series per alert rule for the whole retention period.

## Metric reference

### Ingest

| Metric | Type | Description |
|--------|------|-------------|
| `kagent_alert_bridge_webhooks_received_total{result}` | Counter | Webhook requests, by outcome. `result` is `analyzing` (alert posted, analysis started), `posted` (alert posted, analysis skipped), `empty` (no alerts in the payload), `bad_request`, `unauthorized`, or `slack_error`. |
| `kagent_alert_bridge_alerts_received_total{severity, status}` | Counter | Individual alerts inside those webhooks. One webhook is one alert group, so this is the only view of real alert volume. An alert with no `severity` of its own inherits the group's. |
| `kagent_alert_bridge_webhook_duration_seconds` | Histogram | Time spent serving one webhook. The analysis runs detached, so this covers decoding, filtering, and the parent post in `post` mode, which is what Alertmanager's own timeout sees. |

### Analysis pipeline

| Metric | Type | Description |
|--------|------|-------------|
| `kagent_alert_bridge_analyses_total{agent,result}` | Counter | Agent runs, by the agent that handled the alert. `result` is `ok`, `error`, or `queue_timeout` when no analysis slot became free in time. |
| `kagent_alert_bridge_analyses_skipped_total{reason}` | Counter | Alert groups posted but not analysed. `reason` is `resolved`, `severity`, or `deduplicated`. |
| `kagent_alert_bridge_analysis_duration_seconds` | Histogram | Wall-clock duration of one agent run as the bridge sees it, around the whole A2A exchange. Buckets from 1s to 300s. |
| `kagent_alert_bridge_analysis_queue_wait_seconds` | Histogram | Time an accepted alert group waited for a free slot before its run started. |
| `kagent_alert_bridge_analyses_inflight` | Gauge | Agent runs currently executing. |
| `kagent_alert_bridge_analyses_queued` | Gauge | Accepted alert groups waiting for a slot. |
| `kagent_alert_bridge_analysis_slots` | Gauge | Configured `MAX_CONCURRENT_ANALYSES`, so saturation reads as a ratio without the query hardcoding the limit. |
| `kagent_alert_bridge_dedupe_entries` | Gauge | Alert groups currently suppressed by the in-memory dedupe store. Expired keys linger until the next webhook sweeps them, so the value can read slightly high between requests. |

### kagent controller (A2A)

| Metric | Type | Description |
|--------|------|-------------|
| `kagent_alert_bridge_agent_task_duration_seconds{agent,state}` | Histogram | Time the controller took to bring one agent's task to a terminal state, measured from the accepted submission to the poll that observed it. `state` is a controller state (`completed`, `failed`, `canceled`, `rejected`, `input-required`, `auth-required`) plus two the bridge adds: `timeout` when the analysis deadline hit first, and `unreachable` when polling was abandoned after repeated failures. |
| `kagent_alert_bridge_agent_task_polls` | Histogram | `tasks/get` reads spent on one task. Together with `KAGENT_POLL_INTERVAL` this shows how much of the analysis latency is polling granularity. |
| `kagent_alert_bridge_agent_requests_total{method, result}` | Counter | A2A JSON-RPC calls, by method (`message/send`, `tasks/get`, `tasks/cancel`) and `ok` or `error`. |
| `kagent_alert_bridge_agent_request_duration_seconds{method}` | Histogram | Latency of one JSON-RPC call. Bounded by `KAGENT_REQUEST_TIMEOUT` and unrelated to how long the analysis itself runs. |

### Slack

| Metric | Type | Description |
|--------|------|-------------|
| `kagent_alert_bridge_slack_messages_total{kind, result}` | Counter | `chat.postMessage` calls as logical outcomes. `kind` is `parent` for an alert the bridge published itself (`post` mode only), `thread` for the analysis reply, and `orphan` for a reply posted at channel level because no thread parent was found; `result` is `ok`, `error`, or `attempted` for the orphan counter. |
| `kagent_alert_bridge_slack_messages_truncated_total{kind}` | Counter | Messages cut to `SLACK_MAX_TEXT` before posting. A truncated `thread` message means part of the analysis never reached the reader. |
| `kagent_alert_bridge_slack_api_requests_total{method, result}` | Counter | Slack Web API attempts, by method (`chat.postMessage`, `conversations.history`, `conversations.list`, `reactions.add`, `reactions.remove`) and `ok`, `rate_limited`, or `error`. Every attempt counts, so retries appear as a gap against `slack_messages_total`. |
| `kagent_alert_bridge_slack_api_request_duration_seconds{method}` | Histogram | Latency of one Slack API attempt. |
| `kagent_alert_bridge_parent_lookups_total{result}` | Counter | Searches for the Alertmanager notification to thread under, by outcome: `found`, `not_found` after every attempt, or `error` for a failure that will not fix itself, such as a missing scope. `lookup` mode only. |
| `kagent_alert_bridge_parent_lookup_attempts` | Histogram | History scans spent on one lookup, capped by `SLACK_LOOKUP_ATTEMPTS`. Rising counts mean the Alertmanager notification keeps landing after the webhook. |

### Build

| Metric | Type | Description |
|--------|------|-------------|
| `kagent_alert_bridge_build_info{version, commit, go_version}` | Gauge | Always 1. Bridge version, git commit, and Go runtime version. |

The Go runtime and process collectors are registered as well, so
`go_goroutines`, `go_memstats_*`, and `process_*` are available on the same
endpoint.

## Example queries

Share of alerts that reach an analysis, which shows how much of the alert
volume the current filter covers:

```promql
sum(rate(kagent_alert_bridge_analyses_total[1h]))
  /
sum(rate(kagent_alert_bridge_webhooks_received_total{result=~"analyzing|posted"}[1h]))
```

Alert volume by severity, which is what the group-level webhook counter hides:

```promql
sum by (severity) (rate(kagent_alert_bridge_alerts_received_total{status="firing"}[1h]))
```

Analysis outcome per agent, which is how a deployment that routes categories
to specialised agents sees one of them failing while the others are healthy:

```promql
sum by (agent, result) (rate(kagent_alert_bridge_analyses_total[1h]))
```

Why analyses are being skipped:

```promql
sum by (reason) (rate(kagent_alert_bridge_analyses_skipped_total[1h]))
```

Analysis latency, which is the delay between the alert landing in Slack and
its thread reply appearing:

```promql
histogram_quantile(0.95,
  sum by (le) (rate(kagent_alert_bridge_analysis_duration_seconds_bucket[30m])))
```

How much of that latency the controller owns, rather than the bridge's own
queueing and Slack calls:

```promql
histogram_quantile(0.95,
  sum by (le) (rate(kagent_alert_bridge_agent_task_duration_seconds_bucket{state="completed"}[30m])))
```

Mean controller processing time per terminal state, which separates a slow
successful investigation from one that spends minutes before failing:

```promql
sum by (state) (rate(kagent_alert_bridge_agent_task_duration_seconds_sum[30m]))
  /
sum by (state) (rate(kagent_alert_bridge_agent_task_duration_seconds_count[30m]))
```

Terminal-state mix, where anything other than `completed` means the alert got
an apology instead of an analysis:

```promql
sum by (state) (rate(kagent_alert_bridge_agent_task_duration_seconds_count[1h]))
```

Saturation of the analysis slots, as a ratio the dashboard does not have to
hardcode:

```promql
max_over_time(kagent_alert_bridge_analyses_inflight[15m])
  /
max_over_time(kagent_alert_bridge_analysis_slots[15m])
```

Queueing delay, which is the part of the wait that the concurrency limit
causes rather than the agent:

```promql
histogram_quantile(0.95,
  sum by (le) (rate(kagent_alert_bridge_analysis_queue_wait_seconds_bucket[30m])))
```

Slack API health per method, including the throttling that a successful retry
would otherwise hide:

```promql
sum by (method, result) (rate(kagent_alert_bridge_slack_api_requests_total[15m]))
```

Thread parents that could not be found, which means analyses are landing at
channel level instead of under their alert:

```promql
sum(rate(kagent_alert_bridge_parent_lookups_total{result!="found"}[1h]))
```

A steady `result="error"` here is a configuration fault rather than a timing
one, usually a missing `channels:history` scope or a bot that is not a member
of the channel. A rising `parent_lookup_attempts` instead means the lookup
still succeeds but only after retrying, so `SLACK_LOOKUP_ATTEMPTS` and the
backoff are absorbing an Alertmanager delivery delay.

## Alerting hints

In `post` mode an alert that never reaches Slack is invisible, which makes the
parent-message failure rate the one signal worth paging on:

```promql
sum(rate(kagent_alert_bridge_slack_messages_total{kind="parent",result="error"}[10m])) > 0
```

In `lookup` mode Alertmanager owns that delivery, so the equivalent signal is
its own, not the bridge's.

Sustained analysis failures are worth a warning rather than a page: the alert
itself still gets posted, only the automated investigation is missing.

```promql
sum(rate(kagent_alert_bridge_analyses_total{result!="ok"}[30m]))
  /
sum(rate(kagent_alert_bridge_analyses_total[30m])) > 0.5
```

Split that between the bridge and the controller before touching either. A
warning that concentrates in one controller state names the fault directly:

```promql
sum(rate(kagent_alert_bridge_agent_task_duration_seconds_count{state=~"timeout|unreachable"}[30m])) > 0
```

`timeout` means `KAGENT_TIMEOUT` is shorter than the investigation needs, and
`unreachable` means the controller went away mid-run, which a restart or an
evicted pod explains.

Truncated analyses are silent information loss, so they deserve a warning even
though nothing failed:

```promql
sum(rate(kagent_alert_bridge_slack_messages_truncated_total{kind="thread"}[1h])) > 0
```

`queue_timeout` appearing at all means alerts arrive faster than
`MAX_CONCURRENT_ANALYSES` can absorb, so either the limit or the severity
filter needs adjusting. `analyses_queued` staying above zero is the earlier
warning for the same condition.
