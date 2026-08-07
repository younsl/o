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
`8081` and can be changed with `metricsPort` in the config file. Prometheus
scrapes that endpoint on its own schedule. All metric names share the prefix
`external_ebs_autoresizer_`.

A short reminder on metric types:

- A **gauge** is a value that can go up and down, like a temperature. It always
  reports the latest reading.
- A **counter** only goes up. It resets to zero when the process restarts. You
  usually look at how fast it grows with `rate()`, not at its raw value.

## Metrics

Every metric name follows the [Prometheus naming
conventions](https://prometheus.io/docs/practices/naming/) and is built from
three parts:

```
external_ebs_autoresizer_<subject>_<unit or suffix>
```

- `external_ebs_autoresizer_` is the application prefix (the Prometheus
  "namespace"). It scopes every metric to this addon, so names never collide
  with other exporters and `{__name__=~"external_ebs_autoresizer_.*"}` finds
  everything the addon exposes.
- `<subject>` says what is measured, for example `root_usage`, `root_volume_size`,
  or `resize`.
- The last part encodes the unit or the type convention: gauges end with their
  unit (`_percent`, `_gib`) or a plain noun (`_instances`), and counters always
  end with `_total`.

So `external_ebs_autoresizer_root_volume_size_gib` reads as: this addon's root
volume size, in GiB.

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

### external_ebs_autoresizer_root_volume_size_gib

- Type: Gauge
- Labels: `instance_id`, `device`, `volume_id`, `name`

The most recent root EBS volume size in GiB for one instance. The addon records
it for every discovered instance on each pass (including paused ones, which are
never measured) and updates it immediately after a successful resize.

The size is deliberately a gauge value rather than a label: a label value change
would start a new time series on every resize and break usage history, while a
gauge keeps the series identity stable and shows each resize as a step in the
graph.

The labels are identical to `root_usage_percent`, so the two gauges join
cleanly. In a Grafana table, query both with instant table-format queries and
combine them with a Merge (or Join by field on `instance_id`) transformation to
show usage percent and volume size side by side. In PromQL you can also compute
absolute usage:

```promql
external_ebs_autoresizer_root_volume_size_gib
  * on (instance_id, device, volume_id, name)
external_ebs_autoresizer_root_usage_percent / 100
```

### external_ebs_autoresizer_resize_total

- Type: Counter
- Labels: `result`, `policy`

The total number of resize attempts, split by outcome and the resize policy that
matched the instance. The `result` label is either `success` or `failure`. A
`success` is counted only after the filesystem is fully extended. Any failure
during `modify`, `wait`, or `resize` is counted as `failure`. The `policy` label
is the matched policy name, or `default` for instances matching no named policy.

Use it to track how many resizes happen over time, to catch a rising failure
rate, and to break both down per policy.

### external_ebs_autoresizer_skip_total

- Type: Counter
- Labels: `reason`, `policy`

The total number of instances that the addon looked at but did not resize,
grouped by why it held back and by the matched policy. The `reason` label is one
of:

| Reason | Meaning |
|--------|---------|
| `below_threshold` | Root usage was under the effective `usageThresholdPercent`, so nothing was needed. This is the normal healthy case and grows on every pass. |
| `max_size` | The target size would exceed the effective `maxVolumeSizeGiB`, so the volume was left as is. |
| `cooldown` | The volume was modified within the AWS 6-hour window, or is still modifying, so it could not be grown yet. |
| `dry_run` | `dryRun` is enabled, so the addon only logged what it would have done. |
| `paused` | The matched policy (or `defaultPolicy`) has `paused: true`, so the instance is out of scope and never measured. |

The `policy` label is the matched policy name, or `default`. This metric makes
the addon's silent decisions visible. `resize_total` and `error_total` say
nothing when an instance is above threshold but skipped, so without `skip_total`
a disk can keep filling up at the `max_size` ceiling with no signal at all.
Watch `reason="max_size"` together with `root_usage_percent` to catch volumes
that are stuck and need a manual size bump.

### external_ebs_autoresizer_policy_instances

- Type: Gauge
- Labels: `policy`

The number of discovered instances each resize policy matched in the latest
reconcile pass. The `policy` label is a named policy or `default` (instances
matching no named policy). Every configured policy is reported each pass, set to
`0` when it matches nothing, so a policy whose selector stops matching is
immediately visible.

Use it to confirm a policy's reach after a config change, and to alert when a
policy you expect to cover instances drops to `0`.

### external_ebs_autoresizer_error_total

- Type: Counter
- Labels: `stage`

The total number of errors, grouped by the reconcile stage where each error
happened. The `stage` label is one of `discover`, `measure`, `cooldown`,
`modify`, `wait`, or `resize` (see the Background section for what each stage
does), plus `node_list`, `query_peak`, `query_samples`, `describe_volumes`,
`describe_instance_types`, and `annotate` from the throughput recommender.

This metric is more detailed than `resize_total` because it shows *where* things
break. For example, many errors with `stage="measure"` point to an SSM or
permissions problem, not a volume problem.

### external_ebs_autoresizer_reconcile_total

- Type: Counter
- Labels: none

The total number of reconcile passes that have started. It increases by one each
interval (set by `reconcileInterval`, default `5m`).

Use it as a liveness signal. If this counter stops growing, the reconcile loop
has stalled, even if the Pod still looks healthy.

### external_ebs_autoresizer_node_throughput_current_mibps

- Type: Gauge
- Labels: `node`, `instance_id`, `volume_id`

The provisioned EBS throughput, in MiB/s, of the volume attached to one Kubernetes
Node. Only exported when `throughputRecommendation.enabled` is true.

### external_ebs_autoresizer_node_throughput_observed_peak_mibps

- Type: Gauge
- Labels: `node`, `instance_id`, `volume_id`

The observed peak throughput of one Node over the configured observation window
(the configured quantile of per-step throughput, not the mean). This is the demand
signal the recommendation is derived from.

### external_ebs_autoresizer_node_throughput_recommended_mibps

- Type: Gauge
- Labels: `node`, `instance_id`, `volume_id`

The recommended throughput, in MiB/s. It equals the current value when no change is
recommended, so `recommended > current` is exactly the set of nodes with a pending
increase.

All three gauges carry the same labels on purpose, so headroom is a plain vector
match rather than a relabeling exercise. They are reset at the start of every
recommender pass: nodes are short-lived under Karpenter, and a terminated node's
last reading would otherwise stay exported and read as a live node.

### external_ebs_autoresizer_recommendation_total

- Type: Counter
- Labels: `action`, `reason`

The total number of recommendations published. `action` is one of `increase`,
`decrease`, `none`, or `unknown`; `reason` explains it (for example
`clamped_to_instance_bandwidth`, `insufficient_samples`). The full reason list is in
[designs/ebs-throughput-recommendation.md](designs/ebs-throughput-recommendation.md).

### external_ebs_autoresizer_throughput_apply_total

- Type: Counter
- Labels: `result`

The total number of throughput piggybacks attempted on volume size modifications,
only populated when `throughputRecommendation.applyOnResize` is enabled. An
attempt means a combined size + throughput + IOPS request was sent to EC2;
modifications that proceeded without one are counted separately in
`throughput_apply_skip_total`, the same split `resize_total` and `skip_total` use.

| Result | Meaning |
|--------|---------|
| `applied` | The combined modification succeeded. |
| `fallback_size_only` | The combined request was rejected; the resize was retried (and succeeded or failed on its own merits) without the throughput change. |

### external_ebs_autoresizer_throughput_apply_skip_total

- Type: Counter
- Labels: `reason`

The total number of volume size modifications that proceeded without a throughput
piggyback, by reason. Only counted when a modification actually spends a slot: dry
runs and `applyOnResize: false` configurations count nothing. The label set is
fixed, so the series count does not grow with fleet size.

| Reason | Meaning |
|--------|---------|
| `no_recommendation` | The recommender has never evaluated this volume (standalone instance, multiple attached volumes, node too young). The normal case outside the recommender's scope. |
| `stale` | A recommendation exists but is older than the freshness bound (2 recommender intervals): the recommender has stopped producing while the resizer kept going. The one reason worth alerting on. |
| `not_increase` | A fresh recommendation exists and asks for no raise. The healthy steady state for in-scope volumes. |

### external_ebs_autoresizer_recommender_reconcile_total

- Type: Counter

The total number of throughput recommender passes started, the liveness signal of
the recommender loop the way `reconcile_total` is for the resize loop. Absent when
the recommender is disabled.

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

Detect a stopped recommender while resizes keep spending modification slots, from
either side:

```promql
increase(external_ebs_autoresizer_recommender_reconcile_total[2h]) == 0
  or increase(external_ebs_autoresizer_throughput_apply_skip_total{reason="stale"}[6h]) > 0
```

Nodes wanting more EBS throughput than they have:

```promql
external_ebs_autoresizer_node_throughput_recommended_mibps
  > external_ebs_autoresizer_node_throughput_current_mibps
```

Throughput utilization per node, the same number the
`external-ebs-autoresizer/throughput-utilization-percent` annotation carries:

```promql
100 * external_ebs_autoresizer_node_throughput_observed_peak_mibps
  / external_ebs_autoresizer_node_throughput_current_mibps
```

Over 100 is normal rather than a fault: node exporter measures bytes actually moved
and a gp3 volume bursts above its provisioned throughput.

Nodes throughput-bound at a ceiling, where a volume change alone will not help:

```promql
sum by (reason) (
  rate(external_ebs_autoresizer_recommendation_total{reason=~"clamped_to_.*"}[1h])
)
```

## Conclusion

The addon exposes fourteen metrics, and together they answer fourteen simple
questions:

| Question | Metric | Type |
|----------|--------|------|
| How full are the disks? | `root_usage_percent` | Gauge |
| How big are the volumes? | `root_volume_size_gib` | Gauge |
| Are resizes succeeding? | `resize_total` | Counter |
| When the addon holds back, why? | `skip_total` | Counter |
| If something fails, where? | `error_total` | Counter |
| Is the loop still running? | `reconcile_total` | Counter |
| Which policy covers which instances? | `policy_instances` | Gauge |
| What throughput do nodes have? | `node_throughput_current_mibps` | Gauge |
| What throughput do they actually use? | `node_throughput_observed_peak_mibps` | Gauge |
| What should they have? | `node_throughput_recommended_mibps` | Gauge |
| What is being recommended, and why? | `recommendation_total` | Counter |
| Are recommendations being applied on resize? | `throughput_apply_total` | Counter |
| When a spent slot carried no throughput change, why? | `throughput_apply_skip_total` | Counter |
| Is the recommender loop still running? | `recommender_reconcile_total` | Counter |

A good starting point is one dashboard panel per metric, plus three alerts: one
on a rising `resize_total{result="failure"}` rate, one on a stalled
`reconcile_total`, and one on `skip_total{reason="max_size"}` paired with high
`root_usage_percent` to catch disks stuck at the ceiling. From there you can add
per-instance usage views using the labels on `root_usage_percent`.
