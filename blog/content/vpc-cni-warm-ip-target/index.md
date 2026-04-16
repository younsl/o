---
title: "vpc cni warm ip target"
date: 2026-03-07T08:16:00+09:00
lastmod: 2026-03-07T08:16:00+09:00
description: "Optimize EKS node IP allocation using VPC CNI WARM_IP_TARGET and MINIMUM_IP_TARGET"
keywords: []
tags: ["devops", "kubernetes", "aws"]
---

## Overview

Guide to prevent subnet IP exhaustion on EKS by tuning WARM_IP_TARGET and MINIMUM_IP_TARGET in VPC CNI.

By default, VPC CNI keeps a spare ENI (WARM_ENI_TARGET=1) per node. A single ENI can hold dozens of IPs, so unused IPs pile up and exhaust the subnet. Setting WARM_IP_TARGET and MINIMUM_IP_TARGET switches to IP-level control, which is more efficient.

| Variable | Description | Default | Note |
|---------|------|--------|------|
| WARM_IP_TARGET | Unused IPs to keep ready per node | Not set | |
| MINIMUM_IP_TARGET | Minimum total IPs per node | Not set | |
| WARM_ENI_TARGET | Unused ENIs to keep ready per node | 1 | ⚠️ Ignored when WARM_IP_TARGET or MINIMUM_IP_TARGET is set |

## How it works

When WARM_IP_TARGET and MINIMUM_IP_TARGET are both set, **whichever requires more IPs wins**:

Total IPs on node = max( assigned IPs + WARM_IP_TARGET, MINIMUM_IP_TARGET )

Example with WARM_IP_TARGET=1, MINIMUM_IP_TARGET=8:

```text
■ = assigned IP, □ = warm IP

3 pods:             15 pods:
┌─ node ───┐        ┌─ node ───────────┐
│ ■■■□□□□□ │        │ ■■■■■■■■■■■■■■■□ │
└──────────┘        └──────────────────┘
  Minimum IP 8        Assigned IP 15 + Warm IP 1
```

| Assigned IPs | WARM rule (assigned + 1) | MINIMUM rule | Actual IPs held |
|:---:|:---:|:---:|:---:|
| 0 | 1 | 8 | **8** |
| 3 | 4 | 8 | **8** |
| 7 | 8 | 8 | **8** |
| 8 | 9 | 8 | **9** |
| 15 | 16 | 8 | **16** |
| 30 | 31 | 8 | **31** |

- 0-7 pods: Assigned + WARM_IP_TARGET is less than 8, so MINIMUM_IP_TARGET acts as a floor and keeps 8 IPs regardless of actual pod count.
- 8+ pods: Assigned + WARM_IP_TARGET exceeds 8, so WARM_IP_TARGET takes over and keeps assigned + 1 IPs.

## Configuration

I recommend using the Helm chart over the EKS managed add-on, because the add-on configuration is JSON-formatted and tightly coupled to the AWS console.

### [Helm chart](https://github.com/aws/eks-charts/tree/master/stable/aws-vpc-cni) (recommended)

```yaml
env:
  WARM_IP_TARGET: "1"
  MINIMUM_IP_TARGET: "8"
```

### [EKS managed add-on](https://docs.aws.amazon.com/eks/latest/userguide/managing-vpc-cni.html) (Terraform)

```hcl
cluster_addons = {
  vpc-cni = {
    most_recent          = true
    configuration_values = jsonencode({
      env = {
        WARM_IP_TARGET    = "1"
        MINIMUM_IP_TARGET = "8"
      }
    })
  }
}
```

### Verify

Check the aws-node daemonset env vars to confirm WARM_IP_TARGET and MINIMUM_IP_TARGET are applied:

```bash
kubectl get daemonset aws-node \
  -n kube-system \
  -o jsonpath='{.spec.template.spec.containers[0].env}' \
  | jq '.[] | select(.name | test("WARM_IP|MINIMUM_IP"))'
```

## Considerations

### Prefix delegation

With ENABLE_PREFIX_DELEGATION=true, WARM_PREFIX_TARGET takes priority. ENABLE_PREFIX_DELEGATION defaults to `"false"`. The WARM_IP_TARGET + MINIMUM_IP_TARGET combination works best with prefix delegation disabled.

### Sandbox errors

Setting WARM_IP_TARGET=1 caused sandbox creation failures during initial node startup. Set MINIMUM_IP_TARGET to at least the expected initial pod count per node. Continuously tune both values as workload patterns and pod density change over time.

### Recommended values

| Scenario | WARM_IP_TARGET | MINIMUM_IP_TARGET |
|------|:---:|:---:|
| Subnet has plenty of IPs | 1 | 8-16 |
| Subnet is tight on IPs | 1 | 3-5 |
| Heavy pod deployment | 2-3 | 16-32 |

## References

- [amazon-vpc-cni-k8s: CNI Configuration Variables](https://github.com/aws/amazon-vpc-cni-k8s#cni-configuration-variables): Official VPC CNI env var list
- [Amazon EKS best practices guide: VPC and Subnet](https://aws.github.io/aws-eks-best-practices/networking/vpc-cni/): EKS networking best practices
- [Troubleshoot Pod IP assignment issues](https://repost.aws/knowledge-center/eks-pod-assign-ip-address): AWS re:Post troubleshooting guide
