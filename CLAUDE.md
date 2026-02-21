# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

A monorepo serving as a DevOps toolbox containing Kubernetes utilities, automation scripts, infrastructure code, and engineering documentation.

All applications in `kubernetes/`, `tools/`, and `containers/` are built with **[Rust](https://github.com/rust-lang/rust) 1.93+**. Rust provides key operational benefits: minimal container sizes, low memory footprint, single static binaries with no runtime dependencies, memory safety preventing null pointer and buffer overflow crashes, and compile-time guarantees ensuring system stability in production.

## Design Philosophy

Kubernetes addons and tools follow the [Unix philosophy](https://en.wikipedia.org/wiki/Unix_philosophy) of "Do One Thing and Do It Well". Rather than building monolithic solutions, each component is designed to solve specific operational problems with focus and simplicity.

## Commit Message Convention

Format: `[<TOOLNAME>] <type>(<scope>): <detail message>`

- 특정 툴에 해당하지 않는 변경은 `[repo]`를 사용합니다.

Examples:
- `[kup] feat(upgrade): add EKS 1.34 support`
- `[karc] fix(status): correct nodepool display alignment`
- `[ij] refactor(scan): improve multi-region parallel scanning`
- `[repo] chore(docs): update CLAUDE.md`

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, etc.

## Development Commands

### Rust Projects

Standard Makefile patterns for Rust tools (ij, kup, karc, qg, s3vget, promdrop, gss, filesystem-cleaner, elasticache-backup, redis-console, trivy-collector):

```bash
# Core build commands
make build          # Build debug binary (target/debug/)
make release        # Build optimized release binary (target/release/)
make build-all      # Build for all platforms (requires cross)

# Development workflow
make run            # Build and run with example
make dev            # Run with verbose/debug logging
make install        # Install to ~/.cargo/bin/
make test           # Run tests (cargo test --verbose)

# Code quality
make fmt            # Format code (cargo fmt)
make lint           # Run clippy (cargo clippy -- -D warnings)
make check          # Check code without building
make deps           # Update dependencies (cargo update)
make clean          # Remove build artifacts

# Direct cargo commands for specific tests
cargo test --verbose                    # Run all tests
cargo test --verbose test_name          # Run specific test
cargo test --package package_name       # Run tests for specific package
```

### Container Operations

```bash
make docker-build   # Build Docker image
make docker-push    # Push to ECR (requires AWS credentials)
make deploy         # Deploy to Kubernetes (where available)
```

**Container-Specific Notes**:
- **filesystem-cleaner**: Includes `make all` target that runs fmt + lint + test + build
- **elasticache-backup**: Supports multi-arch builds and has `run-json` target for JSON log testing
- **hugo**: Built from external sources via workflow_dispatch (no local Dockerfile)
- Update ECR_REGISTRY variable in Makefiles before pushing

### Terraform Projects

Standard Terraform workflow for infrastructure modules:

```bash
terraform init      # Initialize Terraform
terraform validate  # Validate configuration
terraform plan      # Plan changes
terraform apply     # Apply changes
terraform destroy   # Destroy resources
```

**Available Modules**:
- `vault/irsa/` - Vault auto-unseal with AWS KMS integration

### Helm Charts

Standard Makefile patterns for Helm charts (grafana-dashboards, gss, elasticache-backup, redis-console, trivy-collector):

```bash
# Development
make lint       # Lint the chart (helm lint)
make template   # Render templates locally
make install    # Install to cluster
make upgrade    # Upgrade release
make uninstall  # Uninstall release

# Packaging and distribution
make package    # Package chart as tgz
make push       # Push to OCI registry (GHCR)
make clean      # Remove packaged chart

# OCI registry usage (requires crane for version discovery)
crane ls ghcr.io/younsl/charts/{chart-name}
helm install {name} oci://ghcr.io/younsl/charts/{chart-name} --version x.y.z
```

**Chart Distribution**:
- All charts are distributed via OCI registry at `ghcr.io/younsl/charts/`
- Use [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md) instead of `helm search repo` to discover versions

## High-Level Architecture

### Repository Structure

```
box/
├── kubernetes/             # K8s controllers, policies, helm charts
│   ├── elasticache-backup/# ElastiCache S3 backup automation (Rust, container)
│   ├── grafana-dashboards/# Grafana dashboard ConfigMaps (Helm chart only)
│   ├── gss/               # GHES scheduled workflow scanner (Rust, container)
│   ├── karc/              # Karpenter NodePool consolidation manager CLI (Rust)
│   ├── kup/               # EKS cluster upgrade CLI tool (Rust)
│   ├── promdrop/          # Prometheus metric filter generator (Rust, CLI + container)
│   ├── redis-console/     # Interactive Redis cluster management CLI (Rust, CLI + container)
│   └── trivy-collector/   # Multi-cluster Trivy report collector/viewer (Rust, container)
├── tools/                 # CLI utilities
│   ├── ij/                # Interactive EC2 SSM connection tool (Rust)
│   ├── qg/                # QR code generator (Rust)
│   └── s3vget/            # S3 object version downloader (Rust)
├── containers/            # Custom container images
│   ├── backstage/         # Backstage with GitLab Auto Discovery (Node.js)
│   ├── filesystem-cleaner/# File system cleanup tool (Rust)
│   └── logstash-with-opensearch-plugin/  # Logstash with OpenSearch plugin for ECK
├── scripts/               # Automation scripts by platform
│   ├── aws/               # AWS resource management
│   ├── github/            # Repository automation
│   └── k8s-registry-io-stat/  # K8s connectivity testing
└── terraform/             # Infrastructure as Code
    └── vault/irsa/        # Vault auto-unseal with AWS KMS
```

### Architectural Patterns

**Kubernetes Applications**:
- DaemonSet pattern for node-level operations
- IMDS access via host network when required
- IRSA for AWS API authentication
- Health endpoints on port 8080
- Graceful shutdown handling with signal handling

**Rust Application Structure**:
- `src/main.rs` - CLI entry point with Clap argument parsing
- `src/lib.rs` - Core library code (if applicable)
- `src/*.rs` - Module files for specific functionality
- `Cargo.toml` - Rust dependencies and metadata
- Tokio async runtime for concurrent operations
- Structured logging with tracing crate
- Environment variable support via Clap

**CI/CD Pipeline**:
- GitHub Actions for automated releases
- Multi-arch builds (linux/darwin, amd64/arm64)
- Automated binary releases with tags
- Container image push to GHCR (GitHub Container Registry) and ECR

**Rust Cross-Compilation Requirements**:

Rust cross-compilation is more complex than Go and requires additional setup:

```yaml
# For ARM64 cross-compilation on x86_64 (GitHub Actions example)
- name: Install cross-compilation tools (Linux ARM64)
  if: matrix.target == 'aarch64-unknown-linux-gnu'
  run: |
    sudo apt-get install -y gcc-aarch64-linux-gnu g++-aarch64-linux-gnu

- name: Configure cross-compilation (Linux ARM64)
  if: matrix.target == 'aarch64-unknown-linux-gnu'
  run: |
    echo "CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc" >> $GITHUB_ENV
    echo "CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc" >> $GITHUB_ENV
    echo "CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++" >> $GITHUB_ENV
```

**Why Rust cross-compilation is more complex than Go**:
- Go: Self-contained compiler with built-in cross-compilation (`GOOS=linux GOARCH=arm64 go build`)
- Rust: Requires system linker and C toolchain for target architecture
- Rust crates often depend on C libraries (openssl, sqlite, etc.)
- Must install target-specific gcc/g++ and configure linker paths

See `.github/workflows/release-promdrop.yml` for complete ARM64 cross-compilation example.

## AWS Integration Points

- **ECR**: Container registry for Kubernetes deployments
- **GHCR**: GitHub Container Registry for public container images
- **IAM/IRSA**: Service account to IAM role mapping for Kubernetes pods
- **KMS**: Vault auto-unseal encryption
- **ElastiCache**: Snapshot and backup management
- **S3**: Backup storage and lifecycle management

Configure AWS credentials via environment variables or IAM instance profiles.

## Tool-Specific Notes

### ij - Interactive EC2 Session Manager Connection Tool (Rust)

Interactive CLI tool for connecting to EC2 instances via AWS SSM Session Manager with multi-region scanning and SSH-style escape sequence support. Inspired by [gossm](https://github.com/gjbae1212/gossm).

```bash
# Connect using AWS profile (scans all regions)
ij prod                        # Use AWS profile
ij -r ap-northeast-2 prod      # Specific region (faster)
ij -t Environment=production   # Filter by tag

# Build commands
make build      # Debug build
make release    # Optimized release build
make install    # Install to ~/.cargo/bin/
```

**Features**:
- Multi-region parallel scanning (22 AWS regions)
- Interactive instance selection with fuzzy search
- Tag-based filtering (`-t Key=Value`)
- SSH-style escape sequences (`Enter ~ .` to disconnect stuck sessions)

**AWS Permissions Required**: `ec2:DescribeInstances`, `ssm:StartSession` (EC2 instances need `AmazonSSMManagedInstanceCore` policy)

### kup - EKS Cluster Upgrade CLI Tool (Rust)

Interactive EKS cluster upgrade tool. Analyzes cluster insights, plans sequential control plane upgrades, and updates add-ons and managed node groups. Inspired by [clowdhaus/eksup](https://github.com/clowdhaus/eksup).

```bash
kup                              # Interactive mode
kup --dry-run                    # Plan only, no execution
kup -c my-cluster -t 1.34 --yes  # Non-interactive mode
kup -r ap-northeast-2            # Specific region
kup --skip-pdb-check             # Skip PDB drain deadlock check

# Build commands
make build      # Debug build
make release    # Optimized release build
make install    # Install to ~/.cargo/bin/
```

**Features**:
- Interactive cluster and version selection
- Cluster Insights analysis (deprecated APIs, add-on compatibility)
- Sequential control plane upgrades (1 minor version at a time)
- Sync mode: Update only addons/nodegroups without control plane upgrade
- Automatic add-on version upgrades
- Managed node group rolling updates
- PDB drain deadlock detection before node group rolling updates

**PDB Drain Deadlock Detection**:
Checks `status.disruptionsAllowed == 0` on all PDBs via Kubernetes API before MNG rolling updates. Connects to the EKS API server using endpoint/CA from `describe_cluster` and a bearer token from `aws eks get-token`. Failures are non-fatal warnings. Use `--skip-pdb-check` to skip.

**Constraints**:
- Control plane upgrades limited to 1 minor version at a time (e.g., 1.28 → 1.30 requires two steps)
- Managed Node Groups only (self-managed and Karpenter nodes not supported)

**AWS Permissions Required**: `eks:ListClusters`, `eks:DescribeCluster`, `eks:UpdateClusterVersion`, `eks:DescribeUpdate`, `eks:ListInsights`, `eks:DescribeInsight`, `eks:ListAddons`, `eks:DescribeAddon`, `eks:DescribeAddonVersions`, `eks:UpdateAddon`, `eks:ListNodegroups`, `eks:DescribeNodegroup`, `eks:UpdateNodegroupVersion`, `autoscaling:DescribeAutoScalingGroups`

### karc - Karpenter NodePool Consolidation Manager CLI (Rust)

CLI tool for managing Karpenter NodePool consolidation. View disruption status with schedule timetables, pause and resume consolidation across NodePools.

```bash
karc status                  # Show all NodePool status
karc status my-nodepool      # Show specific NodePool
karc pause my-nodepool       # Pause consolidation
karc pause all               # Pause all NodePools
karc resume my-nodepool      # Resume consolidation
karc resume all              # Resume all NodePools
karc pause all --dry-run     # Preview without applying
karc resume all --yes        # Skip confirmation prompt

# Build commands
make build      # Debug build
make release    # Optimized release build
make install    # Install to ~/.cargo/bin/
make install-local  # Install to /usr/local/bin/
```

**Features**:
- Kubectl-style status table with NodePool disruption details
- Schedule-based disruption budget timetable with timezone-aware window display
- Pause consolidation by prepending `{nodes: "0"}` budget
- Resume consolidation by removing pause budgets (preserves scheduled budgets)
- Automatic Karpenter API version detection (v1, v1beta1 fallback)
- Interactive confirmation prompts (skippable with `--yes`)
- Dry-run mode for previewing changes

**Pause/Resume Mechanism**:
- **Pause**: Prepends `{nodes: "0"}` unscheduled budget to prevent consolidation
- **Resume**: Removes only unscheduled zero-node budgets; scheduled budgets are preserved

**Constraints**:
- Requires Karpenter v1 or v1beta1 NodePool CRD installed in the cluster
- Requires RBAC: `karpenter.sh` apiGroup, `nodepools`/`nodeclaims` resources, `get`/`list`/`patch` verbs

### qg - QR Code Generator (Rust)

```bash
# Generate QR code from URL
./target/release/qg https://github.com/

# Or use Makefile
make run        # Build and run with example URL

# Build commands
make build      # Debug build
make release    # Optimized release build
make install    # Install to ~/.cargo/bin/

# Custom options
qg --width 200 --height 200 --filename custom.png https://example.com
qg --quiet https://example.com  # Suppress output
```

**Note**: Uses qrcode crate for generation and Clap for CLI.

### s3vget - S3 Object Version Downloader (Rust)

S3 object version downloader with interactive prompts and configurable timezone support.

```bash
# Interactive mode with prompts
./target/release/s3vget

# Or use Makefile
make run        # Build and run with interactive prompts
make dev        # Run with verbose logging

# Build commands
make build      # Debug build
make release    # Optimized release build
make install    # Install to ~/.cargo/bin/

# All parameters via CLI
s3vget \
  --bucket my-bucket \
  --key path/to/file.json \
  --start 2025-10-21 \
  --end 2025-10-22 \
  --timezone America/New_York

# Download all versions without date filtering
s3vget --bucket my-bucket --key path/to/file.json --no-interactive

# Use 'now' as end date
s3vget -b my-bucket -k path/to/file.json -s 2025-10-01 -e now
```

**Technical Details**:
- Built with Tokio for async S3 operations
- Uses dialoguer for interactive prompts
- chrono-tz for timezone handling (default: Asia/Seoul)
- Supports multiple date formats (YYYY-MM-DD, YYYY/MM/DD, YYYYMMDD, 'now')
- Downloads files with versioned naming: `{version}_{timestamp}_{filename}.{ext}`
- Pagination support for large version lists

**AWS Permissions Required**: `s3:GetObject`, `s3:GetObjectVersion`, `s3:ListBucket`, `s3:ListBucketVersions`

### promdrop - Prometheus Metric Filter Generator (Rust)

Generates Prometheus metric drop configurations from mimirtool analysis.

```bash
# Generate metric drop configs from mimirtool analysis
# First run mimirtool to analyze metrics:
mimirtool analyze prometheus --output=prometheus-metrics.json

# Then generate drop configs (Rust version):
./target/release/promdrop --file prometheus-metrics.json

# Or use Makefile
make run        # Build and run with example
make release    # Optimized release build

# Custom output locations
promdrop --file prometheus-metrics.json \
  --txt-output-dir ./unused \
  --output combined_relabel_configs.yaml

# Container usage
docker run --rm -v $(pwd):/data \
  ghcr.io/younsl/promdrop:latest \
  --file /data/prometheus-metrics.json
```

**Technical Details**:
- Built with Rust using serde for JSON/YAML parsing
- CLI built with Clap for argument parsing
- Available as both CLI binary and container image
- Multi-arch Docker images (linux/amd64, linux/arm64)
- Automated releases via GitHub Actions (tag pattern: `promdrop/x.y.z`)

### filesystem-cleaner - Kubernetes Filesystem Cleanup Tool (Rust)

Lightweight container for automatic filesystem cleanup in Kubernetes environments.

```bash
# Quick test run
make run         # Dry-run cleanup of /tmp at 70% threshold

# Debug logging mode
make dev         # Same as run but with --log-level debug

# Container usage (as sidecar or init container)
docker run --rm -v /path:/path \
  ghcr.io/younsl/filesystem-cleaner:latest \
  --target-paths=/path --usage-threshold-percent=80
```

**Technical Details**:
- Operates as sidecar or init container
- Monitors disk usage and removes files when threshold exceeded
- Glob pattern support for include/exclude
- Graceful shutdown handling
- Structured logging with tracing crate

### elasticache-backup - ElastiCache S3 Backup Automation (Rust)

Automates ElastiCache snapshot creation and S3 export for Kubernetes CronJobs.

```bash
# Run locally with pretty logs
LOG_FORMAT=pretty ./target/debug/elasticache-backup \
  --cache-cluster-id "your-redis-cluster-001" \
  --s3-bucket-name "your-elasticache-backups"

# Run with debug logging
make dev

# Deploy as Kubernetes CronJob via Helm
helm install elasticache-backup ./box/kubernetes/elasticache-backup/charts/elasticache-backup \
  --set image.tag=0.1.0 \
  --set elasticache.cacheClusterId=your-cluster-id \
  --set s3.bucketName=your-bucket-name \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT:role/ROLE_NAME
```

**Technical Details**:
- Creates ElastiCache snapshots from read replica nodes
- Exports snapshots to S3 buckets
- Automatic cleanup of source snapshots after export
- Configurable timeouts and retry intervals
- Structured JSON logging for CloudWatch/Loki integration
- IRSA support for AWS authentication
- Multi-architecture container images
- Helm chart for easy deployment

**Workflow**: Snapshot Creation → Wait → S3 Export → Wait → Cleanup

### redis-console - Interactive Redis Cluster Management CLI (Rust)

An interactive REPL for managing multiple Redis and AWS ElastiCache clusters from a single terminal session.

```bash
# Local usage with default config
redis-console

# Specify custom config
redis-console --config /path/to/config.yaml

# Container usage
docker run --rm -it \
  -v $(pwd)/config.yaml:/etc/redis/clusters/config.yaml \
  ghcr.io/younsl/redis-console:latest

# Kubernetes deployment
kubectl exec -it -n redis-console redis-console-xxxxxx -- redis-console
```

**Configuration Format** (`~/.config/redis-console/config.yaml` or `/etc/redis/clusters/config.yaml` in containers):

```yaml
clusters:
  - alias: production
    host: redis-prod.example.com
    port: 6379
    password: ""           # Optional
    tls: false            # Optional
    cluster_mode: false   # Optional
    description: "Production Redis"

  - alias: staging
    host: redis-staging.example.com
    port: 6379
    password: "my-password"
    tls: true
    cluster_mode: false

aws_region: ap-northeast-2  # For ElastiCache
```

**REPL Commands**:
- `help`, `h` - Show help message
- `list`, `ls`, `l` - List all clusters with health status
- `connect <id|name>`, `c` - Connect to cluster by ID or alias
- `info` - Show Redis server info (when connected)
- `quit`, `exit`, `q` - Disconnect or exit
- Any Redis command when connected (e.g., `GET key`, `SET key value`, `KEYS *`)

**Technical Details**:
- Built with rustyline for REPL interface
- Multi-cluster management with seamless switching
- Health monitoring with Redis version and mode detection
- Command history navigation (↑/↓ keys)
- Colorized output with tabled formatting
- TLS and Redis Cluster mode support
- TTY detection for Kubernetes compatibility
- AWS ElastiCache integration via IRSA

**Build Commands**:
```bash
make build      # Debug build
make release    # Optimized release build
make run        # Build and run
make install    # Install to ~/.cargo/bin/
```

**Deployment** (Kubernetes with IRSA for ElastiCache):
```bash
helm install redis-console ./charts/redis-console \
  --namespace redis-console \
  --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT:role/redis-console-role
```

### trivy-collector - Multi-cluster Trivy Report Collector (Rust)

Collects Trivy Operator reports (VulnerabilityReports, SbomReports) from multiple Kubernetes clusters and provides a centralized web UI.

```bash
# Server mode (central cluster)
helm install trivy-collector ./charts/trivy-collector \
  --namespace trivy-system \
  --create-namespace \
  --set mode=server \
  --set server.persistence.enabled=true \
  --set server.ingress.enabled=true

# Collector mode (edge clusters)
helm install trivy-collector ./charts/trivy-collector \
  --namespace trivy-system \
  --create-namespace \
  --set mode=collector \
  --set collector.serverUrl=http://trivy-server.central-cluster:3000 \
  --set collector.clusterName=edge-cluster-a

# Build commands
make build      # Debug build
make release    # Optimized release build
make run        # Build and run server locally
make dev        # Run with debug logging
```

**Technical Details**:
- Dual-mode architecture: Server (central web UI + SQLite storage) or Collector (edge watcher)
- Watches VulnerabilityReports and SbomReports CRDs via kube-rs
- Web UI for Security Engineers (no kubectl required)
- OpenAPI documentation at `/api-docs/openapi.json`
- Helm chart for both modes

**Why this exists**: Trivy Operator creates CRDs but provides no interface for Security Engineers to analyze data without Kubernetes expertise.

### logstash-with-opensearch-plugin - Logstash for ECK

Pre-built Logstash image with `logstash-output-opensearch` plugin for ECK Operator.

```bash
# Build locally
docker build -t logstash-with-opensearch-plugin:8.17.0 .

# Use in ECK Logstash resource
image: ghcr.io/younsl/logstash-with-opensearch-plugin:8.17.0
```

**Why this exists**: Official Logstash image lacks the OpenSearch plugin; installing via initContainer causes 5+ minute startup delays.

### gss - GHES Schedule Scanner (Rust)

Kubernetes add-on for monitoring and analyzing CI/CD scheduled workflows in GitHub Enterprise Server. Runs as a CronJob with Slack Canvas integration.

```bash
# Build commands
make build      # Debug build
make release    # Optimized release build
make run        # Build and run
make dev        # Run with debug logging
make install    # Install to ~/.cargo/bin/

# Container usage
docker run --rm \
  -e GITHUB_TOKEN=ghp_xxxx \
  -e GITHUB_ORG=my-org \
  -e GITHUB_BASE_URL=https://github.example.com \
  ghcr.io/younsl/gss:latest

# Kubernetes deployment via Helm
helm install gss ./charts/gss \
  --set configMap.data.GITHUB_BASE_URL=https://github.example.com \
  --set configMap.data.GITHUB_ORG=my-org
```

**Technical Details**:
- Scans GitHub Enterprise Server organizations for scheduled workflows
- Async concurrent scanning with configurable parallelism
- Multiple publishers: console output and Slack Canvas
- UTC/KST timezone conversion for schedule visibility
- Exclude repos via ConfigMap-mounted exclude-repos.txt
- Helm chart for Kubernetes CronJob deployment
- IRSA-compatible for AWS environments

**Environment Variables**:
- `GITHUB_TOKEN`: GitHub Personal Access Token (required)
- `GITHUB_ORG`: Target GitHub organization (required)
- `GITHUB_BASE_URL`: GitHub Enterprise Server URL (required)
- `PUBLISHER_TYPE`: Output format (`console` or `slack-canvas`, default: `console`)
- `CONCURRENT_SCANS`: Max parallel repository scans (default: `10`)
- `SLACK_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_CANVAS_ID`: For Slack Canvas publisher

### grafana-dashboards - Grafana Dashboard ConfigMaps (Helm Chart)

Helm chart that deploys Grafana dashboards as Kubernetes ConfigMaps for automatic provisioning via Grafana sidecar.

```bash
# Development commands
make lint       # Lint the chart
make template   # Render templates locally
make install    # Install to cluster
make upgrade    # Upgrade release
make uninstall  # Uninstall release

# OCI registry operations
make package    # Package chart as tgz
make push       # Push to GHCR OCI registry

# List available versions (requires crane)
crane ls ghcr.io/younsl/charts/grafana-dashboards

# Install from OCI registry
helm install grafana-dashboards oci://ghcr.io/younsl/charts/grafana-dashboards
```

**Technical Details**:
- Helm chart only (no application code)
- Distributed via OCI registry (GHCR)
- Works with Grafana sidecar for automatic dashboard discovery
- Per-dashboard folder, labels, and annotations configuration
- Dashboard JSON files stored in `dashboards/` directory

## Release Workflow

GitHub Actions automatically builds and releases on tag push:

```bash
# CLI tool releases (pattern: {tool}/x.y.z)
git tag ij/1.0.0 && git push --tags
git tag kup/1.0.0 && git push --tags
git tag karc/1.0.0 && git push --tags
git tag promdrop/1.0.0 && git push --tags

# Container image releases (pattern: {container}/x.y.z)
git tag filesystem-cleaner/1.0.0 && git push --tags
git tag elasticache-backup/1.0.0 && git push --tags
git tag redis-console/1.0.0 && git push --tags
git tag gss/1.0.0 && git push --tags
git tag trivy-collector/1.0.0 && git push --tags
git tag logstash-with-opensearch-plugin/8.17.0 && git push --tags
git tag backstage/1.0.0 && git push --tags

# Helm chart releases (pattern: {chart}/charts/x.y.z)
git tag elasticache-backup/charts/1.0.0 && git push --tags
git tag redis-console/charts/1.0.0 && git push --tags
git tag trivy-collector/charts/1.0.0 && git push --tags
git tag gss/charts/1.0.0 && git push --tags
git tag grafana-dashboards/charts/1.0.0 && git push --tags

# Available workflows:
# - release-ij.yml                           (Rust CLI)
# - release-kup.yml                          (Rust CLI)
# - release-karc.yml                         (Rust CLI)
# - release-promdrop.yml                     (Rust CLI + container)
# - release-rust-containers.yml              (Unified Rust container release: filesystem-cleaner, elasticache-backup, redis-console, gss)
# - release-trivy-collector.yml              (Rust container)
# - release-helm-chart.yml                   (Unified Helm chart release to OCI registry)
# - release-logstash-with-opensearch-plugin.yml (Container image)
# - release-backstage.yml                    (Container image)
# - clean-workflow-runs.yml                  (Maintenance: cleanup old workflow runs)

# Rust tools without automated releases (manual release required):
# - qg (QR code generator)
# - s3vget (S3 object version downloader)
```

## Testing Guidelines

**Current State**: Most tools lack comprehensive test coverage but Makefiles include test targets.

**When Adding Tests**:

Rust projects:
- Place unit tests in same file using `#[cfg(test)]` module
- Integration tests in `tests/` directory
- Use `cargo test --verbose` for running tests
- Use `#[tokio::test]` for async tests
- Mock external dependencies using traits
- Use `tempfile::TempDir` for filesystem tests

## Common Patterns

**Version Embedding**:
- Build-time environment variables or `build.rs` scripts

**Logging**:
- tracing crate with configurable format (JSON/pretty)

**Configuration**:
- Environment variables with CLI flag overrides via Clap

**Async/Concurrency**:
- Tokio async runtime with `async/await`

**Graceful Shutdown**:
- Signal handling (SIGTERM, SIGINT) with cleanup logic

## Backstage Troubleshooting

### @backstage/ui CSS Causes Layout Issues

**Problem**: Importing `@backstage/ui/css/styles.css` causes right-side whitespace/margin issues in the main content area.

**Root Cause**: The `@backstage/ui` CSS overrides existing Backstage layout styles, breaking the default page layout.

**Context**: The `@backstage-community/plugin-announcements` plugin (v2.0.0+) uses `@backstage/ui` components (`HeaderPage`, `Container`, `Flex`) internally. Without the CSS import, the Announcements page renders as unstyled text only.

**Trade-off**:
| Option | Pros | Cons |
|--------|------|------|
| Import CSS | Announcements plugin styled correctly | Layout breaks (right whitespace) |
| Remove CSS | Original layout preserved | Announcements plugin unstyled |

**Workaround**: If you need the Announcements plugin with proper styling, import the CSS and add custom CSS overrides to fix the layout issues. Alternatively, avoid the CSS import and accept unstyled Announcements pages.

### Enabling Guest Login

Guest login requires configuration in **both** backend config and frontend code.

**1. Backend Configuration** (`app-config.yaml`):
```yaml
auth:
  providers:
    guest:
      dangerouslyAllowOutsideDevelopment: true  # Allow guest in production
```

**2. Frontend Configuration** (`packages/app/src/App.tsx`):
```tsx
const CustomSignInPage = (props: any) => (
  <SignInPage
    {...props}
    providers={[
      'guest',  // Add this line to enable guest login button
      {
        id: 'keycloak',
        title: 'Keycloak',
        message: 'Sign in using Keycloak',
        apiRef: keycloakOIDCAuthApiRef,
      },
    ]}
  />
);
```

**Important Notes**:
- Backstage does NOT support dynamically enabling/disabling guest login via config alone
- The `'guest'` provider in SignInPage is hardcoded in the frontend
- To disable guest login in production, remove `'guest'` from the providers array and rebuild the container image
- Reference: https://backstage.io/docs/auth/guest/provider/
