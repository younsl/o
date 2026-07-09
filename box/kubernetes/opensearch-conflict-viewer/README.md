# opensearch-conflict-viewer

Web UI and Prometheus exporter that aggregates mapping conflicts across
OpenSearch Dashboards index patterns. Built with Go 1.26 and shipped as a
statically linked binary on a scratch image.

A mapping conflict appears when the same field carries different mapping
types (e.g. `text` on one daily index, `long` on another) among the indices
an index pattern matches. The viewer fetches every index pattern from the
Dashboards saved-objects index, issues a single `_field_caps` call across the
configured index targets, recomputes conflicts per pattern locally, and
serves the result as an interactive UI with a likely-cause explanation per
type combination.

## Endpoints

| Path | Description |
|------|-------------|
| `/` | Web UI: per-pattern conflict fields, type-to-index breakdown, cause explanations, search and filters |
| `/api/conflicts` | Latest snapshot as JSON |
| `/metrics` | Prometheus metrics |
| `/healthz` | Liveness probe, always 200 |
| `/readyz` | Readiness probe, 200 after the first successful refresh |

## Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `opensearch_mapping_conflict_fields{index_pattern}` | Gauge | Number of conflict fields per index pattern. Fully reset on every refresh. |
| `opensearch_mapping_conflict_patterns` | Gauge | Index patterns with at least one conflict. |
| `opensearch_mapping_conflict_patterns_scanned_total` | Gauge | Index patterns scanned in the last refresh. |
| `opensearch_mapping_conflict_last_refresh_timestamp_seconds` | Gauge | Unix time of the last successful refresh. |
| `opensearch_mapping_conflict_refresh_duration_seconds` | Gauge | Duration of the last successful refresh. |
| `opensearch_mapping_conflict_refresh_errors_total` | Counter | Failed refresh attempts. |

## Configuration

All settings come from environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENSEARCH_URL` | required | OpenSearch endpoint including scheme, e.g. `https://opensearch.example.com:443` |
| `OPENSEARCH_USERNAME` | `""` | Basic auth username; empty disables basic auth |
| `OPENSEARCH_PASSWORD` | `""` | Basic auth password |
| `INDEX_TARGETS` | `logs-*` | Comma-separated index targets for `_field_caps`, e.g. `logs-*,logstash-*` |
| `KIBANA_INDEX` | `.kibana` | Dashboards saved-objects index holding the index patterns |
| `REFRESH_INTERVAL` | `1h` | Snapshot refresh interval as a Go duration; minimum `1m` |
| `LISTEN_PORT` | `8080` | HTTP listen port |
| `CLUSTER_NAME` | `""` | Display name shown in the UI header |
| `LOG_LEVEL` | `info` | debug, info, warn, error |
| `LOG_FORMAT` | `json` | json or text |

The account behind the basic auth credentials only needs read access to the
saved-objects index and the index metadata of the configured targets.

## Usage

Local run:

```bash
OPENSEARCH_URL=https://opensearch.example.com:443 \
OPENSEARCH_USERNAME=viewer \
OPENSEARCH_PASSWORD=${SECRET_NAME} \
make run
```

Container:

```bash
docker run --rm -p 8080:8080 \
  -e OPENSEARCH_URL=https://opensearch.example.com:443 \
  -e OPENSEARCH_USERNAME=viewer \
  -e OPENSEARCH_PASSWORD=${SECRET_NAME} \
  ghcr.io/younsl/opensearch-conflict-viewer:0.1.0
```

## Helm

A chart lives in [charts/opensearch-conflict-viewer](./charts/opensearch-conflict-viewer)
and is published to `oci://ghcr.io/younsl/charts/opensearch-conflict-viewer`.

```bash
helm install opensearch-conflict-viewer \
  oci://ghcr.io/younsl/charts/opensearch-conflict-viewer \
  --set config.opensearchUrl=https://opensearch.example.com:443
```

## Development

```bash
make test       # race tests
make coverage   # coverage gate (70% minimum)
make lint       # gofmt check + go vet
make build      # static binary into bin/
```
