# kuo

[![GitHub release](https://img.shields.io/github/v/release/younsl/o?filter=kuo*&style=flat-square&color=black)](https://github.com/younsl/o/releases?q=kuo&expanded=true)
[![Rust](https://img.shields.io/badge/rust-1.93-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-kuo-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/kuo)
[![Helm Chart](https://img.shields.io/badge/ghcr.io-charts%2Fkuo-black?style=flat-square&logo=helm&logoColor=white)](https://github.com/younsl/o/pkgs/container/charts%2Fkuo)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

Kubernetes Upgrade Operator for EKS clusters. Watches `EKSUpgrade` custom resources and performs declarative, sequential EKS cluster upgrades including control plane, add-ons, and managed node groups.

## Features

- **Sequential control plane upgrades** — Automatically steps through 1 minor version at a time (e.g., 1.30 → 1.31 → 1.32)
- **Add-on version management** — Resolves and applies compatible add-on versions per upgrade step
- **Managed node group rolling updates** — Triggers rolling updates after control plane and add-on upgrades
- **Preflight validation** — EKS Cluster Insights, Deletion Protection, PDB drain deadlock checks before upgrade
- **Cross-account support** — Hub & Spoke model via STS AssumeRole
- **Crash recovery** — Persists AWS update IDs in CRD status for resuming interrupted operations
- **Dry-run mode** — Generate upgrade plan without executing
- **Sync mode** — Update only add-ons and node groups without control plane upgrade (when target version equals current)

## Architecture

```
                    Hub Account (A)                         Spoke Account (B)
              ┌──────────────────────┐              ┌──────────────────────┐
              │  EKS Cluster (Hub)   │              │  EKS Cluster (Target)│
              │                      │              │                      │
              │  ┌────────────────┐  │  AssumeRole  │                      │
              │  │ kuo operator   │──┼──────────────┼──→ EKS API           │
              │  │ (Deployment)   │  │              │  → K8s API (PDB)     │
              │  └───────┬────────┘  │              │                      │
              │          │           │              └──────────────────────┘
              │  ┌───────▼────────┐  │
              │  │ EKSUpgrade CRD │  │
              │  └────────────────┘  │
              └──────────────────────┘
```

## Upgrade Phase Flow

```
Pending → Planning → PreflightChecking → UpgradingControlPlane → UpgradingAddons → UpgradingNodeGroups → Completed
                            │                                                                               │
                            └───── (mandatory check failure) ──→ Failed ←── (any phase error) ──────────────┘
```

### Dry-Run Mode

When `dryRun: true` is set, the operator executes planning and preflight validation but skips all infrastructure changes:

```
Pending → Planning → PreflightChecking ──→ Completed (DryRunCompleted)
                            │
                            └── (mandatory check failure) ──→ Failed
```

The dry-run gate is evaluated **after** all preflight checks pass. If any mandatory check fails, the upgrade fails regardless of the dry-run flag. On success, the full upgrade plan (upgrade path, addon targets, nodegroup targets) is available in `status.phases` for review.

**Preflight checks:**

| Check | Category | Behavior |
|-------|----------|----------|
| EKS Cluster Insights | Mandatory | Fails if critical insights exist |
| EKS Deletion Protection | Mandatory | Fails if deletion protection is disabled |
| PDB Drain Deadlock | Mandatory | Fails if any PDB has `disruptionsAllowed == 0` (skippable via `skipPdbCheck`) |

## Installation

### Helm

```bash
helm install kuo oci://ghcr.io/younsl/charts/kuo \
  --namespace kube-system
```

### EKSUpgrade CR Example

```yaml
apiVersion: kuo.io/v1alpha1
kind: EKSUpgrade
metadata:
  name: staging-upgrade
spec:
  clusterName: staging-cluster
  targetVersion: "1.34"
  region: ap-northeast-2
```

Cross-account upgrade:

```yaml
apiVersion: kuo.io/v1alpha1
kind: EKSUpgrade
metadata:
  name: production-upgrade
spec:
  clusterName: production-cluster
  targetVersion: "1.34"
  region: ap-northeast-2
  assumeRoleArn: arn:aws:iam::123456789012:role/kuo-spoke-role
```

### Spec Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `clusterName` | Yes | — | EKS cluster name |
| `targetVersion` | Yes | — | Target Kubernetes version (e.g., `"1.34"`) |
| `region` | Yes | — | AWS region |
| `assumeRoleArn` | No | — | IAM Role ARN for cross-account access |
| `addonVersions` | No | auto-resolve | Add-on version overrides (`addon-name: version`) |
| `skipPdbCheck` | No | `false` | Skip PDB drain deadlock check |
| `dryRun` | No | `false` | Plan only, do not execute |
| `timeouts.controlPlaneMinutes` | No | `30` | Control plane upgrade timeout |
| `timeouts.nodegroupMinutes` | No | `60` | Node group upgrade timeout |

## Hub & Spoke IAM Permissions

### Hub Account (Central — where kuo runs)

The operator pod needs base credentials via **IRSA** or **EKS Pod Identity**.

**IAM Policy for Hub Role** (`kuo-hub-role`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAssumeRoleToSpokeAccounts",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::*:role/kuo-spoke-role"
    }
  ]
}
```

For same-account clusters (no `assumeRoleArn`), the hub role also needs the EKS permissions listed below.

**Helm values for IRSA:**

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::111111111111:role/kuo-hub-role
```

**Helm values for EKS Pod Identity:**

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/audience: sts.amazonaws.com
```

> EKS Pod Identity requires a Pod Identity Association created via `aws eks create-pod-identity-association`.

### Spoke Account (Target — EKS clusters to upgrade)

**IAM Policy for Spoke Role** (`kuo-spoke-role`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EKSClusterOperations",
      "Effect": "Allow",
      "Action": [
        "eks:ListClusters",
        "eks:DescribeCluster",
        "eks:UpdateClusterVersion",
        "eks:DescribeUpdate"
      ],
      "Resource": "arn:aws:eks:*:222222222222:cluster/*"
    },
    {
      "Sid": "EKSInsights",
      "Effect": "Allow",
      "Action": [
        "eks:ListInsights",
        "eks:DescribeInsight"
      ],
      "Resource": "arn:aws:eks:*:222222222222:cluster/*"
    },
    {
      "Sid": "EKSAddonOperations",
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
      "Sid": "EKSNodegroupOperations",
      "Effect": "Allow",
      "Action": [
        "eks:ListNodegroups",
        "eks:DescribeNodegroup",
        "eks:UpdateNodegroupVersion"
      ],
      "Resource": "arn:aws:eks:*:222222222222:nodegroup/*/*/*"
    },
    {
      "Sid": "STSIdentity",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    }
  ]
}
```

**Trust Policy for Spoke Role:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::111111111111:role/kuo-hub-role"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

**EKS Access Entry** (for K8s API access in spoke cluster):

The spoke role needs an EKS access entry to query PodDisruptionBudgets via the Kubernetes API during preflight checks.

```bash
aws eks create-access-entry \
  --cluster-name production-cluster \
  --principal-arn arn:aws:iam::222222222222:role/kuo-spoke-role \
  --type STANDARD

aws eks associate-access-policy \
  --cluster-name production-cluster \
  --principal-arn arn:aws:iam::222222222222:role/kuo-spoke-role \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy \
  --access-scope type=cluster
```

> Spoke account does **NOT** need EKS Pod Identity registration. The operator authenticates via STS AssumeRole from the hub account.

### Permission Summary

```
Hub Account (111111111111)           Spoke Account (222222222222)
┌──────────────────────────┐        ┌──────────────────────────┐
│ kuo-hub-role             │        │ kuo-spoke-role           │
│                          │        │                          │
│ Permissions:             │        │ Permissions:             │
│  · sts:AssumeRole ───────┼───────→│  · eks:* (cluster ops)   │
│                          │        │  · sts:GetCallerIdentity │
│ Credential source:       │        │                          │
│  · IRSA or               │        │ Trust policy:            │
│  · EKS Pod Identity      │        │  · Hub role (AssumeRole) │
│                          │        │                          │
│ EKS Pod Identity: YES    │        │ EKS Pod Identity: NO     │
└──────────────────────────┘        │                          │
                                    │ EKS Access Entry: YES    │
                                    │  · AmazonEKSViewPolicy   │
                                    └──────────────────────────┘
```

## Monitoring

| Endpoint | Description |
|----------|-------------|
| `GET /healthz` | Liveness probe (always 200) |
| `GET /readyz` | Readiness probe (200 when controller is watching) |

```bash
kubectl get eksupgrades
NAME                CLUSTER              TARGET   PHASE       AUTH                AGE
staging-upgrade     staging-cluster      1.34     Completed   IdentityVerified    5m
production-upgrade  production-cluster   1.34     UpgradingAddons  AssumeRoleSuccess  2m
```

## Development

```bash
make build          # Debug build
make release        # Optimized release build
make test           # Run tests
make fmt            # Format code
make lint           # Run clippy
make install        # Install to ~/.cargo/bin/
```

## Release

```bash
# Container image (triggers GitHub Actions → zigbuild → multi-arch push to GHCR)
git tag kuo/0.1.0 && git push --tags

# Helm chart (triggers unified Helm chart release workflow)
git tag kuo/charts/0.1.0 && git push --tags
```

## Constraints

- Control plane upgrades limited to 1 minor version at a time (EKS limitation)
- Managed Node Groups only (self-managed and Karpenter nodes are not supported)
- Cluster-scoped CRD (one EKSUpgrade per cluster, not namespaced)

## License

MIT
