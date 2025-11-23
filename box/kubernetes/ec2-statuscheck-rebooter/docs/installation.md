# Installation Guide

## Prerequisites

- Kubernetes cluster (EKS recommended)
- AWS IAM role with EC2 permissions
  - Supports [IRSA (IAM Roles for Service Accounts)](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
  - Supports [EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
- Helm 3.x

## Required IAM Permissions

Required EC2 permissions: `DescribeInstanceStatus`, `DescribeInstances`, `DescribeRegions`, `RebootInstances`

**IAM Policy Document:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EC2StatusCheckRebooterPermissions",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeInstances",
        "ec2:DescribeRegions",
        "ec2:RebootInstances"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": ["us-east-1", "ap-northeast-2"]
        }
      }
    }
  ]
}
```

**Note**: The `aws:RequestedRegion` condition restricts API calls to specific regions. Adjust the region list according to your deployment requirements.

For detailed permission breakdown and usage, see [Architecture Documentation - AWS Authentication](architecture.md#aws-authentication).

## Installation Methods

### Option 1: EKS Pod Identity (Recommended for EKS 1.24+)

[EKS Pod Identity](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html) is the newer, simpler authentication method.

**Prerequisites - Verify EKS Pod Identity Agent:**

Before using EKS Pod Identity, confirm the eks-pod-identity-agent is installed in your cluster:

```bash
# Check if eks-pod-identity-agent DaemonSet exists
kubectl get daemonset eks-pod-identity-agent -n kube-system
```

**Setup Steps:**

1. Create IAM role with EC2 permissions with trust relationship for EKS pod identity
2. Create pod identity association

```bash
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --namespace monitoring \
  --service-account ec2-statuscheck-rebooter \
  --role-arn arn:aws:iam::ACCOUNT_ID:role/EC2RebooterRole
```

3. Install helm chart:

```bash
helm upgrade --install ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
  --namespace monitoring \
  --create-namespace
```

**Note**: With EKS Pod Identity, no ServiceAccount `role-arn` annotation is required. The pod identity association handles authentication automatically.

### Option 2: IRSA (IAM Roles for Service Accounts)

For clusters with OIDC provider configured, create an IAM role with trust relationship:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/oidc.eks.REGION.amazonaws.com/id/OIDC_ID"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.REGION.amazonaws.com/id/OIDC_ID:sub": "system:serviceaccount:monitoring:ec2-statuscheck-rebooter",
          "oidc.eks.REGION.amazonaws.com/id/OIDC_ID:aud": "sts.amazonaws.com"
        }
      }
    }
  ]
}
```

Install with IRSA annotation:

```bash
helm upgrade --install ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
  --namespace monitoring \
  --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME
```

### Option 3: Worker Node Instance Profile

Attach the IAM policy to the EKS worker node IAM role. Note that this grants permissions to all pods on the node.

## Quick Start

### Pull Helm Chart from OCI Registry

```bash
# Pull and extract chart from GitHub Container Registry
helm pull oci://ghcr.io/younsl/ec2-statuscheck-rebooter-chart --version 1.0.0 --untar

# Or pull latest version
helm pull oci://ghcr.io/younsl/ec2-statuscheck-rebooter-chart --untar

# Extract to specific directory
helm pull oci://ghcr.io/younsl/ec2-statuscheck-rebooter-chart --untar --untardir ./charts
```

### Install or Upgrade Chart

```bash
# Option A: With EKS Pod Identity (recommended)
# 1. Create pod identity association first (see Option 1 above)
# 2. Install/upgrade chart
helm upgrade --install ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
  --namespace monitoring \
  --create-namespace

# Option B: With IRSA
helm upgrade --install ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
  --namespace monitoring \
  --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME

# Option C: Install/upgrade directly from OCI registry
helm upgrade --install ec2-statuscheck-rebooter oci://ghcr.io/younsl/ec2-statuscheck-rebooter-chart \
  --version 1.0.0 \
  --namespace monitoring \
  --create-namespace
```

## Configuration

### Helm Values

| Parameter | Environment Variable | Description | Default |
|-----------|----------------------|-------------|---------|
| `rebooter.checkIntervalSeconds` | CHECK_INTERVAL_SECONDS | Check interval in seconds | `300` |
| `rebooter.failureThreshold` | FAILURE_THRESHOLD | Failure count before reboot | `2` |
| `rebooter.region` | AWS_REGION | AWS region (empty = auto-detect) | `""` |
| `rebooter.tagFilters` | TAG_FILTERS | Comma-separated EC2 tag filters (Key=Value) | `[]` |
| `rebooter.dryRun` | DRY_RUN | Dry run mode (no actual reboot) | `false` |
| `rebooter.logFormat` | LOG_FORMAT | Log format: json or pretty | `"json"` |
| `rebooter.logLevel` | LOG_LEVEL | Log level: trace, debug, info, warn, error | `"info"` |
| `livenessProbe.initialDelaySeconds` | N/A | Initial delay before liveness probe | `10` |
| `livenessProbe.periodSeconds` | N/A | Liveness probe check interval | `30` |
| `readinessProbe.initialDelaySeconds` | N/A | Initial delay before readiness probe | `5` |
| `readinessProbe.periodSeconds` | N/A | Readiness probe check interval | `10` |
| `serviceAccount.annotations` | N/A | ServiceAccount annotations (IRSA) | `{}` |
| `resources.limits.cpu` | N/A | CPU limit | `200m` |
| `resources.limits.memory` | N/A | Memory limit | `128Mi` |

## Configuration Examples

### Example 1: Monitor External Production Database Servers

Monitor standalone database servers outside the Kubernetes cluster:

```bash
helm upgrade --install ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
  --namespace monitoring \
  --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789012:role/EC2RebooterRole \
  --set rebooter.tagFilters="{Environment=production,Role=database,AutoReboot=true}" \
  --set rebooter.checkIntervalSeconds=180 \
  --set rebooter.failureThreshold=3
```

### Example 2: Dry Run Mode

Test the configuration without performing actual reboots:

```bash
helm upgrade --install ec2-statuscheck-rebooter ./charts/ec2-statuscheck-rebooter \
  --namespace monitoring \
  --create-namespace \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789012:role/EC2RebooterRole \
  --set rebooter.dryRun=true \
  --set rebooter.logFormat=pretty
```

### Example 3: Multi-Region Monitoring

Monitor instances across multiple regions (requires separate deployments):

```bash
# Deploy for us-east-1
helm upgrade --install ec2-rebooter-us-east-1 ./charts/ec2-statuscheck-rebooter \
  --namespace monitoring \
  --create-namespace \
  --set rebooter.region=us-east-1 \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT_ID:role/EC2RebooterRole

# Deploy for ap-northeast-2
helm upgrade --install ec2-rebooter-ap-northeast-2 ./charts/ec2-statuscheck-rebooter \
  --namespace monitoring \
  --create-namespace \
  --set rebooter.region=ap-northeast-2 \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::ACCOUNT_ID:role/EC2RebooterRole
```

## Verification

### Check Deployment Status

```bash
# Check pod status
kubectl get pods -n monitoring -l app.kubernetes.io/name=ec2-statuscheck-rebooter

# Check logs
kubectl logs -f deployment/ec2-statuscheck-rebooter -n monitoring

# Check health endpoints
kubectl port-forward deployment/ec2-statuscheck-rebooter 8080:8080 -n monitoring
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
```

### Verify IAM Authentication

```bash
# Exec into pod and test AWS credentials
kubectl exec -it deployment/ec2-statuscheck-rebooter -n monitoring -- sh

# Inside pod
aws sts get-caller-identity
aws ec2 describe-instance-status --region us-east-1
```

## Uninstall

```bash
# Uninstall Helm release
helm uninstall ec2-statuscheck-rebooter -n monitoring

# Delete namespace (if no other resources)
kubectl delete namespace monitoring
```

## Next Steps

- Configure tag filters to match your EC2 instances
- Set appropriate failure threshold for your environment
- Review logs to ensure instances are being monitored
- See [Troubleshooting Guide](troubleshooting.md) if you encounter issues
