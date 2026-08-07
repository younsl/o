# Grafana annotations

## Overview

This document explains how external-ebs-autoresizer posts annotations to
Grafana. It describes when annotations are posted, what each one carries, how to
choose which outcomes are recorded, and how to make them appear on a dashboard.

Read this if you are:

- A platform or DevOps engineer who wants resize events marked on Grafana
  dashboards next to the disk-usage graphs they affect.
- Anyone wiring this addon into existing Grafana dashboards.

You do not need to read the source code to follow this document. Basic
familiarity with Grafana dashboards is enough.

## Background

The addon runs as a long-lived Deployment inside EKS. On a fixed interval it
scans standalone EC2 instances, measures their root disk usage, and grows the
root EBS volume when usage crosses a threshold.

Annotations are separate from metrics and alerts. Metrics (see
[metrics.md](metrics.md)) give you continuous numbers to chart. Alerts (see
[alerting.md](alerting.md)) notify you through Alertmanager. Annotations
described here are push-based vertical markers drawn directly on your Grafana
graphs, so you can see the exact moment a volume was grown right where the
usage line drops.

Annotations are pushed to the Grafana HTTP API at `POST /api/annotations`. They
are global and tag-based: the addon does not target a specific dashboard. Any
dashboard that subscribes to the configured tags renders the markers. Annotating
is disabled by default and turns on only when you set an enable flag, a URL, and
a service account token.

## How annotations are posted

The addon posts one annotation per resize attempt.

### Completed resize (region annotation)

When a volume is grown and its filesystem is fully extended, the addon posts a
region annotation spanning the time the resize took (`time` to `timeEnd`). On a
graph this renders as a shaded band, so you can see both when the resize
happened and how long it ran.

The annotation text reports the instance, device, new size in GiB, and the root
filesystem usage before and after the resize.

### Failed resize (point annotation)

When any step of a resize fails (a failed `ec2:ModifyVolume`, a volume that
never reached `optimizing`, or a failed filesystem extension over SSM), the
addon posts a point annotation at the time the resize started. On a graph this
renders as a single vertical line.

The annotation text reports the instance, device, pre-resize usage, and the
cause of the failure.

A resize that is only starting is never annotated, to avoid noise. You see a
marker when a resize succeeds or fails, not when it begins.

## Tags

Every annotation carries the configured base tags followed by per-annotation
tags. Tags are flat `key:value` strings, which is the convention dashboards
filter on.

| Tag | Role | Example |
|-----|------|---------|
| `event:ebs-resize` | Base subscription tag. Dashboards filter on this. | `event:ebs-resize` |
| `instance_id:<id>` | EC2 instance ID | `instance_id:i-0abc123` |
| `instance_name:<name>` | Value of the instance `Name` tag | `instance_name:web-01` |
| `volume_id:<id>` | Root EBS volume ID | `volume_id:vol-0abc123` |
| `device:<name>` | Root device name | `device:/dev/xvda` |
| `result:<outcome>` | `success` or `failure` | `result:success` |

The base tags come from `GRAFANA_ANNOTATION_TAGS` (default `event:ebs-resize`).
Set more than one as a comma-separated list, for example
`event:ebs-resize,app:external-ebs-autoresizer`, when you want a sender tag too.

## Displaying annotations on a dashboard

Posting an annotation only stores it in Grafana. A dashboard shows nothing until
it has an annotation query that subscribes to the tags. This is a one-time setup
per dashboard.

1. Open the dashboard, then **Settings (gear icon) -> Annotations -> Add
   annotation query**.
2. Set **Data source** to `-- Grafana --` (the built-in source that reads stored
   annotations).
3. Set **Filter by** to `Tags` and add the tag `event:ebs-resize`.
4. Save the dashboard.

Every resize now appears as a marker on the dashboard's time-series panels.

### Filtering further

Because tag filters are combined with AND, you can narrow what a dashboard shows
by adding more tags to the query:

- Add `instance_id:i-0abc123` to show resizes for one instance only.
- Add `result:failure` to show only failed resizes.

### Limiting to specific panels

By default an annotation query draws markers on every time-series panel in the
dashboard. To restrict it to chosen panels (for example only the disk-usage
panel), use the annotation query's **Show in** / panel filter option and select
the panels. This filters display only; the data scope is still set by the tags.

Note that only time-aware visualizations (Time series, Graph, State timeline)
render annotation markers. Stat, Table, and Gauge panels do not.

## Authentication

The addon authenticates to Grafana with a service account token sent as a
`Bearer` credential.

1. In Grafana, go to **Administration -> Users and access -> Service accounts**
   and create a service account with the **Editor** role. Editor is the minimum
   basic role that can create annotations (`annotations:create`); Viewer can
   only read them, and Admin grants more than is needed. On Enterprise or Cloud
   you can instead assign a custom RBAC role that grants `annotations:create`.
2. Create a token for that service account and copy it.
3. Provide the token to the addon through the chart (see Configuration). The
   token is read from the environment only, never passed as a process argument,
   and is never logged.

## Delivery guarantees

Delivery is best-effort. If a POST to Grafana fails, the error is logged and the
reconcile continues. A failed or slow Grafana never blocks a resize, never fails
a reconcile pass, and never causes a retry. Each POST is bounded by a timeout
(default `5s`).

The consequence is that annotating can drop a marker if Grafana is unreachable
at the moment of a resize. Treat annotations as a convenient visual aid, not as
an audit log. For a durable record, use the metrics in [metrics.md](metrics.md),
which survive a Grafana outage.

## Configuration

Annotating is controlled by environment variables, which the Helm chart sets
from `config.grafanaAnnotation` values.

| Environment variable | Helm value | Default | Meaning |
|----------------------|------------|---------|---------|
| `GRAFANA_ANNOTATION_ENABLED` | `config.grafanaAnnotation.enabled` | `false` | Enable annotating; requires a URL and token when true |
| `GRAFANA_URL` | `config.grafanaAnnotation.url` | `http://grafana.monitoring:3000` | Grafana base URL; the addon appends `/api/annotations` |
| `GRAFANA_API_TOKEN` | (token, see below) | (empty) | Grafana service account token |
| `GRAFANA_TIMEOUT` | `config.grafanaAnnotation.timeout` | `5s` | Timeout for each annotation POST |
| `GRAFANA_ANNOTATION_TAGS` | `config.grafanaAnnotation.tags` | `event:ebs-resize` | Comma-separated base tags merged into every annotation |
| `GRAFANA_ANNOTATE_ON` | `config.grafanaAnnotation.annotateOn` | `all` | Which outcomes to annotate: `all`, `success`, or `failure` |

When `GRAFANA_ANNOTATION_ENABLED` is `true`, both `GRAFANA_URL` and
`GRAFANA_API_TOKEN` are required; the addon refuses to start otherwise.

### Providing the token

The token is sensitive, so it is never put in the ConfigMap. Choose one of:

- **Generated Secret**: set `config.grafanaAnnotation.apiToken`. The chart
  creates a Secret named `<release>-grafana-annotation` and injects the token
  into `GRAFANA_API_TOKEN`. Convenient, but the token ends up in your values.
- **Existing Secret (recommended for production)**: create the Secret yourself
  and set `config.grafanaAnnotation.existingSecret` to its name and
  `config.grafanaAnnotation.existingSecretKey` to the key (default `token`). The
  chart references it without storing the token in values.

### Enabling through Helm

With a generated Secret:

```bash
helm install external-ebs-autoresizer \
  oci://ghcr.io/younsl/charts/external-ebs-autoresizer \
  --namespace kube-system \
  --set config.grafanaAnnotation.enabled=true \
  --set config.grafanaAnnotation.url=http://grafana.monitoring:3000 \
  --set config.grafanaAnnotation.apiToken=<service-account-token>
```

With an existing Secret, in a `values.yaml` file:

```yaml
config:
  grafanaAnnotation:
    # Enable annotating. url and a token are required when this is true.
    enabled: true
    # Grafana base URL. The addon appends /api/annotations.
    url: http://grafana.monitoring:3000
    # Timeout for each annotation POST, as a Go duration.
    timeout: 5s
    # Base tags merged into every annotation and subscribed to by dashboards.
    tags: event:ebs-resize
    # Which outcomes to annotate: all, success, or failure.
    annotateOn: all
    # Read the token from a Secret you manage.
    existingSecret: grafana-annotation-token
    existingSecretKey: token
```

```bash
helm install external-ebs-autoresizer \
  oci://ghcr.io/younsl/charts/external-ebs-autoresizer \
  --namespace kube-system \
  -f values.yaml
```

The `monitoring` namespace and `grafana` service in the URL above match a
kube-prometheus-stack install. Adjust the host to match your own Grafana
Service. If Grafana runs in a different namespace from the addon, use the fully
qualified name, for example
`http://grafana.monitoring.svc.cluster.local:3000`.

## Conclusion

The addon pushes one annotation per resize: a region annotation when a resize
completes and a point annotation when one fails, each tagged with
`event:ebs-resize` plus the instance, volume, device, and result. You choose
which outcomes to record with `GRAFANA_ANNOTATE_ON`, and you make them appear by
adding a tag-based annotation query to any dashboard.

Keep two things in mind: annotations are global and tag-based rather than tied
to one dashboard, and delivery is best-effort. For continuous monitoring and a
durable history, pair annotations with the metrics described in
[metrics.md](metrics.md).
