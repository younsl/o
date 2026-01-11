# Architecture

## Overview

```
┌─────────────────────┐     ┌─────────────────────┐
│   Edge Cluster A    │     │   Edge Cluster B    │
│  ┌───────────────┐  │     │  ┌───────────────┐  │
│  │Trivy Operator │  │     │  │Trivy Operator │  │
│  └───────┬───────┘  │     │  └───────┬───────┘  │
│          │          │     │          │          │
│  ┌───────▼───────┐  │     │  ┌───────▼───────┐  │
│  │   Collector   │──┼─────┼──│   Collector   │  │
│  └───────────────┘  │     │  └───────────────┘  │
└─────────────────────┘     └─────────────────────┘
           │                           │
           └───────────┬───────────────┘
                       │
                       ▼
          ┌────────────────────────┐
          │    Central Cluster     │
          │  ┌──────────────────┐  │
          │  │      Server      │  │
          │  │  ┌────────────┐  │  │
          │  │  │  Web UI    │  │  │
          │  │  │  REST API  │  │  │
          │  │  │  SQLite DB │  │  │
          │  │  └────────────┘  │  │
          │  └──────────────────┘  │
          └────────────────────────┘
```

trivy-collector supports two deployment modes configured via `--mode` flag:

| Mode | Deployment Location | Purpose |
|------|---------------------|---------|
| `collector` | Each edge cluster | Collect and forward reports to central server |
| `server` | Central cluster (single) | Aggregate, store, and serve reports with Web UI |

## Collector Mode (Edge clusters)

Deployed on each edge cluster to collect and forward Trivy reports.

| Role | Description |
|------|-------------|
| **Watch CRDs** | Monitors VulnerabilityReports and SbomReports via Kubernetes API |
| **Forward Reports** | Sends reports to central server via HTTP POST (`/api/v1/reports`) |
| **Cluster Tagging** | Attaches cluster name to each report for source identification |
| **Retry Logic** | Retries failed transmissions with configurable attempts and delay |

Lightweight footprint with minimal resource usage.

## Server Mode (Central cluster)

Single instance that aggregates reports from all collectors.

| Role | Description |
|------|-------------|
| **Receive Reports** | Accepts reports from collectors via REST API |
| **Local Collection** | Optionally watches and collects Trivy reports in local cluster (`--watch-local`) |
| **Persistent Storage** | Stores all reports in SQLite database |
| **Web UI** | Provides dashboard for Security Engineers (no kubectl required) |
| **Query API** | REST endpoints for filtering by cluster, namespace, severity |

Requires persistent volume for database storage.
