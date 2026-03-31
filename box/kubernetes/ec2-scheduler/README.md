# ec2-scheduler

[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-ec2--scheduler-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/ec2-scheduler)
[![Helm Chart](https://img.shields.io/badge/ghcr.io-charts%2Fec2--scheduler-black?style=flat-square&logo=helm&logoColor=white)](https://github.com/younsl/o/pkgs/container/charts%2Fec2-scheduler)
[![Rust](https://img.shields.io/badge/rust-1.94-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

Kubernetes controller for scheduling EC2 instance start/stop via `EC2Schedule` CRD. Watches `EC2Schedule` custom resources and performs declarative start/stop actions based on cron schedules with IANA timezone support.

## Features

- Cron-based start/stop scheduling with IANA timezone support
- Instance selection by explicit IDs or tag filters (AND logic)
- Cross-account access via STS `AssumeRole`
- Dry-run mode for safe validation
- Pause/resume scheduling per resource
- Slack webhook notifications on actions and failures
- Prometheus metrics on port 8081
- Health/readiness endpoints on port 8080
- Kubernetes Events for audit trail

## EC2Schedule CR Example

```yaml
apiVersion: ec2-scheduler.io/v1alpha1
kind: EC2Schedule
metadata:
  name: dev-instances
  namespace: default
spec:
  region: ap-northeast-2
  timezone: Asia/Seoul
  instanceSelector:
    tags:
      Environment: development
      Team: platform
  schedules:
    - name: weekday
      start: "0 9 * * 1-5"
      stop: "0 18 * * 1-5"
  # paused: false
  # dryRun: false
  # assumeRoleArn: arn:aws:iam::123456789012:role/ec2-scheduler-role
```

## Status

```bash
kubectl get ec2schedules
```

```
NAME            REGION           TIMEZONE    PAUSED  PHASE   RUNNING  STOPPED  AGE
dev-instances   ap-northeast-2   Asia/Seoul  false   Active  3        0        2d
```

### Phases

| Phase | Description |
|-------|-------------|
| Pending | Initial state before first reconcile |
| Active | Schedules are being evaluated and executed |
| Paused | `spec.paused` is true, no actions executed |
| Failed | Validation error (delete and recreate to retry) |

## Prerequisites

See [docs/prerequisites.md](docs/prerequisites.md) for IAM permissions, RBAC, and authentication setup.

## Development

```bash
make build      # Debug build
make release    # Release build
make run        # Run operator
make dev        # Run with debug logging
make test       # Run tests
make fmt        # Format code
make lint       # Run clippy
```

## Installation

Official Helm chart is provided at [`charts/ec2-scheduler/`](charts/ec2-scheduler/).

```bash
# Install from local chart
helm install ec2-scheduler charts/ec2-scheduler/ \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789012:role/ec2-scheduler

# Pull and untar from OCI registry
helm pull oci://ghcr.io/younsl/charts/ec2-scheduler --version 0.1.0 --untar
```

## Architecture

```
src/
├── main.rs         # Entry point, health/metrics servers, controller bootstrap
├── controller.rs   # Reconcile loop and error policy
├── crd.rs          # EC2Schedule CRD module
├── crd/
│   ├── spec.rs     # EC2ScheduleSpec, InstanceSelector, ScheduleEntry
│   ├── status.rs   # EC2ScheduleStatus, ManagedInstance, Conditions
│   └── types.rs    # SchedulePhase, ScheduleAction enums
├── scheduler.rs    # Cron evaluation and next-occurrence calculation
├── aws.rs          # AWS EC2/STS client operations
├── status.rs       # Status patching and event recording
├── notify.rs       # Notification module
│   └── slack.rs    # Slack webhook notifier
├── error.rs        # Error types
└── telemetry/
    ├── health.rs   # Liveness/readiness endpoints (port 8080)
    └── metrics.rs  # Prometheus metrics (port 8081)
```

## License

This project is licensed under the MIT License. See the [LICENSE](../../../LICENSE) file for details.
