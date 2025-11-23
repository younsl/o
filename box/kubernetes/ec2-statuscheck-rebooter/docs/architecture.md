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
│   ├── ec2.rs           # EC2 module entry point
│   ├── ec2/
│   │   ├── client.rs    # AWS SDK initialization & basic API calls
│   │   ├── status.rs    # Status check logic & impaired detection (26 tests)
│   │   └── tags.rs      # Tag processing & EKS node filtering (21 tests)
│   ├── health.rs        # Health check server
│   └── logging.rs       # Logging setup with RFC3339 timestamps
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

### ec2 Module - AWS API Integration (Single Responsibility Principle Applied)

The ec2 module is split into three focused components following the Single Responsibility Principle:

#### ec2.rs - Module Entry Point
Exports the public API (`Ec2Client` and `InstanceStatus` struct) and organizes submodules.

#### ec2/client.rs - AWS SDK Initialization (115 lines)
Handles AWS SDK configuration and basic API operations. Manages region resolution with priority: explicit config → AWS SDK defaults (env/~/.aws/config/IMDS). Provides connectivity testing via DescribeRegions API and executes instance reboots via RebootInstances API.

#### ec2/status.rs - Status Check Logic (345 lines, 26 tests)
Implements instance status monitoring and impaired detection. Queries DescribeInstanceStatus API with tag filters and processes status check results. Contains the critical `has_impaired_status()` function that determines reboot decisions. Comprehensive test coverage includes all status combinations: ok, impaired, insufficient-data, initializing, not-applicable, unknown, and edge cases.

#### ec2/tags.rs - Tag Processing & EKS Filtering (455 lines, 21 tests)
Handles instance tag retrieval and EKS worker node identification. Fetches tags via DescribeInstances API and filters out EKS nodes by detecting Kubernetes-related tags (`kubernetes.io/cluster/*`, `eks:cluster-name`, `eks:nodegroup-name`). Implements pattern matching for prefix and exact tag detection. Logs excluded EKS nodes with cluster information to prevent accidental cluster disruption.

### health.rs - Kubernetes Health Probes

Provides HTTP endpoints for Kubernetes liveness and readiness probes on port 8080. The liveness endpoint (/healthz) always returns 200 OK if the process is running. The readiness endpoint (/readyz) returns 200 only after successful AWS connectivity test, allowing Kubernetes to know when the application is fully initialized and ready to start monitoring.

### logging.rs - Structured Logging Setup

Initializes tracing-subscriber with configurable format and level. Supports two formats:
- **JSON** (default, production): Single-line JSON with RFC3339 timestamps and `flatten_event(true)` for log aggregators like CloudWatch/Loki
- **Pretty** (development): Multi-line human-readable output with `.compact()` formatting for local debugging

Includes log format validation with automatic fallback to JSON for invalid inputs. Logs initialization details (format and level) for startup verification.

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
| `ec2:DescribeRegions` | Verify AWS API connectivity on startup | `ec2/client.rs::test_connectivity()` |
| `ec2:DescribeInstanceStatus` | Query instance status check results | `ec2/status.rs::get_instance_statuses()` |
| `ec2:DescribeInstances` | Fetch instance tags for filtering EKS nodes | `ec2/tags.rs::get_instance_tags()` |
| `ec2:RebootInstances` | Execute instance reboot when threshold reached | `ec2/client.rs::reboot_instance()` |

### Setup Examples

**Option 1: IRSA (IAM Roles for Service Accounts)**

Traditional authentication method using OIDC provider. The service account annotation links the Kubernetes ServiceAccount to an IAM role, enabling the pod to assume AWS credentials automatically.

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::ACCOUNT:role/ROLE_NAME
```

**Option 2: EKS Pod Identity (EKS 1.24+)**

Simplified authentication method that eliminates the need for OIDC provider configuration. Creates a direct association between the EKS cluster, namespace, service account, and IAM role. Recommended for new EKS clusters.

```bash
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --namespace monitoring \
  --service-account ec2-statuscheck-rebooter \
  --role-arn arn:aws:iam::ACCOUNT:role/ROLE_NAME
```

**Note**: The `create-pod-identity-association` command requires AWS CLI version 2.13.23 or later. Use `aws eks help` to verify EKS Pod Identity commands are available.

**Reference**:
- [EKS Pod Identity AWS CLI Reference](https://docs.aws.amazon.com/cli/latest/reference/eks/create-pod-identity-association.html)
- [EKS Pod Identity Official Guide](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)

Both authentication methods are supported and work transparently with the AWS SDK. The application automatically detects and uses the available credentials without code changes.

## Design Decisions

Deployed as a single-replica Deployment (not DaemonSet) since it monitors EC2 instances across an entire region. Excludes EKS worker nodes to prevent cluster disruption—use dedicated tools like AWS Node Termination Handler, Karpenter, or kured for node management. Uses in-memory failure tracking for simplicity, with state reset on pod restart being intentional. Configurable failure threshold prevents false positives from transient issues.
