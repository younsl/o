# trivy-collector

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-trivy--collector-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/trivy-collector)
[![Rust](https://img.shields.io/badge/rust-1.92-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

Multi-cluster Trivy report collector and viewer - Rust-based Kubernetes application.

## Overview

This tool collects [Trivy Operator](https://github.com/aquasecurity/trivy-operator) reports (VulnerabilityReports, SbomReports) from multiple Kubernetes clusters and provides a centralized web UI for viewing and filtering security reports.

## Background

[Trivy Operator](https://github.com/aquasecurity/trivy-operator) is an excellent tool for scanning container vulnerabilities and generating SBOMs in Kubernetes. However, it only creates Custom Resources (VulnerabilityReports, SbomReports) within the cluster - **it doesn't provide any interface for Security Engineers to analyze this data**.

This creates real collaboration challenges:

- **Kubernetes Expertise Required**: Security Engineers must learn kubectl, understand CRDs, and parse YAML/JSON to review vulnerabilities
- **Scattered Data**: In multi-cluster environments, reports are distributed across clusters with no central view
- **No Filtering**: Finding critical vulnerabilities across hundreds of reports means manual grep/jq operations
- **No Historical View**: CRDs only show current state; there's no built-in way to track changes over time

```bash
# Without trivy-collector: Security Engineers need to run this
kubectl get vulnerabilityreports -A -o json | \
  jq '.items[] | select(.report.summary.criticalCount > 0) | {namespace: .metadata.namespace, name: .metadata.name, critical: .report.summary.criticalCount}'
```

**trivy-collector** bridges the gap between Platform Engineers and Security Engineers. Security teams can analyze vulnerability data through a familiar web interface - no Kubernetes knowledge or cluster access required. Just open the dashboard and start reviewing.

## Features

- **Multi-cluster support**: Collect reports from multiple Kubernetes clusters
- **Dual-mode architecture**: Runs as Collector (edge) or Server (central)
- **Web UI**: Built-in dashboard for viewing and filtering reports
- **SQLite storage**: Lightweight, persistent storage for reports
- **VulnerabilityReports**: Collect and view container vulnerability scans
- **SbomReports**: Collect and view Software Bill of Materials
- **Namespace filtering**: Watch specific namespaces or all namespaces
- **Health endpoints**: Kubernetes-ready health check endpoints
- **Structured logging**: JSON/pretty format with configurable levels
- **Helm chart**: Easy deployment with customizable values

## Architecture

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

### Collector Mode (Edge clusters)

Deployed on each edge cluster to collect and forward Trivy reports.

| Role | Description |
|------|-------------|
| **Watch CRDs** | Monitors VulnerabilityReports and SbomReports via Kubernetes API |
| **Forward Reports** | Sends reports to central server via HTTP POST (`/api/v1/reports`) |
| **Cluster Tagging** | Attaches cluster name to each report for source identification |
| **Retry Logic** | Retries failed transmissions with configurable attempts and delay |

Lightweight footprint with minimal resource usage.

### Server Mode (Central cluster)

Single instance that aggregates reports from all collectors.

| Role | Description |
|------|-------------|
| **Receive Reports** | Accepts reports from collectors via REST API |
| **Local Collection** | Optionally watches and collects Trivy reports in local cluster (`--watch-local`) |
| **Persistent Storage** | Stores all reports in SQLite database |
| **Web UI** | Provides dashboard for Security Engineers (no kubectl required) |
| **Query API** | REST endpoints for filtering by cluster, namespace, severity |

Requires persistent volume for database storage.

## Quick Start

### Server Deployment (Central cluster)

```bash
# Install server via Helm
helm install trivy-collector ./charts/trivy-collector \
  --namespace trivy-system \
  --create-namespace \
  --set mode=server \
  --set server.persistence.enabled=true \
  --set server.ingress.enabled=true \
  --set server.ingress.hosts[0].host=trivy.example.com
```

### Collector Deployment (Edge clusters)

```bash
# Install collector via Helm
helm install trivy-collector ./charts/trivy-collector \
  --namespace trivy-system \
  --create-namespace \
  --set mode=collector \
  --set collector.serverUrl=http://trivy-server.central-cluster:3000 \
  --set collector.clusterName=edge-cluster-a
```

## Project Structure

```
trivy-collector/
├── src/
│   ├── main.rs           # Application entry point
│   ├── lib.rs            # Module exports
│   ├── config.rs         # CLI and configuration
│   ├── health.rs         # Health check server
│   ├── logging.rs        # Logging setup
│   ├── collector.rs      # Collector mode entry
│   ├── collector/
│   │   ├── watcher.rs    # Kubernetes CRD watcher
│   │   ├── sender.rs     # HTTP report sender
│   │   ├── health_checker.rs  # Server health monitoring
│   │   └── types.rs      # Trivy CRD types
│   ├── server.rs         # Server mode entry
│   ├── server/
│   │   ├── api.rs        # REST API handlers
│   │   └── watcher.rs    # Local K8s watcher
│   ├── storage.rs        # Storage module
│   └── storage/
│       └── sqlite.rs     # SQLite database
├── static/
│   ├── index.html        # Web UI HTML
│   ├── style.css         # Web UI styles
│   └── app.js            # Web UI JavaScript
├── charts/
│   └── trivy-collector/  # Helm chart
├── Dockerfile            # Multi-stage build
├── Cargo.toml            # Rust dependencies
├── Makefile              # Build automation
└── README.md             # This file
```

## Configuration

### Command-line Options

| Argument | Environment Variable | Default | Mode | Description |
|----------|---------------------|---------|------|-------------|
| `--mode` | `MODE` | `collector` | Both | Deployment mode: `collector` or `server` |
| `--log-format` | `LOG_FORMAT` | `json` | Both | Log format: `json` or `pretty` |
| `--log-level` | `LOG_LEVEL` | `info` | Both | Log level: trace, debug, info, warn, error |
| `--health-port` | `HEALTH_PORT` | `8080` | Both | Health check server port |

#### Collector Mode Options

| Argument | Environment Variable | Default | Description |
|----------|---------------------|---------|-------------|
| `--server-url` | `SERVER_URL` | - | Central server URL (required) |
| `--cluster-name` | `CLUSTER_NAME` | - | Cluster identifier (required) |
| `--namespaces` | `NAMESPACES` | `""` | Namespaces to watch (comma-separated, empty = all) |
| `--collect-vulnerability-reports` | `COLLECT_VULN` | `true` | Collect VulnerabilityReports |
| `--collect-sbom-reports` | `COLLECT_SBOM` | `true` | Collect SbomReports |
| `--retry-attempts` | `RETRY_ATTEMPTS` | `3` | Retry attempts on failure |
| `--retry-delay-secs` | `RETRY_DELAY_SECS` | `5` | Delay between retries |

#### Server Mode Options

| Argument | Environment Variable | Default | Description |
|----------|---------------------|---------|-------------|
| `--server-port` | `SERVER_PORT` | `3000` | API/UI server port |
| `--storage-path` | `STORAGE_PATH` | `/data` | SQLite database directory |
| `--watch-local` | `WATCH_LOCAL` | `true` | Watch local cluster's Trivy reports |
| `--local-cluster-name` | `LOCAL_CLUSTER_NAME` | `local` | Local cluster name for K8s watching |

## API Endpoints

### Health Check

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/healthz` | GET | Liveness probe |
| `/readyz` | GET | Readiness probe |

### REST API (Server Mode)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/reports` | POST | Receive report from collector |
| `/api/v1/vulnerabilityreports` | GET | List vulnerability reports |
| `/api/v1/vulnerabilityreports/{cluster}/{namespace}/{name}` | GET | Get specific vulnerability report |
| `/api/v1/sbomreports` | GET | List SBOM reports |
| `/api/v1/sbomreports/{cluster}/{namespace}/{name}` | GET | Get specific SBOM report |
| `/api/v1/clusters` | GET | List clusters |
| `/api/v1/namespaces` | GET | List namespaces |
| `/api/v1/stats` | GET | Get statistics |
| `/api/v1/watcher/status` | GET | Get watcher status |
| `/api/v1/version` | GET | Get version info |
| `/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}` | DELETE | Delete report |
| `/api/v1/reports/{cluster}/{report_type}/{namespace}/{name}/notes` | PUT | Update report notes |

## Development

### Build Commands

```bash
# Build debug binary
make build

# Build release binary
make release

# Run server mode locally
make run

# Run collector mode locally
make run-collector

# Run with debug logging
make dev

# Run tests
make test

# Format code
make fmt

# Run linter
make lint

# Clean build artifacts
make clean
```

### Docker Commands

```bash
# Build Docker image
make docker-build

# Build for all platforms (requires cross)
make build-all

# Push to registry (update ECR_REGISTRY in Makefile first)
make docker-push
```

### Local Testing

```bash
# Terminal 1: Run server
MODE=server STORAGE_PATH=/tmp/trivy-data LOG_FORMAT=pretty ./target/debug/trivy-collector

# Terminal 2: Run collector (requires Trivy Operator in cluster)
MODE=collector SERVER_URL=http://localhost:3000 CLUSTER_NAME=local-test LOG_FORMAT=pretty ./target/debug/trivy-collector
```

## Helm Chart

### Values Reference

```yaml
# Deployment mode
mode: collector  # or "server"

# Collector settings
collector:
  serverUrl: "http://trivy-server:3000"
  clusterName: "my-cluster"
  namespaces: []  # empty = all namespaces
  collectVulnerabilityReports: true
  collectSbomReports: true

# Server settings
server:
  port: 3000
  persistence:
    enabled: true
    storageClass: ""
    size: 5Gi
  ingress:
    enabled: false
    hosts:
      - host: trivy.example.com
        paths:
          - path: /
            pathType: Prefix
  gateway:  # Gateway API HTTPRoute (alternative to Ingress)
    enabled: false
    parentRefs:
      - name: main-gateway
        namespace: gateway-system

# Common settings
health:
  port: 8080

logging:
  format: json
  level: info

resources:
  limits:
    memory: 256Mi
  requests:
    cpu: 100m
    memory: 128Mi
```

### Installation Examples

```bash
# Server with persistence and ingress
helm install trivy-server ./charts/trivy-collector \
  --namespace trivy-system \
  --set mode=server \
  --set server.persistence.enabled=true \
  --set server.ingress.enabled=true \
  --set server.ingress.className=nginx \
  --set server.ingress.hosts[0].host=trivy.example.com

# Collector watching specific namespaces
helm install trivy-collector ./charts/trivy-collector \
  --namespace trivy-system \
  --set mode=collector \
  --set collector.serverUrl=http://trivy-server:3000 \
  --set collector.clusterName=production \
  --set collector.namespaces="{default,kube-system,app}"

# Server with Gateway API HTTPRoute
helm install trivy-server ./charts/trivy-collector \
  --namespace trivy-system \
  --set mode=server \
  --set server.gateway.enabled=true \
  --set server.gateway.hostnames[0]=trivy.example.com
```

## Prerequisites

- Kubernetes cluster with [Trivy Operator](https://github.com/aquasecurity/trivy-operator) installed
- RBAC permissions to watch VulnerabilityReports and SbomReports CRDs

### Required RBAC Permissions

The collector requires the following RBAC permissions:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: trivy-collector
rules:
  - apiGroups: ["aquasecurity.github.io"]
    resources: ["vulnerabilityreports", "sbomreports"]
    verbs: ["get", "list", "watch"]
```

## Troubleshooting

### Server mode: 403 Forbidden when watching CRDs

**Symptom**: Server mode fails with RBAC errors when `--watch-local` is enabled (default):

```
ERROR: SbomReport watcher error
error: "sbomreports.aquasecurity.github.io is forbidden: User \"system:serviceaccount:trivy-system:trivy-collector\" cannot list resource \"sbomreports\" in API group \"aquasecurity.github.io\" at the cluster scope"
```

**Cause**: ClusterRole/ClusterRoleBinding not created for server mode.

**Solution**: Ensure the Helm chart creates RBAC resources for both modes. The ClusterRole is required whenever the application watches Kubernetes CRDs, regardless of mode:

```bash
# Verify ClusterRole exists
kubectl get clusterrole trivy-collector

# Verify ClusterRoleBinding exists
kubectl get clusterrolebinding trivy-collector

# If missing, check Helm values
helm get values trivy-collector -n trivy-system
# Ensure serviceAccount.create: true
```

If using the Helm chart, RBAC resources are created when `serviceAccount.create: true`.

### Collector not receiving reports

- Verify Trivy Operator is installed and generating reports
- Check RBAC permissions for watching CRDs
- Verify `SERVER_URL` is reachable from collector pod

### Server not storing reports

- Check storage path permissions (`/data` directory)
- Verify SQLite database is writable
- Check logs for database errors

### Web UI not loading

- Verify server is running on correct port (default: 3000)
- Check ingress/service configuration
- Access server pod directly: `kubectl port-forward svc/trivy-collector 3000:3000`

## Release Workflow

Releases are automated via GitHub Actions:

```bash
# Create and push tag
git tag trivy-collector/0.1.0
git push origin trivy-collector/0.1.0

# GitHub Actions automatically:
# 1. Builds multi-arch Docker images (linux/amd64, linux/arm64)
# 2. Pushes to GitHub Container Registry (ghcr.io)
# 3. Creates GitHub release
```

Container images:
- `ghcr.io/younsl/trivy-collector:0.1.0` (versioned)
- `ghcr.io/younsl/trivy-collector:latest` (latest)

## License

MIT

## Author

younsl
