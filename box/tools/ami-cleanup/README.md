# ami-cleanup

[![Rust](https://img.shields.io/badge/rust-1.94-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

TUI tool to find and remove unused [AMIs](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/AMIs.html) and associated EBS snapshots to reduce AWS storage costs. Scans EC2 instances, launch templates, and auto scaling groups across multiple accounts and regions.

## Features

- Multi-region parallel scanning
- Cross-account AMI usage detection via consumer profiles
- Shared AMI detection (skips AMIs with launch permissions)
- AWS Backup / DLM managed AMI filtering
- Interactive TUI with sort, select, and batch delete
- Associated EBS snapshot cleanup on AMI deregistration

## Usage

```bash
ami-cleanup                                    # Interactive profile selection
ami-cleanup --profile prod                     # Skip profile selector
ami-cleanup --profile prod -r ap-northeast-2   # Specific region
ami-cleanup --profile prod --min-age-days 30   # Only AMIs older than 30 days
ami-cleanup --profile prod \
  --consumer-profile dev \
  --consumer-profile stg                       # Check usage in other accounts
```

## Installation

**Homebrew:**

```bash
brew install younsl/tap/ami-cleanup
```

**From source:**

```bash
make install
```

Builds a release binary and installs it to `~/.local/bin/`. Ensure this directory is in your `$PATH`.

## Key Bindings

### Profile Selection

| Key | Action |
|-----|--------|
| `j/k` or `↑/↓` | Move cursor |
| `Space` / `Enter` | Select owner profile |
| `Space` | Toggle consumer profile |
| `Enter` | Confirm and start scan |
| `q` / `Esc` | Quit |

### Browse

| Key | Action |
|-----|--------|
| `j/k` or `↑/↓` | Move cursor |
| `g` / `G` | Jump to first / last |
| `Space` | Toggle selection |
| `a` | Select / deselect all |
| `s` | Cycle sort (Age, Launched, Size, Name) |
| `d` / `Enter` | Delete selected |
| `y` | Confirm deletion |
| `q` / `Esc` | Quit |

## Options

| Flag | Description |
|------|-------------|
| `--profile` | AWS profile name (interactive if omitted) |
| `--region`, `-r` | AWS regions to scan (default: all enabled) |
| `--min-age-days` | Only target AMIs older than N days (default: `0`) |
| `--consumer-profile` | Additional AWS profiles to check for AMI usage |

## Requirements

IAM permissions needed for ami-cleanup to work.

<details>
<summary>Owner account IAM Policy</summary>

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAmiScan",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeImages",
        "ec2:DescribeImageAttribute",
        "ec2:DescribeInstances",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeLaunchTemplateVersions",
        "ec2:DescribeRegions",
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeLaunchConfigurations",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AllowAmiCleanup",
      "Effect": "Allow",
      "Action": [
        "ec2:DeregisterImage",
        "ec2:DeleteSnapshot"
      ],
      "Resource": "*"
    }
  ]
}
```

</details>

<details>
<summary>Consumer account IAM Policy (read-only)</summary>

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowAmiUsageScan",
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribeLaunchTemplateVersions",
        "autoscaling:DescribeAutoScalingGroups",
        "autoscaling:DescribeLaunchConfigurations"
      ],
      "Resource": "*"
    }
  ]
}
```

</details>

## License

See [LICENSE](../../LICENSE) for more details.
