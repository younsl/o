# GHES Schedule Scanner (GSS)

[![Container Image](https://img.shields.io/badge/ghcr.io-younsl%2Fgss-000000?style=flat-square&logo=github&logoColor=white)](https://github.com/younsl/o/pkgs/container/gss)
[![Helm Chart](https://img.shields.io/badge/helm_chart-ghcr.io%2Fyounsl%2Fcharts%2Fgss-000000?style=flat-square&logo=helm&logoColor=white)](https://github.com/younsl/o/pkgs/container/charts%2Fgss)
[![Rust Version](https://img.shields.io/badge/rust-1.93-000000?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![License](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black&logo=github&logoColor=white)](https://github.com/younsl/o/blob/main/box/kubernetes/gss/LICENSE)

> _GSS stands for GHES(GitHub Enterprise Server) Schedule Scanner._

GSS is a high-performance Kubernetes add-on for DevOps and SRE teams to monitor and analyze CI/CD workflows in [GitHub Enterprise Server](https://docs.github.com/ko/enterprise-server/admin/all-releases). Written in Rust, GSS runs as a kubernetes [cronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/) that scans and analyzes scheduled workflows across your GHES environment.

## Overview

GHES Schedule Scanner runs as a kubernetes cronJob that periodically scans GitHub Enterprise Server repositories for scheduled workflows. It collects information about:

- Workflow names and schedules
- Last execution status
- Last author details (GitHub username)
- Repository information

The scanner is designed for high performance with async/concurrent scanning capabilities and provides timezone conversion between UTC and KST for better schedule visibility.

## Features

- **GitHub Enterprise Server Integration**: Compatible with self-hosted [GitHub Enterprise Server (3.11+)](https://docs.github.com/ko/enterprise-server/admin/all-releases)
- **Organization-wide Scanning**: Scan scheduled workflows across all repositories in an organization
- **Timezone Support**: UTC/KST timezone conversion for better schedule visibility
- **Status Monitoring**: Track workflow execution status and identify failed workflows
- **High Performance**: Async concurrent scanning (scans 900+ repositories in about 15-18 seconds)
- **Multiple Publishers**: Publish results to console or Slack Canvas
- **Kubernetes Native**: Runs as a Kubernetes cronJob for periodic scanning
- **Low Resource Usage**: Optimized for minimal CPU and memory consumption

## Quick Start

### Prerequisites

- Rust 1.93+ (2024 edition)
- GitHub Personal Access Token with `repo` and `workflow` scopes
- Access to GitHub Enterprise Server instance

### Building

```bash
# Build debug binary
make build

# Build optimized release binary
make release
```

### Running Locally

Set environment variables needed for local development:

```bash
# Required
export GITHUB_TOKEN="ghp_token"
export GITHUB_ORG="your_organization"
export GITHUB_BASE_URL="https://your-ghes-domain"

# Optional
export LOG_LEVEL="info"
export PUBLISHER_TYPE="console" # Available values: `console`, `slack-canvas`
export CONCURRENT_SCANS="10"    # Number of parallel repository scans

# For Slack Canvas Publisher
export SLACK_TOKEN="xoxb-token"
export SLACK_CHANNEL_ID="C01234ABCD"
export SLACK_CANVAS_ID="F01234ABCD"
```

Run the application:

```bash
# Using cargo
cargo run --release

# Or using the binary
./target/release/ghes-schedule-scanner
```

## Output Examples

### Console Output

```bash
Version: 1.0.0
Build Date: 2025-01-23T10:30:00Z
Git Commit: abc1234
Rust Version: 1.93.0

NO   REPOSITORY                        WORKFLOW                            UTC SCHEDULE  KST SCHEDULE  LAST AUTHOR  LAST STATUS
1    api-test-server                   api unit test                       0 15 * * *    0 0 * * *     younsl       completed
2    daily-batch                       daily batch service                 0 0 * * *     0 9 * * *     ddukbg       completed

Total: 2 scheduled workflows found in 100 repositories (5 excluded)
Scan duration: 18.5s
```

## Configuration

### Required Environment Variables

| Variable          | Description                  | Example                      |
| ----------------- | ---------------------------- | ---------------------------- |
| `GITHUB_TOKEN`    | GitHub Personal Access Token | `ghp_xxxxxxxxxxxx`           |
| `GITHUB_ORG`      | Target GitHub organization   | `my-company`                 |
| `GITHUB_BASE_URL` | GitHub Enterprise Server URL | `https://github.example.com` |

### Optional Environment Variables

| Variable                      | Description                                 | Default   |
| ----------------------------- | ------------------------------------------- | --------- |
| `LOG_LEVEL`                   | Logging level (debug, info, warn, error)    | `info`    |
| `PUBLISHER_TYPE`              | Output format (console, slack-canvas)       | `console` |
| `REQUEST_TIMEOUT`             | HTTP request timeout for scanning (seconds) | `60`      |
| `CONCURRENT_SCANS`            | Max concurrent repository scans             | `10`      |
| `CONNECTIVITY_MAX_RETRIES`    | Connection retry attempts                   | `3`       |
| `CONNECTIVITY_RETRY_INTERVAL` | Retry delay (seconds)                       | `5`       |
| `CONNECTIVITY_TIMEOUT`        | Connectivity check timeout (seconds)        | `5`       |

## Publishers

GSS supports multiple publishers to display scan results:

### Console Publisher

Outputs scan results to the console/logs with structured JSON logging. This is the default publisher.

```bash
export PUBLISHER_TYPE="console"
```

### Slack Canvas Publisher

Publishes scan results to a Slack Canvas, providing a rich, interactive view of your scheduled workflows.

Required environment variables:

- `SLACK_TOKEN`: Slack Bot Token (must start with `xoxb-`)
- `SLACK_CHANNEL_ID`: Slack Channel ID
- `SLACK_CANVAS_ID`: Slack Canvas ID

```bash
export PUBLISHER_TYPE="slack-canvas"
export SLACK_TOKEN="xoxb-your-token"
export SLACK_CHANNEL_ID="C01234ABCD"
export SLACK_CANVAS_ID="F01234ABCD"
```

## Development

### Running Tests

```bash
# Run all tests
cargo test

# Run tests with output
cargo test -- --nocapture

# Run specific test
cargo test test_config_load
```

### Code Quality

```bash
# Format code
cargo fmt

# Check formatting
cargo fmt -- --check

# Run linter
cargo clippy -- -D warnings
```

## Docker

### Building Docker Image

```bash
# Build using Makefile
make docker-build

# Or manually
docker build -t gss:latest .
```

### Running with Docker

```bash
docker run --rm \
  -e GITHUB_TOKEN=ghp_xxxx \
  -e GITHUB_ORG=my-org \
  -e GITHUB_BASE_URL=https://github.example.com \
  gss:latest
```

## Kubernetes Deployment

This chart is distributed as an [OCI](https://helm.sh/docs/topics/registries/) artifact via [GHCR](https://ghcr.io). The recommended installation method is `helm install` directly from the OCI registry.

```bash
# Pull chart from OCI registry and untar
helm pull oci://ghcr.io/younsl/charts/gss --version 0.1.0 --untar

# Edit values.yaml to configure environment variables, image tag, etc.
vi gss/values.yaml

# Install using the local chart with custom values
helm install gss ./gss -n gss --create-namespace -f gss/values.yaml
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.
