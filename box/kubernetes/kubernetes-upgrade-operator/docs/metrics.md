# Prometheus Metrics Reference

kuo exposes Prometheus metrics on a dedicated metrics server (port 8081), separate from the health probe server (port 8080). Health probes and metrics scraping are served by independent axum instances so that Prometheus scrape load does not affect kubelet liveness/readiness checks, and each port can be scoped independently via NetworkPolicy.

## Endpoints

| Path | Port | Purpose |
|------|------|---------|
| `/healthz` | 8080 | Liveness probe (kubelet) |
| `/readyz` | 8080 | Readiness probe (kubelet) |
| `/metrics` | 8081 | Prometheus metrics (OpenMetrics text) |

Enable scraping via the Helm chart:

```yaml
serviceMonitor:
  enabled: true
  interval: 30s
```

## Label Schema

All metrics include `cluster_name` and `region` labels, enabling per-cluster filtering in multi-cluster environments.

| Label | Source | Example |
|-------|--------|---------|
| `cluster_name` | `spec.clusterName` | `production-cluster` |
| `region` | `spec.region` | `ap-northeast-2` |
| `phase` | `status.phase` | `UpgradingControlPlane` |
| `result` | Reconcile outcome | `success`, `requeue`, `error` |

## Metrics

### kuo_reconcile_total

Total number of reconcile calls.

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `cluster_name`, `region`, `result` |

`result` values:

| Value | Meaning |
|-------|---------|
| `success` | Reconcile completed, no requeue needed |
| `requeue` | Reconcile completed, requeue scheduled |
| `error` | Reconcile failed with error |

### kuo_reconcile_duration_seconds

Duration of individual reconcile calls in seconds. Measures the wall-clock time of a single reconcile invocation, not the total phase duration.

| Property | Value |
|----------|-------|
| Type | Histogram |
| Labels | `cluster_name`, `region` |
| Buckets | 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s |

### kuo_phase_duration_seconds

Total time spent in each upgrade phase in seconds. Tracked in-memory from phase entry to phase transition. Phases like `UpgradingControlPlane` or `UpgradingNodeGroups` span multiple reconcile calls and can take tens of minutes.

| Property | Value |
|----------|-------|
| Type | Histogram |
| Labels | `cluster_name`, `region`, `phase` |
| Buckets | 1s, 5s, 10s, 30s, 1m, 2m, 5m, 10m, 30m, 1h |

> If the operator restarts mid-phase, the in-memory start time is lost and that phase's duration is not recorded.

### kuo_upgrade_phase_info

Current upgrade phase. The active phase has value `1`, all others have value `0`.

| Property | Value |
|----------|-------|
| Type | Gauge |
| Labels | `cluster_name`, `region`, `phase` |

`phase` values: `Pending`, `Planning`, `PreflightChecking`, `UpgradingControlPlane`, `UpgradingAddons`, `UpgradingNodeGroups`, `Completed`, `Failed`

### kuo_phase_transition_total

Total number of phase transitions. Incremented each time a phase changes (e.g., Planning to PreflightChecking).

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `cluster_name`, `region`, `phase` |

The `phase` label represents the **destination** phase of the transition.

### kuo_upgrade_completed_total

Total number of upgrades that reached the `Completed` phase.

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `cluster_name`, `region` |

### kuo_upgrade_failed_total

Total number of upgrades that reached the `Failed` phase. Includes both permanent reconcile errors and mandatory preflight check failures.

| Property | Value |
|----------|-------|
| Type | Counter |
| Labels | `cluster_name`, `region` |

## PromQL Examples

### Reconcile error rate (5m window)

```promql
sum(rate(kuo_reconcile_total{result="error"}[5m])) by (cluster_name, region)
```

### Reconcile p99 latency

```promql
histogram_quantile(0.99, sum(rate(kuo_reconcile_duration_seconds_bucket[5m])) by (le, cluster_name))
```

### Current phase per cluster

```promql
kuo_upgrade_phase_info == 1
```

### Phase duration p95

```promql
histogram_quantile(0.95, sum(rate(kuo_phase_duration_seconds_bucket[1h])) by (le, phase))
```

### Average control plane upgrade time

```promql
histogram_quantile(0.5, sum(rate(kuo_phase_duration_seconds_bucket{phase="UpgradingControlPlane"}[24h])) by (le))
```

### Upgrade success rate (24h)

```promql
sum(increase(kuo_upgrade_completed_total[24h]))
/
(sum(increase(kuo_upgrade_completed_total[24h])) + sum(increase(kuo_upgrade_failed_total[24h])))
```

### Phase transition throughput

```promql
sum(rate(kuo_phase_transition_total[5m])) by (phase)
```

## Alerting Examples

### Upgrade stuck in a phase for over 1 hour

```yaml
- alert: KuoUpgradeStuck
  expr: |
    (kuo_upgrade_phase_info == 1)
    * on (cluster_name, region) group_left()
    (time() - kuo_phase_transition_total > 0)
    unless (kuo_upgrade_phase_info{phase=~"Completed|Failed"} == 1)
  for: 1h
  labels:
    severity: warning
  annotations:
    summary: "EKS upgrade stuck in {{ $labels.phase }} for {{ $labels.cluster_name }}"
```

### High reconcile error rate

```yaml
- alert: KuoReconcileErrorRate
  expr: |
    sum(rate(kuo_reconcile_total{result="error"}[5m])) by (cluster_name)
    / sum(rate(kuo_reconcile_total[5m])) by (cluster_name)
    > 0.5
  for: 10m
  labels:
    severity: critical
  annotations:
    summary: "kuo reconcile error rate > 50% for {{ $labels.cluster_name }}"
```

### Upgrade failure detected

```yaml
- alert: KuoUpgradeFailed
  expr: increase(kuo_upgrade_failed_total[5m]) > 0
  labels:
    severity: critical
  annotations:
    summary: "EKS upgrade failed for {{ $labels.cluster_name }} in {{ $labels.region }}"
```
