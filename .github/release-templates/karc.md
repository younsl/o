# ${PROJECT_NAME} ${VERSION}

**[karc](https://github.com/${REPOSITORY}/tree/main/box/kubernetes/karc)** - Karpenter NodePool consolidation manager CLI tool built with Rust.

## Features

- NodePool consolidation status with disruption schedule timetable
- Timezone-aware schedule window display (auto-detect or `--timezone`)
- Pause/resume consolidation via budget manipulation
- Karpenter API version detection with v1/v1beta1 fallback
- Fallback row showing unbounded disruption when no schedule is active

## Installation

### Binary Installation

Download the appropriate binary for your platform:

${CHECKSUMS_TABLE}

**Quick install** (auto-detects platform):

```bash
# Detect platform
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

# Download and install
curl -LO https://github.com/${REPOSITORY}/releases/download/karc/${VERSION}/karc-${OS}-${ARCH}.tar.gz
tar -xzf karc-${OS}-${ARCH}.tar.gz
chmod +x karc-${OS}-${ARCH}
sudo mv karc-${OS}-${ARCH} /usr/local/bin/karc

# Verify installation
karc --version
```

### From Source

Requires Rust 1.93 or later:

```bash
git clone https://github.com/${REPOSITORY}.git
cd o/box/kubernetes/karc
cargo build --release
./target/release/karc --version
```

## Usage

```bash
# Show all NodePools status
karc status

# Show status with timezone conversion
karc status --timezone Asia/Seoul

# Pause a specific NodePool
karc pause <NODEPOOL>

# Pause all NodePools
karc pause all

# Resume all NodePools (skip confirmation)
karc resume all --yes

# Preview only
karc pause <NODEPOOL> --dry-run

# Show help
karc --help
```

## Documentation

- [README](https://github.com/${REPOSITORY}/blob/main/box/kubernetes/karc/README.md)

## Built With

- **Rust 1.93+ Edition 2024** - Memory safety, zero-cost abstractions
- **Tokio** - Async runtime
- **Clap** - CLI argument parsing
- **kube-rs** - Kubernetes API client
- **tabled** - Table rendering
- **chrono-tz** - Timezone conversion
