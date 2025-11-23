# Architecture

## Overview

EC2 Status Check Rebooter monitors standalone EC2 instances and automatically reboots them when status check failures persist beyond a configured threshold. It excludes EKS worker nodes from monitoring to prevent cluster disruption.

## Project Structure

```
ec2-statuscheck-rebooter/
├── src/
│   ├── main.rs          # Application entry point
│   ├── lib.rs           # Module declarations
│   ├── config.rs        # Configuration management
│   ├── rebooter.rs      # Core monitoring loop
│   ├── ec2.rs           # AWS EC2 API client
│   ├── health.rs        # Health check server
│   └── logging.rs       # Logging setup
├── charts/              # Helm chart
├── Dockerfile
├── Cargo.toml
└── Makefile
```

## Component Roles

### main.rs - Application Entry Point

Orchestrates the application lifecycle from startup to shutdown. Parses configuration from CLI arguments and environment variables, initializes structured logging, and spawns the health check server on port 8080. Creates the main rebooter instance and runs the monitoring loop. Handles graceful shutdown on SIGINT/SIGTERM signals and manages error handling with appropriate exit codes.

### config.rs - Configuration Management

Defines all application settings including polling interval, failure threshold, AWS region, tag filters, dry-run mode, and logging preferences. Uses Clap for CLI argument parsing with environment variable override support. Provides configuration validation and display logging to help users verify their settings at startup.

### rebooter.rs - Core Monitoring Engine

Implements the main monitoring loop that polls EC2 instance status at regular intervals. Maintains an in-memory failure tracker as a HashMap that counts consecutive failures for each instance. When an instance's failure count reaches the configured threshold, triggers a reboot and resets the counter. Coordinates between the EC2 client for API calls and the health server for readiness status.

### ec2.rs - AWS API Integration

Handles all interactions with AWS EC2 APIs. Initializes the AWS SDK with region configuration and tests connectivity on startup. Queries instance status using DescribeInstanceStatus and fetches instance tags with DescribeInstances. Implements EKS worker node exclusion by detecting Kubernetes-related tags (kubernetes.io/cluster/*, eks:cluster-name, eks:nodegroup-name). Logs excluded EKS nodes with cluster information and executes instance reboots via the RebootInstances API.

### health.rs - Kubernetes Health Probes

Provides HTTP endpoints for Kubernetes liveness and readiness probes on port 8080. The liveness endpoint (/healthz) always returns 200 OK if the process is running. The readiness endpoint (/readyz) returns 200 only after successful AWS connectivity test, allowing Kubernetes to know when the application is fully initialized and ready to start monitoring.

### logging.rs - Structured Logging Setup

Initializes tracing-subscriber with configurable format and level. Supports JSON format for structured logging in production (CloudWatch/Loki) and pretty format for human-readable output during local development. Respects environment variable overrides for flexible log level configuration per deployment.

## Data Flow

### Startup
Parse config → Initialize logging → Start health server → Create EC2 client → Test AWS connectivity → Mark ready → Enter monitoring loop.

### Monitoring Cycle
Query EC2 status → Fetch tags → Filter EKS nodes → Track failures → Reboot if threshold reached → Sleep → Repeat.

### Shutdown
Receive signal → Log shutdown message → Exit loop → Terminate cleanly.

## AWS Authentication

Supports both IRSA (IAM Roles for Service Accounts) and EKS Pod Identity for credential management.

### Required IAM Permissions

| Permission | Purpose | Used In |
|------------|---------|---------|
| `ec2:DescribeRegions` | Verify AWS API connectivity on startup | `ec2.rs::test_connectivity()` |
| `ec2:DescribeInstanceStatus` | Query instance status check results | `ec2.rs::get_instance_statuses()` |
| `ec2:DescribeInstances` | Fetch instance tags for filtering EKS nodes | `ec2.rs::get_instance_tags()` |
| `ec2:RebootInstances` | Execute instance reboot when threshold reached | `ec2.rs::reboot_instance()` |

### Setup Examples

**Option 1: IRSA (IAM Roles for Service Accounts)**
```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT:role/ROLE_NAME
```

**Option 2: EKS Pod Identity (EKS 1.24+)**
```bash
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --service-account ec2-statuscheck-rebooter \
  --role-arn arn:aws:iam::ACCOUNT:role/ROLE_NAME
```

Both authentication methods are supported and work transparently with the AWS SDK.

## Design Decisions

Deployed as a single-replica Deployment (not DaemonSet) since it monitors EC2 instances across an entire region. Excludes EKS worker nodes to prevent cluster disruption—use dedicated tools like AWS Node Termination Handler, Karpenter, or kured for node management. Uses in-memory failure tracking for simplicity, with state reset on pod restart being intentional. Configurable failure threshold prevents false positives from transient issues.
