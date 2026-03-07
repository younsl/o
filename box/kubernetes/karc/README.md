# karc

[![GitHub release](https://img.shields.io/github/v/release/younsl/o?filter=karc*&style=flat-square&color=black)](https://github.com/younsl/o/releases?q=karc&expanded=true)
[![Rust](https://img.shields.io/badge/rust-1.93-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

<img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/kubernetes/kubernetes-plain.svg" width="40" height="40"/>

**K**ubernetes [k**ARC**](https://github.com/kubernetes-sigs/karpenter) - Karpenter NodePool consolidation manager CLI tool. View disruption status with schedule timetables, pause and resume consolidation across NodePools.

## Features

- Kubectl-style status table with NodePool disruption details
- Schedule-based disruption budget timetable with timezone-aware window display
- Pause consolidation by prepending `{nodes: "0"}` budget
- Resume consolidation by removing pause budgets (preserves scheduled budgets)
- Target a specific NodePool or all NodePools at once
- Dry-run mode for previewing changes
- Interactive confirmation prompts (skippable with `--yes`)
- Automatic Karpenter API version detection (v1, v1beta1 fallback)

## Usage

```bash
karc status                  # Show all NodePool status
karc status my-nodepool      # Show specific NodePool
karc pause my-nodepool       # Pause consolidation
karc pause all               # Pause all NodePools
karc resume my-nodepool      # Resume consolidation
karc resume all              # Resume all NodePools
karc pause all --dry-run     # Preview without applying
karc resume all --yes        # Skip confirmation prompt
```

### Global Options

| Flag | Default | Description |
|------|---------|-------------|
| `--context` | current context | Kubernetes context (env: `KUBECONFIG_CONTEXT`) |
| `--dry-run` | `false` | Show planned changes without executing |
| `-y, --yes` | `false` | Skip confirmation prompts |
| `--log-level` | `warn` | Logging level: trace, debug, info, warn, error (env: `KARC_LOG_LEVEL`) |
| `--timezone` | auto-detect | Timezone for schedule display (e.g., `Asia/Seoul`, `US/Eastern`) |

### Status Output

The `status` subcommand displays two tables:

**NodePool Status Table**:

```
NODEPOOL          WEIGHT  POLICY           AFTER  BUDGETS  NODECLAIMS  STATE
general-purpose   10      ConsolidateWNMP  30s    2        12          Active
gpu-workloads     50      ConsolidateWNMP  60s    1        4           Paused
```

**Disruption Schedule Timetable** (for NodePools with schedule-based budgets):

Shows cron-based disruption windows converted to the specified timezone, with active window detection and allowed disruption reasons (Empty, Drifted, Underutilized, Expired).

### Pause/Resume Mechanism

**Pause**: Prepends `{nodes: "0"}` unscheduled budget to the NodePool's disruption budgets array. This creates a zero-node override that prevents Karpenter from consolidating.

**Resume**: Removes only unscheduled zero-node budgets. Scheduled pause budgets (with cron schedule and duration) are preserved. If no budgets remain after removal, defaults to `{nodes: "10%"}`.

## Prerequisites

Requires a valid kubeconfig with access to the target Kubernetes cluster. The cluster must have [Karpenter](https://karpenter.sh/) installed.

<details>
<summary>Required RBAC Permissions</summary>

```yaml
apiGroups: ["karpenter.sh"]
resources: ["nodepools", "nodeclaims"]
verbs: ["get", "list", "patch"]
```

</details>

## Installation

```bash
# Build from source
make install

# Or install to /usr/local/bin
make install-local
```

## Development

```bash
make build      # Build debug binary
make release    # Build optimized release binary
make run        # Build and run status subcommand
make dev        # Run with debug logging
make test       # Run tests
make fmt        # Format code
make lint       # Run clippy linter
```

## Constraints

- Requires Karpenter v1 or v1beta1 NodePool CRD installed in the cluster
- Timezone must be a valid [IANA timezone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) identifier

## License

This project is licensed under the MIT License. See the [LICENSE](../../../LICENSE) file for details.
