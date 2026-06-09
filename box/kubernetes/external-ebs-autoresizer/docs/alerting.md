# Alerting

## Overview

This document explains how external-ebs-autoresizer sends alerts to
Alertmanager. It describes when alerts fire, what each alert carries, how to
choose which outcomes are reported, and how Alertmanager handles them.

Read this if you are:

- A platform or DevOps engineer who wants to be notified when a root volume is
  resized or when a resize fails.
- An on-call engineer who needs to understand an alert that just fired.
- Anyone wiring this addon into an existing Alertmanager routing tree.

You do not need to read the source code to follow this document. Basic
familiarity with Prometheus Alertmanager is enough.

## Background

The addon runs as a long-lived Deployment inside EKS. On a fixed interval it
scans standalone EC2 instances, measures their root disk usage, and grows the
root EBS volume when usage crosses a threshold. Each volume that is grown also
has its filesystem extended in place.

Alerting is separate from metrics. Metrics (see [metrics.md](metrics.md)) give
you continuous numbers to chart and write your own Prometheus alert rules
against. The alerting described here is push-based: the addon itself posts an
alert to Alertmanager at the moment a resize completes or fails, so you get a
notification without writing any rules.

Alerts are pushed to the Alertmanager v2 API at `POST /api/v2/alerts`. Alerting
is disabled by default and turns on only when you set both an enable flag and a
URL.

## Alert types

The addon sends one of two alerts per resize attempt.

### EBSRootVolumeAutoresizeCompleted

- Severity: `info`
- Fires when: a volume was grown and its filesystem was fully extended.

The `summary` annotation is `EBS root volume autoresize completed`. The
`description` reports the instance, device, new size in GiB, and the root
filesystem usage before and after the resize.

### EBSRootVolumeAutoresizeFailed

- Severity: `warning`
- Fires when: any step of a resize failed. This covers a failed
  `ec2:ModifyVolume` call, a volume that never reached the `optimizing` state,
  or a failed filesystem extension over SSM.

The `summary` annotation is `EBS root volume autoresize failed`. The
`description` reports the instance, device, pre-resize usage, and the cause of
the failure. The volume is not grown on failure, so only the pre-resize usage is
reported.

A resize that is only starting is never alerted, to avoid noise. You learn about
a resize when it succeeds or fails, not when it begins.

## Alert template examples

The `summary` is fixed per alert type. The `description` is rendered at runtime
from the instance and the outcome, so the values below are illustrative. Each
example uses instance `i-0abc123` (`Name` tag `web-01`) with root device
`/dev/xvda`.

### Completed

A volume grown from a disk at 85% to a new size of 110 GiB, measured at 64%
afterward.

| Annotation | Value |
|------------|-------|
| `summary` | `EBS root volume autoresize completed` |
| `description` | `Instance i-0abc123 (web-01) device /dev/xvda was autoresized to 110 GiB. Root filesystem usage changed from 85% to 64%.` |

### Failed: ModifyVolume rejected

The `ec2:ModifyVolume` call itself failed, for example because the volume was
modified less than 6 hours ago or an IAM permission is missing.

| Annotation | Value |
|------------|-------|
| `summary` | `EBS root volume autoresize failed` |
| `description` | `Instance i-0abc123 (web-01) device /dev/xvda failed to autoresize at 85% root filesystem usage. Cause: ModifyVolume failed: <aws error>.` |

### Failed: volume never reached optimizing

The modification was accepted but the volume did not reach the `optimizing`
state within `VOLUME_MODIFY_TIMEOUT`, so the filesystem extension was not
attempted.

| Annotation | Value |
|------------|-------|
| `summary` | `EBS root volume autoresize failed` |
| `description` | `Instance i-0abc123 (web-01) device /dev/xvda failed to autoresize at 85% root filesystem usage. Cause: volume did not reach optimizing: <timeout>.` |

### Failed: filesystem extension failed

The volume grew but extending the filesystem over SSM (`growpart` + `resize2fs`
or `xfs_growfs`) failed, for example because the SSM command timed out or the
instance is not SSM-managed.

| Annotation | Value |
|------------|-------|
| `summary` | `EBS root volume autoresize failed` |
| `description` | `Instance i-0abc123 (web-01) device /dev/xvda failed to autoresize at 85% root filesystem usage. Cause: filesystem resize failed: <ssm error>.` |

Note that the failure description always reports the pre-resize usage (85% here),
since the disk is not measured again after a failure. The `Cause:` clause is the
only part that distinguishes the three failure modes; route on `alertname` and
`severity`, not on description text.

## Labels and annotations

Every alert carries these identifying labels so you can tell exactly which disk
it belongs to:

| Label | Meaning |
|-------|---------|
| `alertname` | `EBSRootVolumeAutoresizeCompleted` or `EBSRootVolumeAutoresizeFailed` |
| `severity` | `info` for a completion, `warning` for a failure |
| `instance_id` | EC2 instance ID, for example `i-0abc123` |
| `instance_name` | Value of the instance `Name` tag |
| `volume_id` | Root EBS volume ID, for example `vol-0abc123` |
| `device` | Root device name, for example `/dev/xvda` |

On top of these, any static labels you configure (see Configuration) are merged
into every alert for routing, for example `cluster=prod` or `env=production`.
Per-alert labels take precedence over static ones if a key collides.

Each alert also carries a `summary` annotation, and a `description` annotation
when one applies.

## Notify-on policy

`ALERTMANAGER_NOTIFY_ON` selects which outcomes are sent:

| Value | Alerts sent |
|-------|-------------|
| `success` (default) | completions only (`info`) |
| `failure` | failures only (`warning`) |
| `all` | both completions and failures |

Use `failure` if you only want to be paged when something breaks, and `all` if
you want a record of every resize.

## Auto-resolution

Each alert is posted with only a `startsAt` timestamp and no `endsAt`. This
makes every resize a one-shot event rather than a long-lived firing alert.
Alertmanager auto-resolves the alert on its own once the alert is no longer
re-sent, after the `resolve_timeout` configured in your Alertmanager (default
`5m`). The addon does not send an explicit resolve.

This means you should treat these alerts as point-in-time notifications. A
firing `EBSRootVolumeAutoresizeFailed` does not mean a volume is still broken
right now; it means a resize failed at `startsAt`.

## Delivery guarantees

Delivery is best-effort. If a POST to Alertmanager fails, the error is logged
and the reconcile continues. A failed or slow Alertmanager never blocks a
resize, never fails a reconcile pass, and never causes a retry. Each POST is
bounded by a timeout (default `5s`).

The consequence is that alerting can drop a notification if Alertmanager is
unreachable at the moment of a resize. Treat these alerts as convenient
notifications, not as an audit log. For a durable record, use the metrics in
[metrics.md](metrics.md), which survive an Alertmanager outage.

## Configuration

Alerting is controlled by environment variables, which the Helm chart sets from
`config.alertmanager` values.

| Environment variable | Helm value | Default | Meaning |
|----------------------|------------|---------|---------|
| `ALERTMANAGER_ENABLED` | `config.alertmanager.enabled` | `false` | Enable alerting; requires a URL when true |
| `ALERTMANAGER_URL` | `config.alertmanager.url` | (empty) | Alertmanager v2 base URL, for example `http://alertmanager-operated.monitoring:9093` |
| `ALERTMANAGER_TIMEOUT` | `config.alertmanager.timeout` | `5s` | Timeout for each alert POST |
| `ALERTMANAGER_LABELS` | `config.alertmanager.labels` | (empty) | `Key=Value,Key2=Value2` static labels merged into every alert for routing |
| `ALERTMANAGER_NOTIFY_ON` | `config.alertmanager.notifyOn` | `success` | Which outcomes to alert: `all`, `success`, or `failure` |

When `ALERTMANAGER_ENABLED` is `true`, `ALERTMANAGER_URL` is required; the addon
refuses to start otherwise.

Enable alerting through Helm `--set` flags:

```bash
helm install external-ebs-autoresizer \
  oci://ghcr.io/younsl/charts/external-ebs-autoresizer \
  --namespace kube-system \
  --set config.alertmanager.enabled=true \
  --set config.alertmanager.url=http://alertmanager-operated.monitoring:9093 \
  --set config.alertmanager.notifyOn=all \
  --set config.alertmanager.labels=cluster=prod
```

Or in a `values.yaml` file, which is easier to read once you set more than one
or two fields:

```yaml
config:
  alertmanager:
    # Enable alerting. url is required when this is true.
    enabled: true
    # Alertmanager v2 base URL. The addon appends /api/v2/alerts.
    url: http://alertmanager-operated.monitoring:9093
    # Timeout for each alert POST, as a Go duration.
    timeout: 5s
    # Which outcomes to alert: all, success, or failure.
    notifyOn: all
    # Static labels merged into every alert for routing, as Key=Value pairs.
    labels: cluster=prod,env=production
```

```bash
helm install external-ebs-autoresizer \
  oci://ghcr.io/younsl/charts/external-ebs-autoresizer \
  --namespace kube-system \
  -f values.yaml
```

The `monitoring` namespace and `alertmanager-operated` service in the URL above
match a kube-prometheus-stack install. Adjust the host to match your own
Alertmanager Service. If Alertmanager runs in a different namespace from the
addon, use the fully qualified name, for example
`http://alertmanager-operated.monitoring.svc.cluster.local:9093`.

## Routing example

Because every alert carries `alertname` and `severity`, you can route the two
alert types differently in your Alertmanager configuration. The example below
pages on failures and sends completions to a quieter channel:

```yaml
route:
  routes:
    - matchers:
        - alertname = "EBSRootVolumeAutoresizeFailed"
      receiver: pager
    - matchers:
        - alertname = "EBSRootVolumeAutoresizeCompleted"
      receiver: slack-info
```

If you set a static `cluster` label through `ALERTMANAGER_LABELS`, you can also
match on it to fan alerts from multiple clusters into per-cluster receivers.

## Conclusion

The addon pushes two alerts: an `info` alert when a resize completes and a
`warning` alert when one fails. You choose which to receive with
`ALERTMANAGER_NOTIFY_ON`, route them by `alertname` and `severity`, and identify
the affected disk from the `instance_id`, `volume_id`, and `device` labels.

Keep two things in mind: alerts auto-resolve as one-shot events rather than
staying firing, and delivery is best-effort. For continuous monitoring and a
durable history, pair alerting with the metrics described in
[metrics.md](metrics.md).
