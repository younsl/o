# Installation Guide

This guide covers the IAM prerequisites and Helm installation for kubernetes-upgrade-operator (kuo). kuo runs in a central (hub) EKS cluster and upgrades EKS clusters in the same account or in spoke accounts via STS AssumeRole.

## Prerequisites: Hub & Spoke IAM Permissions

### Hub Account (Central — where kubernetes-upgrade-operator runs)

The operator pod needs base credentials via **IRSA** or **EKS Pod Identity**.

<details>
<summary>Hub Policy — for same-account clusters</summary>

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
        "eks:DescribeUpdate",
        "eks:ListNodegroups"
      ],
      "Resource": "arn:aws:eks:*:111111111111:cluster/*"
    },
    {
      "Sid": "EKSInsights",
      "Effect": "Allow",
      "Action": [
        "eks:ListInsights",
        "eks:DescribeInsight"
      ],
      "Resource": "arn:aws:eks:*:111111111111:cluster/*"
    },
    {
      "Sid": "EKSAddonOperations",
      "Effect": "Allow",
      "Action": [
        "eks:ListAddons",
        "eks:DescribeAddon",
        "eks:DescribeAddonVersions",
        "eks:DescribeClusterVersions",
        "eks:UpdateAddon"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EKSNodegroupOperations",
      "Effect": "Allow",
      "Action": [
        "eks:DescribeNodegroup",
        "eks:UpdateNodegroupVersion"
      ],
      "Resource": "arn:aws:eks:*:111111111111:nodegroup/*/*/*"
    },
    {
      "Sid": "STSIdentity",
      "Effect": "Allow",
      "Action": [
        "sts:GetCallerIdentity",
        "sts:TagSession"
      ],
      "Resource": "*"
    }
  ]
}
```

</details>

<details>
<summary>Spoke Policy — for cross-account clusters</summary>

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAssumeRoleToSpokeAccounts",
      "Effect": "Allow",
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ],
      "Resource": "arn:aws:iam::*:role/kuo-spoke-role"
    }
  ]
}
```

</details>

> Both policies can be attached to the same hub role when managing both same-account and cross-account clusters.
>
> ⚠️ **Important:** `sts:TagSession` is required in both Hub Policy and Spoke Policy. EKS Pod Identity and IRSA attach session tags when issuing credentials. Without this permission, the hub role cannot obtain credentials and all API calls will fail with `AccessDenied`.

### Spoke Account (Target — EKS clusters to upgrade)

<details>
<summary>IAM Policy for Spoke Role</summary>

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
        "eks:DescribeUpdate",
        "eks:ListNodegroups"
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
        "eks:DescribeClusterVersions",
        "eks:UpdateAddon"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EKSNodegroupOperations",
      "Effect": "Allow",
      "Action": [
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

</details>

<details>
<summary>Trust Policy for Spoke Role</summary>

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::111111111111:role/kuo-hub-role"
      },
      "Action": [
        "sts:AssumeRole",
        "sts:TagSession"
      ]
    }
  ]
}
```

</details>

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

> Spoke cluster does **NOT** need EKS Pod Identity registration. The kubernetes-upgrade-operator pod only runs in the hub cluster and authenticates to spoke accounts via STS AssumeRole.

### Permission Summary

```
Hub Account (111111111111)           Spoke Account (222222222222)
┌──────────────────────────┐        ┌──────────────────────────┐
│ kuo-hub-role             │        │ kuo-spoke-role           │
│                          │        │                          │
│ Hub Policy:              │        │ Permissions:             │
│  · eks:* (same-account)  │        │  · eks:* (cluster ops)   │
│  · sts:GetCallerIdentity │        │  · sts:GetCallerIdentity │
│                          │        │                          │
│ Spoke Policy:            │        │ Trust policy:            │
│  · sts:AssumeRole ───────┼───────→│  · Hub role (AssumeRole) │
│                          │        │                          │
│ Credential source:       │        │ EKS Pod Identity: NO     │
│  · IRSA or               │        │                          │
│  · EKS Pod Identity      │        │ EKS Access Entry: YES    │
│                          │        │  · AmazonEKSViewPolicy   │
│ EKS Pod Identity: YES    │        │                          │
└──────────────────────────┘        └──────────────────────────┘
```

## Install with Helm

Helm is the recommended installation method. The chart is distributed via OCI registry:

```bash
helm install kuo oci://ghcr.io/younsl/charts/kuo \
  --namespace kube-system
```

See [charts/kuo](../charts/kuo) for detailed configuration and values reference.

### Credential Configuration

**Helm values for IRSA:**

```yaml
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::111111111111:role/kuo-hub-role
```

**[EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-how-it-works.html):**

EKS Pod Identity does not require any ServiceAccount annotations. Create a Pod Identity Association instead:

```bash
aws eks create-pod-identity-association \
  --cluster-name hub-cluster \
  --namespace kube-system \
  --service-account kuo \
  --role-arn arn:aws:iam::111111111111:role/kuo-hub-role
```
