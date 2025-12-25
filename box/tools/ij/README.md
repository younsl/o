# ij

**I**nstance **J**ump - Interactive EC2 Session Manager connection tool. Scans AWS regions in parallel and connects via SSM. Inspired by [gossm](https://github.com/gjbae1212/gossm).

## Usage

Connect to EC2 instances with a simple command.

```bash
ij prod                        # Use AWS profile
ij -r ap-northeast-2 prod      # Specific region (faster)
ij -t Environment=production   # Filter by tag
```

## Installation

Requires AWS CLI v2 and Session Manager plugin.

```bash
make install
mv ~/.cargo/bin/ij /usr/local/bin/
```

## Options

CLI flags to customize instance selection.

| Flag | Description |
|------|-------------|
| `--profile`, `-p` | AWS profile name |
| `--region`, `-r` | Limit to single region |
| `--tag-filter`, `-t` | Filter by tag (`Key=Value`) |
| `--log-level` | Log verbosity (default: `info`) |

## Escape Sequence

SSH-style key sequence for session control when stuck.

| Sequence | Action |
|----------|--------|
| `Enter ~ .` | Force disconnect |

```bash
$ ij prod
# (session unresponsive)
# Press: Enter → ~ → .
Connection closed by escape sequence.
```

## Profile Resolution

AWS profile is resolved in priority order.

1. `--profile` flag (highest)
2. Positional argument (`ij prod`)
3. `AWS_PROFILE` env variable
4. Default profile (lowest)

## Requirements

IAM permissions needed for ij to work.

**User/Role:**
- `ec2:DescribeInstances`
- `ssm:StartSession`

**EC2 Instance:** `AmazonSSMManagedInstanceCore` policy attached.

## License

MIT
