# kup

**K**8s **Up**grade - Interactive EKS cluster upgrade CLI tool. Analyzes cluster insights, plans sequential control plane upgrades, and updates add-ons and managed node groups. Inspired by [clowdhaus/eksup](https://github.com/clowdhaus/eksup).

## Features

- Interactive cluster and version selection
- Cluster Insights analysis (deprecated APIs, add-on compatibility)
- Sequential control plane upgrades (1 minor version at a time)
- **Sync mode**: Update only addons/nodegroups without control plane upgrade
- Automatic add-on version upgrades
- Managed node group rolling updates
- Dry-run mode for planning

## Usage

Run interactive upgrade workflow.

```bash
kup                              # Interactive mode
kup --dry-run                    # Plan only, no execution
kup -c my-cluster -t 1.34 --yes  # Non-interactive mode
```

## Installation

Requires AWS CLI v2 and valid credentials.

```bash
make install
mv ~/.cargo/bin/kup /usr/local/bin/
```

## Workflow

Step-by-step interactive upgrade process.

```
Step 1: Select Cluster        → Choose from available EKS clusters
Step 2: Check Insights        → Review upgrade readiness findings
Step 3: Select Target Version → Pick target version (or current for sync mode)
Step 4: Review Plan           → Verify upgrade phases and timeline
Step 5: Execute Upgrade       → Type 'Yes' to confirm and execute
```

## Upgrade Phases

EKS upgrades are executed in three phases.

| Phase | Description | Estimated Time |
|-------|-------------|----------------|
| 1. Control Plane | Sequential minor version upgrades | ~10 min/step |
| 2. Add-ons | Update to compatible versions | ~10 min |
| 3. Managed Node Groups | Rolling update to new AMI | ~20 min/group |

## Options

CLI flags for customization.

| Flag | Description |
|------|-------------|
| `--region`, `-r` | AWS region |
| `--profile`, `-p` | AWS profile name |
| `--cluster`, `-c` | Cluster name (non-interactive) |
| `--target`, `-t` | Target K8s version (non-interactive) |
| `--yes`, `-y` | Skip confirmation prompts |
| `--dry-run` | Show plan without executing |
| `--skip-addons` | Skip add-on upgrades |
| `--skip-nodegroups` | Skip node group upgrades |
| `--addon-version` | Specify add-on version (`ADDON=VERSION`) |
| `--log-level` | Log verbosity (default: `info`) |

## Examples

Common usage patterns.

```bash
# Interactive upgrade with specific region
kup -r ap-northeast-2

# Plan upgrade without execution
kup --dry-run

# Non-interactive upgrade for CI/CD
kup -c prod-cluster -t 1.34 --yes

# Sync mode: update addons/nodegroups only (select current version)
# Useful when control plane upgrade completed but addons/nodegroups pending
kup                  # Select "(current)" in Step 3

# Skip node group updates
kup --skip-nodegroups

# Specify add-on version
kup --addon-version kube-proxy=v1.34.0-eksbuild.1
```

## Requirements

IAM permissions needed for kup to work.

**User/Role:**
- `eks:ListClusters`
- `eks:DescribeCluster`
- `eks:UpdateClusterVersion`
- `eks:DescribeUpdate`
- `eks:ListInsights`
- `eks:DescribeInsight`
- `eks:ListAddons`
- `eks:DescribeAddon`
- `eks:DescribeAddonVersions`
- `eks:UpdateAddon`
- `eks:ListNodegroups`
- `eks:DescribeNodegroup`
- `eks:UpdateNodegroupVersion`

## Constraints

EKS upgrade limitations to be aware of.

- Control plane upgrades are limited to **1 minor version at a time**
- Example: 1.28 → 1.30 requires two steps (1.28 → 1.29 → 1.30)
- `kup` automates this sequential upgrade process
- **[Managed Node Groups](https://docs.aws.amazon.com/eks/latest/userguide/managed-node-groups.html) only**: Self-managed node groups and Karpenter nodes are not supported. Managed node groups are EC2 instances whose lifecycle (provisioning, updating, terminating) is managed by AWS EKS.

## Sync Mode

When an upgrade is interrupted (e.g., control plane completed but addons/nodegroups pending), use sync mode to resume:

1. Run `kup` in interactive mode
2. Select the cluster
3. Choose **current version** `(current)` in Step 3
4. Only addons and nodegroups will be upgraded to match the control plane

This is useful for:
- Recovering from interrupted upgrades
- Updating addons/nodegroups after manual control plane upgrade
- Synchronizing cluster components to current control plane version

## License

MIT
