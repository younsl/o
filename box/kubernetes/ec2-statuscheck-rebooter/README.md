# ec2-statuscheck-rebooter

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-ec2--statuscheck--rebooter-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/ec2-statuscheck-rebooter)
[![Rust](https://img.shields.io/badge/rust-1.91-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

Automated reboot for standalone EC2 instances with status check failures.

## Overview

ec2-statuscheck-rebooter is a Kubernetes-based operational tool that monitors **standalone EC2 instances outside the cluster** and automatically reboots them when [status checks](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-system-instance-status-check.html) fail repeatedly. This tool is designed to manage external EC2 infrastructure (e.g., legacy applications, databases, bastion hosts) that are **not part of the Kubernetes cluster**.

Built with Rust 1.91 for minimal resource usage and maximum reliability.

![Architecture Diagram](docs/assets/1.png)

For detailed component structure and design decisions, see [Architecture Documentation](docs/architecture.md).

### What are EC2 Status Checks?

AWS performs automated checks on every running EC2 instance to identify hardware and software issues:

- **[System Status Checks](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-system-instance-status-check.html#types-of-instance-status-checks)**: Monitor AWS infrastructure (host hardware, network, power)
- **[Instance Status Checks](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-system-instance-status-check.html#types-of-instance-status-checks)**: Monitor guest OS and application (kernel issues, exhausted memory, incorrect network configuration)

When these checks fail and return **impaired** status, this tool automatically reboots the instance after reaching the configured failure threshold.

## Features

- **Automatic Monitoring**: Periodically checks EC2 instance status
- **Smart Rebooting**: Reboots instances only after reaching failure threshold
- **Tag Filtering**: Monitor specific instances using AWS tags (comma-separated)
- **Dry Run Mode**: Test without performing actual reboots
- **AWS Authentication**: Supports both IRSA and EKS Pod Identity for native AWS authentication
- **Structured Logging**: JSON and pretty log formats for CloudWatch/Loki integration
- **Health Check Endpoints**: HTTP endpoints for Kubernetes liveness and readiness probes
- **Lightweight**: Built with Rust for minimal memory footprint and fast startup

## Use Cases

This tool is specifically designed for monitoring **external EC2 instances** that are not part of your Kubernetes cluster:

- **Legacy Applications**: Non-containerized applications running on EC2
- **Database Servers**: RDS-incompatible databases on EC2
- **Bastion Hosts**: Jump servers for secure access
- **Windows Servers**: Windows-based applications
- **Third-party Software**: Licensed software requiring EC2 deployment
- **Hybrid Infrastructure**: Bridge between traditional and cloud-native workloads

**Important**: This tool does NOT manage Kubernetes worker nodes. For EKS node health, use AWS Node Termination Handler or Karpenter. If you need Kubernetes node automatic reboots (e.g., after kernel updates), consider using [kured (Kubernetes Reboot Daemon)](https://github.com/kubereboot/kured) which safely drains and reboots nodes when `/var/run/reboot-required` is present.

## Installation

For detailed installation instructions, see [Installation Guide](docs/installation.md).

## Documentation

- [Installation Guide](docs/installation.md) - Detailed installation instructions and configuration examples
- [Architecture](docs/architecture.md) - Component structure, data flow, and design decisions
- [Troubleshooting](docs/troubleshooting.md) - Common issues and debugging tips

## Development

### Build Commands

```bash
# Build debug binary
make build

# Build release binary
make release

# Run with dry-run mode
make run

# Run with debug logging
make dev

# Run tests
make test

# Format and lint
make fmt
make lint

# Build Docker image
make docker-build

# Push to registry
make docker-push
```

### Local Testing

```bash
# Set AWS credentials
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...

# Run with pretty logs
LOG_FORMAT=pretty cargo run -- \
  --check-interval-seconds 60 \
  --failure-threshold 2 \
  --dry-run
```

## License

See repository root for license information.

## Contributing

Contributions are welcome! Please see the repository root for contribution guidelines.
