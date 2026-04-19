# snowflake-exporter

<img src="./docs/assets/snowflake.svg" alt="Snowflake logo" width="64" />

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-snowflake--exporter-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/snowflake-exporter)
[![Helm Chart](https://img.shields.io/badge/ghcr.io-charts%2Fsnowflake--exporter-black?style=flat-square&logo=helm&logoColor=white)](https://github.com/younsl/o/pkgs/container/charts%2Fsnowflake-exporter)
[![Rust](https://img.shields.io/badge/rust-1.95.0-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![Snowflake](https://img.shields.io/badge/snowflake-SQL%20API%20v2-black?style=flat-square&logo=snowflake&logoColor=white)](https://docs.snowflake.com/en/developer-guide/sql-api/reference)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

Prometheus exporter for Snowflake account usage metrics. Periodically runs
`ACCOUNT_USAGE` queries via the Snowflake SQL API v2 and exposes the results
on a `/metrics` endpoint.

Inspired by [grafana/snowflake-prometheus-exporter](https://github.com/grafana/snowflake-prometheus-exporter).

## Highlights

- Rust 1.95.0 (edition 2024), async Tokio runtime
- Statically linked musl binary built with `cargo-zigbuild`
- Distroless `scratch` container image
- Snowflake Programmatic Access Token (PAT) authentication — no RSA keys, no passwords
- Single-replica recommended — `ACCOUNT_USAGE` is account-wide
- Helm chart with helm-docs-formatted `values.yaml`

## Documentation

- [docs/metrics.md](./docs/metrics.md) — every exported metric, type, labels, and source view
- [docs/installation.md](./docs/installation.md) — Helm installation guide (PAT)

## Quick start (Kubernetes)

```bash
helm install snowflake-exporter \
  oci://ghcr.io/younsl/charts/snowflake-exporter \
  --namespace monitoring \
  --create-namespace \
  --set config.snowflake.account=xy12345.ap-northeast-2.aws \
  --set config.snowflake.role=METRICS_ROLE \
  --set config.snowflake.warehouse=METRICS_WH \
  --set auth.token="$TOKEN_SECRET"
```

See [docs/installation.md](./docs/installation.md) for PAT generation,
External Secrets Operator workflows, and troubleshooting.

## Build

```bash
make build        # Debug build
make release      # Optimized release binary
make test         # Run unit tests
make coverage     # Run cargo llvm-cov
make docker-build # Cross-compile to musl + build scratch image
```

## Run locally

```bash
# 1. Scaffold config.local.yaml and .token at the repo root (git-ignored)
make dev-setup

# 2. Edit config.local.yaml — fill in account / role / warehouse
# 3. Paste your PAT into .token (no trailing newline needed)

# 4. Run
make run
# → HTTP server on 127.0.0.1:9975
curl -s localhost:9975/metrics | grep '^snowflake_up'
```

`config.local.yaml` and `.token` are both git-ignored; never commit the
token or a config containing real account identifiers.

## Configuration

Config is loaded from a YAML file (default `/etc/snowflake-exporter/config.yaml`)
and can be overridden per environment variable (`SNOWFLAKE_EXPORTER_*`).

Required Snowflake fields: `account`, `role`, `warehouse`, `token_path`.
See `charts/snowflake-exporter/values.yaml` for the full schema.

## License

MIT
