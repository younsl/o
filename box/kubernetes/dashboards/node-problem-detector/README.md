# Node Problem Detector Dashboard

Grafana dashboard for monitoring [Kubernetes Node Problem Detector](https://github.com/kubernetes/node-problem-detector) with node resource metrics.

## Panel Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│ Totals                                                              │
├─────────────────────┬─────────────────────┬─────────────────────────┤
│ Problem affects     │ Problem rates       │ Problem rates           │
│ a node              │ by node             │ (total)                 │
├─────────────────────┴─────────────────────┴─────────────────────────┤
│ Gauges                                                              │
├─────────────────────────────────────────────────────────────────────┤
│ Problem Type - $problem_type (repeated)                             │
├─────────────────────────────────────────────────────────────────────┤
│ Counters                                                            │
├─────────────────────────────────────────────────────────────────────┤
│ Problem rates - $problem_counter_reason (repeated)                  │
├─────────────────────────────────────────────────────────────────────┤
│ Node CPU                                                            │
├───────────────────────────────────┬─────────────────────────────────┤
│ CPU Usage                         │ CPU Load Average                │
├───────────────────────────────────┴─────────────────────────────────┤
│ Node Memory                                                         │
├───────────────────────────────────┬─────────────────────────────────┤
│ Memory Usage %                    │ Memory Usage (Bytes)            │
├───────────────────────────────────┴─────────────────────────────────┤
│ Node Network                                                        │
├───────────────────────────────────┬─────────────────────────────────┤
│ Network Traffic                   │ Network Errors & Drops          │
└───────────────────────────────────┴─────────────────────────────────┘
```

## Panels

| Row | Panel | Description |
|-----|-------|-------------|
| **Totals** | Problem affects a node | Active problems per node (gauge > 0 = issue) |
| | Problem rates by node | Problem occurrence rate per node (5m) |
| | Problem rates | Total problem rate across all nodes |
| **Gauges** | Problem Type | Problem status by type (KernelOops, OOMKilling, TaskHung) |
| **Counters** | Problem rates | Problem event rates by reason |
| **Node CPU** | CPU Usage | CPU usage % per node (>70% yellow, >90% red) |
| | CPU Load Average | CPU time in non-idle modes |
| **Node Memory** | Memory Usage % | Memory usage % per node (>70% yellow, >90% red) |
| | Memory Usage (Bytes) | Memory breakdown: used, buffers, cached |
| **Node Network** | Network Traffic | Receive/transmit throughput (Bps) |
| | Network Errors & Drops | Network errors and dropped packets |

## Requirements

- Prometheus datasource
- node-problem-detector with metrics enabled
- node-exporter for CPU/memory/network metrics

## Installation

Import `dashboard.json` into Grafana via **Dashboards > Import**.

## Metrics

```promql
# NPD metrics
problem_gauge{type, node}
problem_counter{reason, node}

# Node-exporter metrics
node_cpu_seconds_total
node_memory_MemAvailable_bytes
node_memory_MemTotal_bytes
node_network_receive_bytes_total
node_network_transmit_bytes_total
```

## Variables

| Variable | Description |
|----------|-------------|
| `datasource` | Prometheus datasource |
| `node` | Filter by node instance |
| `problem_type` | Filter by problem type |
| `problem_counter_reason` | Filter by problem reason |
