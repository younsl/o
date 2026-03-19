# Prerequisites

## AWS IAM Permissions

The ec2-scheduler controller requires the following AWS IAM permissions to manage EC2 instance start/stop schedules.

### Required EC2 Permissions

| Action | Purpose |
|--------|---------|
| `ec2:StartInstances` | Start EC2 instances on schedule |
| `ec2:StopInstances` | Stop EC2 instances on schedule |
| `ec2:DescribeInstances` | Resolve instance IDs by tags, monitor instance state |

### Optional STS Permissions (Cross-Account)

Required only when `spec.assumeRoleArn` is set.

| Action | Purpose |
|--------|---------|
| `sts:AssumeRole` | Assume IAM role in target account for cross-account access |

### IAM Policy Example

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EC2SchedulerPermissions",
      "Effect": "Allow",
      "Action": [
        "ec2:StartInstances",
        "ec2:StopInstances",
        "ec2:DescribeInstances"
      ],
      "Resource": "*"
    }
  ]
}
```

To restrict to specific instances, scope the `Resource` field:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EC2SchedulerDescribe",
      "Effect": "Allow",
      "Action": "ec2:DescribeInstances",
      "Resource": "*"
    },
    {
      "Sid": "EC2SchedulerStartStop",
      "Effect": "Allow",
      "Action": [
        "ec2:StartInstances",
        "ec2:StopInstances"
      ],
      "Resource": "arn:aws:ec2:ap-northeast-2:123456789012:instance/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/Environment": "development"
        }
      }
    }
  ]
}
```

> `ec2:DescribeInstances` does not support resource-level permissions, so `Resource: "*"` is required for that action.

### Cross-Account IAM Policy

When managing EC2 instances in another AWS account via `spec.assumeRoleArn`:

**Source account** (where ec2-scheduler runs) — add `sts:AssumeRole`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAssumeRole",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::123456789012:role/ec2-scheduler-role"
    }
  ]
}
```

**Target account** (where EC2 instances reside) — create a role with trust policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::111122223333:role/ec2-scheduler-source-role"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Attach the EC2 permissions policy (above) to this target role.

## Kubernetes RBAC

The Helm chart automatically creates a ClusterRole with the required permissions:

| API Group | Resource | Verbs |
|-----------|----------|-------|
| `ec2-scheduler.io` | `ec2schedules` | get, list, watch |
| `ec2-scheduler.io` | `ec2schedules/status` | get, patch, update |
| `""`, `events.k8s.io` | `events` | create, patch |
| `coordination.k8s.io` | `leases` | get, create, update |

## Authentication Methods

The controller uses the AWS SDK default credential chain. Supported methods in Kubernetes:

| Method | Configuration |
|--------|---------------|
| **IRSA** | Set `serviceAccount.annotations."eks.amazonaws.com/role-arn"` in Helm values |
| **EKS Pod Identity** | Associate the ServiceAccount via EKS Pod Identity API |
| **Instance Profile** | Attach IAM role to the worker node (not recommended for production) |
