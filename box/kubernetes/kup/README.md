# kup

[![GitHub release](https://img.shields.io/github/v/release/younsl/o?filter=kup*&style=flat-square&color=black)](https://github.com/younsl/o/releases?q=kup&expanded=true)
[![Rust](https://img.shields.io/badge/rust-1.92-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

<img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/kubernetes/kubernetes-plain.svg" width="40" height="40"/>

[**K**ubernetes](https://github.com/kubernetes/kubernetes) **Up**grade - Interactive EKS cluster upgrade CLI tool. Analyzes cluster insights, plans sequential control plane upgrades, and updates add-ons and managed node groups. Inspired by [clowdhaus/eksup](https://github.com/clowdhaus/eksup).

## Features

- Interactive cluster and version selection
- Cluster Insights analysis (deprecated APIs, add-on compatibility)
- Sequential control plane upgrades (1 minor version at a time)
- **Sync mode**: Update only addons/nodegroups without control plane upgrade
- Automatic add-on version upgrades
- Managed node group rolling updates
- PDB drain deadlock detection before node group rolling updates
- Dry-run mode for planning

## Usage

Run interactive upgrade workflow.

```bash
kup                              # Interactive mode
kup --dry-run                    # Plan only, no execution
kup -c my-cluster -t 1.34 --yes  # Non-interactive mode
kup --skip-pdb-check             # Skip PDB drain deadlock check
```

## Installation

Requires AWS CLI v2 and valid credentials.

```bash
brew install younsl/tap/kup
kup --version
```

Or build from source:

```bash
make install
mv ~/.cargo/bin/kup /usr/local/bin/
```

## How It Works

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ Control Plane│     │   Add-ons    │     │ Node Groups  │
│              │     │              │     │              │
│  1.32 → 1.33 │────▶│ Update to    │────▶│ Rolling AMI  │
│  ~10 min/step│     │ compatible   │     │ update       │
└──────────────┘     └──────────────┘     └──────────────┘
```

**Interactive workflow steps:**

1. Select cluster from available EKS clusters
2. Review upgrade readiness findings (Cluster Insights)
3. Pick target version (or current for sync mode)
4. Verify upgrade plan and estimated timeline
5. Type 'Yes' to confirm and execute

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
| `--skip-pdb-check` | Skip PDB drain deadlock check |
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

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EKSClusterReadWrite",
      "Effect": "Allow",
      "Action": [
        "eks:ListClusters",
        "eks:DescribeCluster",
        "eks:UpdateClusterVersion",
        "eks:DescribeUpdate"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EKSInsightsRead",
      "Effect": "Allow",
      "Action": [
        "eks:ListInsights",
        "eks:DescribeInsight"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EKSAddonsReadWrite",
      "Effect": "Allow",
      "Action": [
        "eks:ListAddons",
        "eks:DescribeAddon",
        "eks:DescribeAddonVersions",
        "eks:UpdateAddon"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EKSNodegroupsReadWrite",
      "Effect": "Allow",
      "Action": [
        "eks:ListNodegroups",
        "eks:DescribeNodegroup",
        "eks:UpdateNodegroupVersion"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AutoScalingRead",
      "Effect": "Allow",
      "Action": [
        "autoscaling:DescribeAutoScalingGroups"
      ],
      "Resource": "*"
    }
  ]
}
```

## PDB Drain Deadlock Detection

Before managed node group rolling updates, kup checks all PodDisruptionBudgets in the cluster for drain deadlock conditions. A PDB with `status.disruptionsAllowed == 0` and active pods will permanently block node drain during rolling updates (e.g., replicas=1 with minAvailable=1).

- Connects to the EKS API server using endpoint/CA from `describe_cluster` and a bearer token from `aws eks get-token`
- Results are displayed within the Phase 3 (Managed Node Group Upgrade) section of the upgrade plan
- Failures are non-fatal warnings and do not block the upgrade
- Use `--skip-pdb-check` to skip this check

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
