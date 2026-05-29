# Development

## Build Commands

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

## Docker Commands

```bash
# Build Docker image
make docker-build

# Build for all platforms (requires cross)
make build-all

# Push to registry (update ECR_REGISTRY in Makefile first)
make docker-push
```

## Local Testing

```bash
# Terminal 1: Run server
MODE=server STORAGE_PATH=/tmp/trivy-data LOG_FORMAT=pretty ./target/debug/trivy-collector

# Terminal 2: Run collector (requires Trivy Operator in cluster)
MODE=collector SERVER_URL=http://localhost:3000 CLUSTER_NAME=local-test LOG_FORMAT=pretty ./target/debug/trivy-collector
```

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
