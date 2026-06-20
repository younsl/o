# Metrics

## Overview

This document explains the Prometheus metrics that forklift exposes. It
describes what each metric means, which labels it carries, and how to use it to
build dashboards and alerts.

Read this if you run forklift and want to watch it in production, or if you are
on call and need to check whether downloads, caching, approvals, or HA
replication are healthy. Basic familiarity with Prometheus and PromQL is enough.

## Background

forklift runs as a single Go process. The application (API, UI, package
endpoints) serves on `FORKLIFT_HTTP_ADDR` (`:8080` by default). Metrics are
served separately on `FORKLIFT_METRICS_ADDR` (`:8081` by default) at the
`/metrics` path, so a scrape never competes with package traffic.

All forklift metric names share the prefix `forklift_`. The endpoint also
exposes the standard Go runtime and process collectors (`go_*`, `process_*`),
which are not documented here.

Two kinds of metrics need a note on how they are computed:

- The inventory and storage gauges (`forklift_repositories`,
  `forklift_artifacts`, `forklift_blobs`, `forklift_storage_bytes`) and
  `forklift_approval_pending` are computed at scrape time by querying the
  metadata store. They carry no leader gating, so they stay accurate on standby
  pods after a replication snapshot swap.
- The traffic, cache, policy, and replication metrics are counters and gauges
  updated as requests flow through the process.

A short reminder on metric types:

- A **gauge** is a value that can go up and down. It always reports the latest
  reading.
- A **counter** only goes up and resets to zero on process restart. Look at how
  fast it grows with `rate()`, not at its raw value.
- A **histogram** records observations into buckets, used here for request
  latency.

## Metrics

### forklift_build_info

- Type: Gauge
- Labels: `version`, `commit`, `go_version`

Build metadata exposed as a constant gauge whose value is always `1`. The labels
carry the running binary version, the Git commit it was built from, and the Go
toolchain version. Use it to confirm which build is live and to join other
metrics against a version during a rollout.

### forklift_leader

- Type: Gauge
- Labels: none

`1` if this instance currently holds leadership, otherwise `0`. In a
single-instance deployment the process is always leader and reports `1`. In HA
mode exactly one pod reports `1` at a time, decided by Kubernetes Lease leader
election. The leader runs the gated background work (blob sweeper, audit
retention) and, with PV-based replication, serves snapshots to standbys.

Use it to confirm that exactly one leader exists. A sum across pods that is not
`1` points to a split brain or a stalled election.

### forklift_http_requests_total

- Type: Counter
- Labels: `method`, `route`, `status`

Total HTTP requests served by the application listener, split by HTTP method,
matched route pattern, and response status code. Use it for request rate and
error-ratio dashboards.

### forklift_http_request_duration_seconds

- Type: Histogram
- Labels: `method`, `route`, `status`

Request latency in seconds, bucketed with the Prometheus default buckets. Use
the `_bucket` series with `histogram_quantile()` for latency percentiles, and
the `_count` series as an alternative request counter.

### forklift_repositories

- Type: Gauge
- Labels: `format`, `type`

The number of configured repositories, grouped by package family and
repository type.

| Label | Values |
|-------|--------|
| `format` | `maven`, `npm`, `cargo`, `go`, `pypi` |
| `type` | `hosted`, `proxy`, `group` |

Use it to track repository inventory and to confirm that expected repositories
exist after a config change.

### forklift_artifacts

- Type: Gauge
- Labels: none

The total number of logical artifacts indexed across all repositories. This is a
metadata count, not physical storage. Two repositories that reference the same
content count as two artifacts even though the bytes are stored once.

### forklift_blobs

- Type: Gauge
- Labels: none

The number of deduplicated content-addressed blobs in the blob store. Each blob
is unique by SHA-256, so this is always less than or equal to
`forklift_artifacts`. The ratio between the two shows how effective
deduplication is.

### forklift_storage_bytes

- Type: Gauge
- Labels: none

Physical bytes used by the deduplicated blobs on the PersistentVolume. Use it to
watch storage growth and to size or alert on the volume.

### forklift_bytes_transferred_total

- Type: Counter
- Labels: `direction`, `format`

Artifact bytes transferred between forklift and its clients. The `direction`
label is `egress` for downloads served to clients and `ingress` for uploads
received from clients. The `format` label is the package family. Use it for
bandwidth dashboards and per-format traffic breakdowns.

### forklift_cache_hits_total / forklift_cache_misses_total

- Type: Counter
- Labels: `repo`

Proxy cache outcomes per repository. A hit means a proxy repository served an
artifact from its local cache; a miss means it had to fetch from upstream. The
hit ratio per repo measures cache effectiveness.

### forklift_upstream_errors_total

- Type: Counter
- Labels: `repo`

Failures while fetching from an upstream, per proxy repository. A rising rate
points to a broken or unreachable upstream, not a forklift problem. Pair it with
`forklift_cache_misses_total` to see how many misses turned into errors.

### forklift_age_policy_violations_total

- Type: Counter
- Labels: `repo`, `action`

Requests that hit the supply-chain age policy, which quarantines freshly
published upstream versions. The `action` label distinguishes a hard block from
a warning. Use it to gauge how often the age policy intervenes.

### forklift_approval_blocked_total

- Type: Counter
- Labels: `repo`, `mode`

Requests handled by the package approval gate per repository. The `mode` label
is `enforce` when the request was blocked pending an admin decision, or `audit`
when it was only counted (audit-only mode lets the request through). Use it to
size the approval workload before switching a repo into enforce mode.

### forklift_approval_pending

- Type: Gauge
- Labels: none

Package approval requests currently waiting for an admin decision. Computed at
scrape time. Alert on a value that stays high, which means the approval queue is
not being worked.

### forklift_version_deny_blocked_total

- Type: Counter
- Labels: `repo`

Requests blocked by the per-version deny list, which blocks one exact package
version (for example a poisoned release or a known IOC) while the package itself
stays approved. A spike after adding a deny entry confirms clients are still
trying to pull the bad version.

### forklift_vuln_blocked_total

- Type: Counter
- Labels: `repo`, `action`

Requests counted by the vulnerability policy: blocked when `action=block`, or
recorded-only when `action=warn`/`audit`. The policy matches the requested
package version against OSV advisories (direct dependency only) and triggers
when the highest non-ignored severity meets the configured threshold. A spike
indicates clients pulling versions with known advisories.

### forklift_vuln_scans_total

- Type: Counter
- Labels: `result` (`clean`, `vulnerable`, `error`)

Vulnerability scans performed by the background worker against OSV. `error`
growth means OSV lookups are failing (unreachable endpoint, rate limit), in
which case unscanned coordinates fail open unless `block_unscanned` is set.

### forklift_audit_events_dropped_total

- Type: Counter
- Labels: none

Audit events dropped because the recorder's write buffer was full. This should
stay flat at zero. Any growth means audit writes cannot keep up with traffic and
the audit log is incomplete, so alert on `increase() > 0`.

### Replication metrics

These metrics appear only when PV-based replication is enabled
(`replication.enabled`). They are emitted by standby pods that pull from the
leader.

#### forklift_replication_syncs_total

- Type: Counter
- Labels: `result`

Replication sync cycles by outcome (`result` is `success` or `failure`). A
rising failure rate means a standby is falling behind the leader.

#### forklift_replication_blobs_fetched_total

- Type: Counter
- Labels: none

Blobs downloaded from the leader since startup.

#### forklift_replication_blobs_deleted_total

- Type: Counter
- Labels: none

Local blobs deleted because the leader no longer has them, keeping the standby's
blob store in step with the leader.

#### forklift_replication_last_sync_timestamp_seconds

- Type: Gauge
- Labels: none

Unix time of the last successful sync cycle. Alert on `time() - metric` growing
past a few sync intervals, which means replication has stalled.

#### forklift_replication_snapshot_bytes

- Type: Gauge
- Labels: none

Size of the last database snapshot downloaded from the leader.

## Example queries

Confirm exactly one leader across all pods:

```promql
sum(forklift_leader)
```

HTTP error ratio over the last 5 minutes:

```promql
sum(rate(forklift_http_requests_total{status=~"5.."}[5m]))
  / sum(rate(forklift_http_requests_total[5m]))
```

Request latency p99 by route:

```promql
histogram_quantile(0.99,
  sum by (le, route) (rate(forklift_http_request_duration_seconds_bucket[5m])))
```

Proxy cache hit ratio per repository:

```promql
sum by (repo) (rate(forklift_cache_hits_total[1h]))
  / (sum by (repo) (rate(forklift_cache_hits_total[1h]))
     + sum by (repo) (rate(forklift_cache_misses_total[1h])))
```

Deduplication ratio (artifacts per stored blob):

```promql
forklift_artifacts / forklift_blobs
```

Egress bandwidth by package format:

```promql
sum by (format) (rate(forklift_bytes_transferred_total{direction="egress"}[5m]))
```

Audit events being dropped (should never fire):

```promql
increase(forklift_audit_events_dropped_total[15m]) > 0
```

Replication stalled (no successful sync in 10 minutes):

```promql
time() - forklift_replication_last_sync_timestamp_seconds > 600
```

## Conclusion

The metrics answer a few core questions about a forklift deployment:

- Which build is running, and who is leader? `build_info`, `leader`
- Is traffic healthy? `http_requests_total`, `http_request_duration_seconds`,
  `bytes_transferred_total`
- How big is the repository, and how well does dedup work? `repositories`,
  `artifacts`, `blobs`, `storage_bytes`
- Are proxies caching and reaching upstreams? `cache_*`, `upstream_errors_total`
- Are the supply-chain gates doing their job? `age_policy_violations_total`,
  `approval_blocked_total`, `approval_pending`, `version_deny_blocked_total`,
  `vuln_blocked_total`, `vuln_scans_total`
- Is auditing complete? `audit_events_dropped_total`
- In HA, are standbys keeping up? `replication_*`

A good starting point is one dashboard row per group above, plus alerts on
`sum(forklift_leader) != 1`, a rising HTTP 5xx ratio, any
`audit_events_dropped_total` growth, and a stalled
`replication_last_sync_timestamp_seconds`.
