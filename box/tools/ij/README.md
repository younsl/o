# ij

Interactive EC2 Session Manager connection tool. Scans all AWS regions concurrently and connects via SSM.

## Usage

```bash
# Scan all regions, select instance interactively
ij

# With AWS profile
ij --profile prod
# or
ij prod

# Specific region only
ij --region ap-northeast-2

# Filter by tags
ij -t Environment=production -t Role=web
```

## Installation

```bash
make install
```

**Prerequisites**: AWS CLI v2, Session Manager plugin, configured credentials

## Options

| Flag | Description |
|------|-------------|
| `--profile`, `-p` | AWS profile (or positional arg) |
| `--region`, `-r` | Single region to scan |
| `--tag-filter`, `-t` | Filter by tag (Key=Value) |
| `--running-only` | Only running instances (default: true) |
| `--log-level` | trace/debug/info/warn/error |

## Profile Resolution

AWS profile is resolved in the following order:

1. `--profile` flag
2. Positional argument (`ij prod`)
3. `AWS_PROFILE` environment variable
4. Default profile in `~/.aws/credentials`

```
┌─────────────────┐
│ --profile flag  │ ← Highest priority
└────────┬────────┘
         ↓
┌─────────────────┐
│ Positional arg  │
└────────┬────────┘
         ↓
┌─────────────────┐
│  AWS_PROFILE    │
└────────┬────────┘
         ↓
┌─────────────────┐
│ Default profile │ ← Lowest priority
└─────────────────┘
```

## AWS Permissions

```json
{
  "Effect": "Allow",
  "Action": ["ec2:DescribeInstances", "ssm:StartSession"],
  "Resource": "*"
}
```

EC2 instances need IAM role with `AmazonSSMManagedInstanceCore` policy.

## Development

```bash
make build      # Debug build
make release    # Release build
make run        # Build and run
make dev        # Run with debug logging
```

## License

MIT
