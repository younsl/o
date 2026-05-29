# Configuration

## Command-line Options

| Argument | Environment Variable | Default | Mode | Description |
|----------|---------------------|---------|------|-------------|
| `--mode` | `MODE` | `collector` | Both | Deployment mode: `collector` or `server` |
| `--log-format` | `LOG_FORMAT` | `json` | Both | Log format: `json` or `pretty` |
| `--log-level` | `LOG_LEVEL` | `info` | Both | Log level: trace, debug, info, warn, error |
| `--health-port` | `HEALTH_PORT` | `8080` | Both | Health check server port |

## Collector Mode Options

| Argument | Environment Variable | Default | Description |
|----------|---------------------|---------|-------------|
| `--server-url` | `SERVER_URL` | - | Central server URL (required) |
| `--cluster-name` | `CLUSTER_NAME` | - | Cluster identifier (required) |
| `--namespaces` | `NAMESPACES` | `""` | Namespaces to watch (comma-separated, empty = all) |
| `--collect-vulnerability-reports` | `COLLECT_VULN` | `true` | Collect VulnerabilityReports |
| `--collect-sbom-reports` | `COLLECT_SBOM` | `true` | Collect SbomReports |
| `--retry-attempts` | `RETRY_ATTEMPTS` | `3` | Retry attempts on failure |
| `--retry-delay-secs` | `RETRY_DELAY_SECS` | `5` | Delay between retries |

## Server Mode Options

| Argument | Environment Variable | Default | Description |
|----------|---------------------|---------|-------------|
| `--server-port` | `SERVER_PORT` | `3000` | API/UI server port |
| `--storage-path` | `STORAGE_PATH` | `/data` | SQLite database directory |
| `--watch-local` | `WATCH_LOCAL` | `true` | Watch local cluster's Trivy reports |
| `--local-cluster-name` | `LOCAL_CLUSTER_NAME` | `local` | Local cluster name for K8s watching |

## API Documentation

Server mode exposes auto-generated OpenAPI 3.1 spec via [utoipa](https://github.com/juhaku/utoipa) at `/api-docs/openapi.json`.

```bash
curl -s http://localhost:3000/api-docs/openapi.json | jq .
```

View with [Swagger Editor](https://editor.swagger.io) or import into Postman.

## Health Check Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/healthz` | GET | Liveness probe |
| `/readyz` | GET | Readiness probe |
