# Metrics

## Overview

This document explains the Prometheus metrics that external-ebs-autoresizer
exposes. It describes what each metric means, which labels it carries, and how
you can use it to watch the addon in production.

Read this if you are:

- A platform or DevOps engineer who runs this addon and wants to build
  dashboards or alerts.
- An on-call engineer who needs to check whether disk resizes are working.
- Anyone who wants to understand the numbers on the `/metrics` endpoint.

You do not need to read the source code to follow this document. Basic
familiarity with Prometheus and PromQL is enough.

## Background

The addon runs as a long-lived Deployment inside EKS. On a fixed interval it
scans standalone EC2 instances, measures their root disk usage, and grows the
root EBS volume when usage crosses a threshold. One full scan is called a
**reconcile pass**, and each instance inside a pass goes through several
**stages** in order:

1. `discover` find the target instances and their root volumes.
2. `measure` run `df` over SSM and read the root usage percent.
3. `cooldown` check that the volume is not inside the 6-hour modify window.
4. `modify` call `ec2:ModifyVolume` to grow the volume.
5. `wait` poll until the modification reaches the `optimizing` state.
6. `resize` extend the filesystem with `growpart` and `resize2fs`.

The addon publishes its metrics on the `/metrics` HTTP path. The default port is
`8081` and can be changed with `METRICS_PORT`. Prometheus scrapes that endpoint
on its own schedule. All metric names share the prefix
`external_ebs_autoresizer_`.

A short reminder on metric types:

- A **gauge** is a value that can go up and down, like a temperature. It always
  reports the latest reading.
- A **counter** only goes up. It resets to zero when the process restarts. You
  usually look at how fast it grows with `rate()`, not at its raw value.

## Metrics

### external_ebs_autoresizer_root_usage_percent

- Type: Gauge
- Labels: `instance_id`, `device`, `volume_id`, `name`

The most recent root filesystem usage percent for one instance. The addon
updates this value every time it measures an instance during a reconcile pass.
A value of `85` means the root disk was 85% full at the last measurement.

The labels tell you exactly which disk the reading belongs to:

| Label | Meaning |
|-------|---------|
| `instance_id` | EC2 instance ID, for example `i-0abc123` |
| `device` | Root device name, for example `/dev/xvda` |
| `volume_id` | Root EBS volume ID, for example `vol-0abc123` |
| `name` | Value of the instance `Name` tag |

Use it to see which instances are close to filling up, and to confirm that usage
drops after a resize.

### external_ebs_autoresizer_resize_total

- Type: Counter
- Labels: `result`

The total number of resize attempts, split by outcome. The `result` label is
either `success` or `failure`. A `success` is counted only after the filesystem
is fully extended. Any failure during `modify`, `wait`, or `resize` is counted
as `failure`.

Use it to track how many resizes happen over time and to catch a rising failure
rate.

### external_ebs_autoresizer_skip_total

- Type: Counter
- Labels: `reason`

The total number of instances that the addon looked at but did not resize,
grouped by why it held back. The `reason` label is one of:

| Reason | Meaning |
|--------|---------|
| `below_threshold` | Root usage was under `USAGE_THRESHOLD_PERCENT`, so nothing was needed. This is the normal healthy case and grows on every pass. |
| `max_size` | The target size would exceed `MAX_VOLUME_SIZE_GIB`, so the volume was left as is. |
| `cooldown` | The volume was modified within the AWS 6-hour window, or is still modifying, so it could not be grown yet. |
| `dry_run` | `DRY_RUN` is enabled, so the addon only logged what it would have done. |

This metric makes the addon's silent decisions visible. `resize_total` and
`error_total` say nothing when an instance is above threshold but skipped, so
without `skip_total` a disk can keep filling up at the `max_size` ceiling with no
signal at all. Watch `reason="max_size"` together with `root_usage_percent` to
catch volumes that are stuck and need a manual size bump.

### external_ebs_autoresizer_error_total

- Type: Counter
- Labels: `stage`

The total number of errors, grouped by the reconcile stage where each error
happened. The `stage` label is one of `discover`, `measure`, `cooldown`,
`modify`, `wait`, or `resize` (see the Background section for what each stage
does).

This metric is more detailed than `resize_total` because it shows *where* things
break. For example, many errors with `stage="measure"` point to an SSM or
permissions problem, not a volume problem.

### external_ebs_autoresizer_reconcile_total

- Type: Counter
- Labels: none

The total number of reconcile passes that have started. It increases by one each
interval (set by `RECONCILE_INTERVAL`, default `5m`).

Use it as a liveness signal. If this counter stops growing, the reconcile loop
has stalled, even if the Pod still looks healthy.

## Example queries

Instances currently above 80% usage:

```promql
external_ebs_autoresizer_root_usage_percent > 80
```

Resize failure rate over the last hour:

```promql
rate(external_ebs_autoresizer_resize_total{result="failure"}[1h])
```

Errors by stage over the last hour:

```promql
sum by (stage) (rate(external_ebs_autoresizer_error_total[1h]))
```

Volumes stuck at the max-size ceiling while still filling up (above 90%):

```promql
rate(external_ebs_autoresizer_skip_total{reason="max_size"}[1h]) > 0
  and on() max(external_ebs_autoresizer_root_usage_percent) > 90
```

Detect a stalled reconcile loop (no new pass in 15 minutes):

```promql
increase(external_ebs_autoresizer_reconcile_total[15m]) == 0
```

## Conclusion

The addon exposes five metrics, and together they answer five simple questions:

- How full are the disks? `root_usage_percent`
- Are resizes succeeding? `resize_total`
- When the addon holds back, why? `skip_total`
- If something fails, where? `error_total`
- Is the loop still running? `reconcile_total`

A good starting point is one dashboard panel per metric, plus three alerts: one
on a rising `resize_total{result="failure"}` rate, one on a stalled
`reconcile_total`, and one on `skip_total{reason="max_size"}` paired with high
`root_usage_percent` to catch disks stuck at the ceiling. From there you can add
per-instance usage views using the labels on `root_usage_percent`.
