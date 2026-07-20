# Metrics

## Overview

This document describes the Prometheus metrics that ec2-metadata-exporter
exposes, what each metric means, and how to use them for dashboards and
alerts.

The exporter publishes metrics on the `/metrics` HTTP path. The default port
is `8081` and can be changed with the `METRICS_PORT` environment variable.
All metric names share the prefix `ec2_metadata_`.

## Metric reference

| Metric | Type | Description |
|--------|------|-------------|
| `ec2_metadata_instance_info{instance_id, name, private_ip, instance_type, availability_zone, state, lifecycle, architecture}` | Gauge | Always 1. One series per non-terminated instance with a private IP. `lifecycle` is `on-demand` or `spot`; `architecture` is `x86_64`, `arm64`, etc. |
| `ec2_metadata_instances{state}` | Gauge | Instance count from the last successful scrape, broken down by instance state. Sum over `state` for the total. |
| `ec2_metadata_scrape_errors_total` | Counter | EC2 API scrape failures. |
| `ec2_metadata_scrape_duration_seconds` | Histogram | EC2 API scrape duration. Buckets from 50ms to ~25.6s. |
| `ec2_metadata_last_scrape_success_timestamp_seconds` | Gauge | Unix time of the last successful scrape. |
| `ec2_metadata_build_info{version, commit, go_version}` | Gauge | Always 1. Exporter version, git commit, and Go runtime version. |

Example output:

```
ec2_metadata_instance_info{instance_id="i-0abc123",name="web-1",private_ip="10.0.1.10",instance_type="m5.large",availability_zone="ap-northeast-2a",state="running",lifecycle="on-demand",architecture="x86_64"} 1
ec2_metadata_instances{state="running"} 1
ec2_metadata_build_info{version="0.2.0",commit="f55bf0b",go_version="go1.26.5"} 1
```

Instance metrics are served from an in-memory snapshot that is swapped
atomically on every successful refresh: a Prometheus scrape never observes a
half-populated result, and terminated instances drop out as soon as a new
snapshot lands. When a refresh fails, the previous snapshot keeps serving and
`ec2_metadata_last_scrape_success_timestamp_seconds` stops advancing.

## Example queries

| Purpose | PromQL |
|---------|--------|
| Resolve instance name by private IP | `ec2_metadata_instance_info{private_ip="10.0.1.10"}` |
| Running instances per type | `count by (instance_type) (ec2_metadata_instance_info{state="running"})` |
| Spot ratio | `count(ec2_metadata_instance_info{lifecycle="spot"}) / count(ec2_metadata_instance_info)` |
| Total instances across states | `sum(ec2_metadata_instances)` |
| Stopped instance count | `ec2_metadata_instances{state="stopped"}` |
| Scrape error rate | `rate(ec2_metadata_scrape_errors_total[5m])` |
| Scrape latency p99 | `histogram_quantile(0.99, rate(ec2_metadata_scrape_duration_seconds_bucket[5m]))` |
| Staleness (seconds since last success) | `time() - ec2_metadata_last_scrape_success_timestamp_seconds` |
| Deployed exporter versions | `count by (version, go_version) (ec2_metadata_build_info)` |

## Alerting hints

- Alert when `time() - ec2_metadata_last_scrape_success_timestamp_seconds`
  exceeds several scrape intervals; the info labels are stale beyond that
  point.
- Alert on a sustained increase of `ec2_metadata_scrape_errors_total`, which
  usually indicates IAM or EC2 API throttling problems.
- A rising `ec2_metadata_scrape_duration_seconds` p99 signals EC2 API
  throttling or a growing instance fleet before errors start appearing.

## Readiness behavior

The `/readyz` endpoint on the health port stays not-ready until the first
successful EC2 scrape completes, so rollouts never route to an exporter with
an empty snapshot. After that it stays ready; scrape failures keep serving
the previous snapshot and are surfaced through
`ec2_metadata_scrape_errors_total` and the last-success timestamp instead of
flipping readiness.
