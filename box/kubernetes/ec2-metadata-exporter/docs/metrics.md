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
| `ec2_metadata_instances` | Gauge | Instance count from the last successful scrape. |
| `ec2_metadata_scrape_errors_total` | Counter | EC2 API scrape failures. |
| `ec2_metadata_scrape_duration_seconds` | Gauge | Duration of the last scrape. |
| `ec2_metadata_last_scrape_success_timestamp_seconds` | Gauge | Unix time of the last successful scrape. |

Example output:

```
ec2_metadata_instance_info{instance_id="i-0abc123",name="web-1",private_ip="10.0.1.10",instance_type="m5.large",availability_zone="ap-northeast-2a",state="running",lifecycle="on-demand",architecture="x86_64"} 1
```

The info gauge is fully reset on every refresh, so terminated instances drop
out instead of going stale.

## Example queries

| Purpose | PromQL |
|---------|--------|
| Resolve instance name by private IP | `ec2_metadata_instance_info{private_ip="10.0.1.10"}` |
| Running instances per type | `count by (instance_type) (ec2_metadata_instance_info{state="running"})` |
| Spot ratio | `count(ec2_metadata_instance_info{lifecycle="spot"}) / count(ec2_metadata_instance_info)` |
| Scrape error rate | `rate(ec2_metadata_scrape_errors_total[5m])` |
| Staleness (seconds since last success) | `time() - ec2_metadata_last_scrape_success_timestamp_seconds` |

## Alerting hints

- Alert when `time() - ec2_metadata_last_scrape_success_timestamp_seconds`
  exceeds several scrape intervals; the info labels are stale beyond that
  point.
- Alert on a sustained increase of `ec2_metadata_scrape_errors_total`, which
  usually indicates IAM or EC2 API throttling problems.
