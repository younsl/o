# kagent-alert-bridge

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-kagent--alert--bridge-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/kagent-alert-bridge)
[![Helm Chart](https://img.shields.io/badge/ghcr.io-charts%2Fkagent--alert--bridge-black?style=flat-square&logo=helm&logoColor=white)](https://github.com/younsl/o/pkgs/container/charts%2Fkagent-alert-bridge)
[![Go](https://img.shields.io/badge/go-1.26.5-black?style=flat-square&logo=go&logoColor=white)](https://go.dev/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

Receives Alertmanager webhooks, posts each alert to Slack, asks a
[kagent](https://kagent.dev) agent to investigate it over A2A, and replies with
the analysis in the alert's own thread. Built with Go 1.26 and shipped as a
statically linked binary on a scratch image.

## How it works

Alertmanager keeps posting alerts through its own `slack_configs`. The bridge
receives the same notification as a webhook, investigates it, and replies in
that alert's thread.

![Architecture](docs/architecture.svg)

1. Alertmanager posts the alert and, independently, POSTs the group to the
   webhook.
2. Alerts the filter rejects end there: the bridge makes no Slack call at all.
3. Otherwise the bridge submits the alert to the agent as a non-blocking A2A
   `message/send` and polls `tasks/get` until the task finishes. When the
   analysis deadline expires first, the task is cancelled with `tasks/cancel`
   so it stops consuming model tokens.
4. The bridge searches recent channel history for the alert's marker to obtain
   the parent timestamp, then replies in that thread.

An incoming webhook does not return the timestamp that `thread_ts` requires,
so the message Alertmanager posted has to be found again. The join key is the
first alert's fingerprint, rendered into the Slack template's `footer` field:
`slack_configs` has no access to `block_id`, so a visible field is the only
carrier available. The search runs after the analysis rather than before it,
which gives the notification the whole agent run to arrive and usually makes
one call enough.

If the search still fails, the analysis is posted at channel level with the
alert title instead of being discarded.

Setting `SLACK_PARENT_MODE=post` inverts the arrangement: the bridge publishes
the alert itself, the timestamp is known without any search, and Alertmanager
sends only the webhook. That mode needs `chat:write` alone, at the cost of
moving the alert formatting out of the Alertmanager templates.

Only the alert group's first analysis is paid for: a group stays deduplicated
for `DEDUPE_TTL`, which should cover the Alertmanager `repeat_interval`. A run
that fails is not suppressed, so the next resend retries it.

## Slack app

The bridge needs a bot token (`xoxb-...`). App-level tokens (`xapp-...`), a
signing secret, and event subscriptions are not used: Slack never calls the
bridge.

Bot token scopes:

| Scope | Needed when |
|-------|-------------|
| `chat:write` | Always. |
| `channels:history` | `lookup` mode, public channels. |
| `channels:read` | `lookup` mode, when channels are configured by name. Configuring conversation IDs instead skips the name lookup and this scope. Public channels are resolved with this scope alone; private channels are only listed when the name is not public. |
| `groups:history`, `groups:read` | `lookup` mode, private channels. |
| `reactions:write` | The investigating/completed reactions on the alert notification. Set `SLACK_INVESTIGATING_REACTION` and `SLACK_COMPLETED_REACTION` to empty to disable them and drop this scope. |

The bot must be a member of every channel it reads or posts in.

## Configuration

All settings come from environment variables.

### Slack

| Variable | Default | Description |
|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | required | Bot token (`xoxb-...`). |
| `SLACK_DEFAULT_CHANNEL` | required | Channel used when the routing label is absent. A bare name is prefixed with `#`; a conversation ID is used as-is. |
| `SLACK_PARENT_MODE` | `lookup` | How the thread parent is obtained. `lookup` finds the message Alertmanager posted; `post` publishes the alert from the bridge. |
| `SLACK_LOOKUP_WINDOW` | `15m` | How far back channel history is searched. `lookup` mode only. |
| `SLACK_LOOKUP_ATTEMPTS` | `3` | How many times to re-search before giving up. `lookup` mode only. |
| `SLACK_INVESTIGATING_REACTION` | `telescope` | Emoji (without colons) placed on the alert notification while the agent investigates. Empty disables it. |
| `SLACK_COMPLETED_REACTION` | `white_check_mark` | Emoji (without colons) that replaces the investigating reaction once the analysis is posted. Empty disables it. When the reactions are enabled, a fixed thread note announcing the investigation is posted as well. |
| `SLACK_CHANNEL_LABEL` | `slack_channel` | Alert label that selects the destination channel. |
| `SLACK_CHANNEL_MAP` | empty | `label-value=channel` pairs, comma separated, for labels whose value is not the channel name. |
| `SLACK_MAX_TEXT` | `8000` | Maximum characters per message; longer text is truncated. |
| `SLACK_API_URL` | `https://slack.com/api` | Web API base URL. Override to route through an egress proxy. |

### kagent

| Variable | Default | Description |
|----------|---------|-------------|
| `KAGENT_URL` | `http://kagent-controller.kagent:8083` | Controller base URL. |
| `KAGENT_NAMESPACE` | `kagent` | Namespace of the Agent resource. |
| `KAGENT_AGENT` | `alert-triage-agent` | Agent used when the routing label is absent or names no mapped agent. |
| `KAGENT_AGENT_ROUTING_LABEL` | value of `SLACK_CHANNEL_LABEL` | Alert label that routes an alert to an agent. |
| `KAGENT_AGENT_ROUTING_MAP` | empty | `label-value=agent` routing table sending categories to specialised agents, e.g. `security-alerts=security-alert-triage-agent`. A value the table does not carry falls back to `KAGENT_AGENT` rather than being used as an agent name. |
| `KAGENT_USER_ID` | `alert-bridge@kagent.dev` | Sent as `X-User-Id`; owns the kagent sessions the bridge creates. |
| `KAGENT_TIMEOUT` | `120s` | Deadline for one whole analysis. On expiry the task is cancelled on the controller. |
| `KAGENT_REQUEST_TIMEOUT` | `30s` | Timeout for a single HTTP call to the controller (submit, poll, or cancel). |
| `KAGENT_POLL_INTERVAL` | `5s` | Wait between two task status polls. |

### Analysis policy

| Variable | Default | Description |
|----------|---------|-------------|
| `ANALYZE_SEVERITIES` | `critical` | Comma-separated severities to analyse. Empty analyses everything. |
| `ANALYZE_LABEL` | `analyze` | Alert label that opts a rule in (`"true"`) or out (`"false"`) regardless of severity. |
| `ANALYZE_RESOLVED` | `false` | Analyse resolved notifications as well as firing ones. |
| `DEDUPE_TTL` | `12h` | How long a group stays suppressed after being analysed. `0s` disables deduplication. |
| `MAX_ALERTS_IN_PROMPT` | `5` | Maximum alerts rendered into one prompt. |
| `MAX_CONCURRENT_ANALYSES` | `2` | Maximum analyses running at once, which bounds concurrent model spend. |
| `ANALYSIS_INSTRUCTIONS` | built-in English text | Instructions appended to every prompt. Override to change the output language or sections. |

### Serving

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_PATH` | `/alert` | Path Alertmanager posts to. |
| `WEBHOOK_BEARER_TOKEN` | empty | Bearer token required on incoming webhooks. Empty disables authentication. |
| `LISTEN_PORT` | `8080` | Port serving the webhook, `/healthz` and `/readyz`. |
| `METRICS_PORT` | `8081` | Port serving `/metrics`. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `LOG_FORMAT` | `json` | `json` or `text`. |

## Metrics

Metrics are served on `/metrics` (default port `8081`) and share the prefix
`kagent_alert_bridge_`. They cover the whole path an alert takes: webhook
ingest and per-alert volume, the analysis queue and its concurrency limit, the
kagent controller's own processing time per task state, and every Slack Web API
call including throttling and truncation. See
[docs/metrics.md](docs/metrics.md) for the full reference and example queries.

## Alertmanager

In `lookup` mode the existing `slack_configs` stays, a `webhook_configs` entry
is added next to it, and the template gains a `footer` carrying the alert
fingerprint so the bridge can recognise the message:

```yaml
receivers:
- name: 'infra-alerts'
  slack_configs:
  - api_url: '<existing incoming webhook>'
    channel: '#infra-alerts'
    send_resolved: true
    title: '{{ if eq .Status "firing" }}🚨{{ else }}✅{{ end }} [{{ .Status | toUpper }}] {{ .CommonLabels.alertname }}'
    text: |-
      {{ range .Alerts }}
      *Severity:* {{ .Labels.severity }}
      *Summary:* {{ .Annotations.summary }}
      {{ end }}
    footer: 'alert-id {{ (index .Alerts 0).Fingerprint }}'
  webhook_configs:
  - url: 'http://kagent-alert-bridge.kagent:8080/alert'
    send_resolved: false
    http_config:
      authorization:
        type: Bearer
        credentials_file: /etc/alertmanager/secrets/kagent-alert-bridge/WEBHOOK_BEARER_TOKEN
```

Without the `footer` the bridge has nothing to match on and every analysis is
posted at channel level instead of in a thread. The marker may live in the
title, text, or fallback instead; the footer is simply the least intrusive
place. Both deliveries must resolve to the same channel, so
`SLACK_CHANNEL_MAP` has to agree with what `slack_configs` uses.

In `post` mode the receiver carries `webhook_configs` alone. Leaving
`slack_configs` in place there posts every alert to Slack twice.

Set `send_resolved: true` on the webhook only together with
`ANALYZE_RESOLVED`, otherwise the bridge is woken for notifications it will
never analyse.

## Agent expectations

The bridge is agent-agnostic: it sends the alert plus `ANALYSIS_INSTRUCTIONS`
and posts whatever text comes back. The agent should be read-only. The bridge
cannot enforce that, so the tools bound to the agent decide what an
automatically triggered analysis is able to touch.

Reply text is posted as Slack mrkdwn, so the agent should use `*bold*` rather
than markdown headings and stay inside `SLACK_MAX_TEXT`.

### Routing to several agents

`KAGENT_AGENT_ROUTING_MAP` splits alert categories across specialised agents, keyed by
the same label that already routes the Slack channel:

```
SLACK_CHANNEL_LABEL=slack_channel
KAGENT_AGENT_ROUTING_MAP=infra-alerts=aws-alert-triage-agent,security-alerts=security-alert-triage-agent
```

Every agent still gets the same `ANALYSIS_INSTRUCTIONS`, because those describe
the output contract the bridge posts to Slack: the sections, the length, and
the mrkdwn. What each agent knows and which tools it may call belongs in its own
system message and tool list, which the bridge never sees. Keeping the split
there also keeps the instructions free of guidance that only one category needs.

## Usage

```bash
# Local run against a port-forwarded controller
kubectl -n kagent port-forward svc/kagent-controller 8083:8083

SLACK_BOT_TOKEN=xoxb-... SLACK_DEFAULT_CHANNEL=alerts-test \
KAGENT_URL=http://localhost:8083 LOG_FORMAT=text make run

# Replay an alert
curl -X POST localhost:8080/alert -H 'Content-Type: application/json' -d '{
  "groupKey": "test-1", "status": "firing", "receiver": "kagent-alert-bridge",
  "commonLabels": {"alertname": "KubePodCrashLooping", "severity": "critical", "cluster": "prd"},
  "alerts": [{"status": "firing", "fingerprint": "fp-1",
    "labels": {"alertname": "KubePodCrashLooping", "severity": "critical", "namespace": "demo", "pod": "demo-api-0"},
    "annotations": {"summary": "pod is restarting", "description": "7 restarts in 10 minutes"}}]
}'
```

## Helm

```bash
helm install kagent-alert-bridge ./charts/kagent-alert-bridge \
  --namespace kagent \
  --set slack.parentMode=lookup \
  --set slack.defaultChannel=alerts-test \
  --set slack.existingSecret=kagent-alert-bridge-slack \
  --set kagent.agent=alert-triage-agent \
  --set serviceMonitor.enabled=true
```

The chart is also released to the OCI registry on Chart.yaml version bumps:

```bash
crane ls ghcr.io/younsl/charts/kagent-alert-bridge
helm install kagent-alert-bridge oci://ghcr.io/younsl/charts/kagent-alert-bridge --version 0.1.0
```
