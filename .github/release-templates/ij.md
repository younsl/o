# ${PROJECT_NAME} ${VERSION}

**[ij](https://github.com/${REPOSITORY}/tree/main/box/tools/ij)** (Infra Janitor) - Interactive EC2 Session Manager connection tool with fuzzy search and port forwarding.

Inspired by [gossm](https://github.com/gjbae1212/gossm).

## Features

- Multi-region parallel scanning (22 AWS regions)
- Fuzzy search with real-time filtering
- Interactive instance selection
- SSH-style escape sequences (`Enter ~ .` to disconnect)
- SSM port forwarding (`-L` flag, SSH-style syntax)

## Installation

### Homebrew (macOS)

```bash
brew tap younsl/tap
brew install ij
```

### Binary Installation

Download the appropriate binary for your platform:

${CHECKSUMS_TABLE}

**Quick install** (auto-detects platform):

```bash
# Detect platform
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

# Download and install
curl -LO https://github.com/${REPOSITORY}/releases/download/ij/${VERSION}/ij-${OS}-${ARCH}.tar.gz
tar -xzf ij-${OS}-${ARCH}.tar.gz
chmod +x ij-${OS}-${ARCH}
sudo mv ij-${OS}-${ARCH} /usr/local/bin/ij

# Verify installation
ij --version
```

### From Source

Requires Rust 1.92 or later:

```bash
git clone https://github.com/${REPOSITORY}.git
cd o/box/tools/ij
cargo build --release
./target/release/ij --version
```

## Usage

```bash
# Connect to EC2 instance via SSM
ij prod
ij -r ap-northeast-2 prod
ij -t Environment=production prod

# Port forwarding (instance)
ij -L 80 prod
ij -L 8080:80 prod

# Port forwarding (remote host via bastion)
ij -L rds.example.com:3306 prod
ij -L 3306:rds.example.com:3306 -r ap-northeast-2 prod
```

## Prerequisites

- AWS CLI v2
- [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
- Configured AWS credentials

## Documentation

- [README](https://github.com/${REPOSITORY}/blob/main/box/tools/ij/README.md)

## Built With

- **Rust 1.92+ Edition 2024** - Memory safety, zero-cost abstractions
- **Tokio** - Async runtime for parallel region scanning
- **Clap** - CLI argument parsing
- **aws-sdk-ec2** - AWS EC2 API client
- **ratatui** - Terminal UI framework
- **nucleo** - Fuzzy matching
