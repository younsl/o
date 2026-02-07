# ij

[![GitHub release](https://img.shields.io/github/v/release/younsl/o?filter=ij*&style=flat-square&color=black)](https://github.com/younsl/o/releases?q=ij&expanded=true)
[![Rust](https://img.shields.io/badge/rust-1.91-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

**I**nstance **J**ump - Interactive EC2 Session Manager connection tool with fuzzy search. Scans AWS regions in parallel and connects via SSM. Inspired by [gossm](https://github.com/gjbae1212/gossm).

## Features

- Multi-region parallel scanning (22 AWS regions)
- Fuzzy search with real-time filtering
- Interactive instance selection
- SSH-style escape sequences
- SSM port forwarding (`-L` flag, SSH-style syntax)

## Usage

Connect to EC2 instances with a simple command.

```bash
ij prod                        # Use AWS profile
ij -r ap-northeast-2 prod      # Specific region (faster)
ij -t Environment=production   # Filter by tag
```

## Port Forwarding

Forward local ports to instances or remote hosts through SSM.

```bash
# Instance port forwarding (localhost:80 -> instance:80)
ij -L 80 prod

# Different local port (localhost:8080 -> instance:80)
ij -L 8080:80 prod

# Remote host forwarding via bastion (localhost:3306 -> rds.example.com:3306)
ij -L rds.example.com:3306 prod

# Custom local port for remote host (localhost:5432 -> rds.example.com:3306)
ij -L 5432:rds.example.com:3306 prod

# Combine with region and tag filters
ij -L 3306:rds.example.com:3306 -r ap-northeast-2 -t Role=bastion prod
```

| Format | Tunnel | SSM Document |
|--------|--------|--------------|
| `80` | localhost:80 → instance:80 | `AWS-StartPortForwardingSession` |
| `8080:80` | localhost:8080 → instance:80 | `AWS-StartPortForwardingSession` |
| `host:3306` | localhost:3306 → host:3306 | `AWS-StartPortForwardingSessionToRemoteHost` |
| `3306:host:3306` | localhost:3306 → host:3306 | `AWS-StartPortForwardingSessionToRemoteHost` |

Press `Ctrl+C` to stop the tunnel.

## Installation

Requires AWS CLI v2 and Session Manager plugin.

```bash
make install
mv ~/.cargo/bin/ij /usr/local/bin/
```

## Key Bindings

Navigate and filter instances interactively.

| Key | Action |
|-----|--------|
| `↑/↓` | Move selection |
| `←/→` | Page up/down (10 items) |
| `Page Up/Down` | Page up/down (10 items) |
| `Home/End` | Jump to first/last |
| `Enter` | Connect to selected instance |
| `Esc` / `Ctrl+c` | Cancel |
| `Backspace` | Delete search character |
| `Ctrl+u` | Clear search query |

## Options

CLI flags to customize instance selection.

| Flag | Description |
|------|-------------|
| `--profile`, `-p` | AWS profile name |
| `--region`, `-r` | Limit to single region |
| `--tag-filter`, `-t` | Filter by tag (`Key=Value`) |
| `--forward`, `-L` | Port forwarding spec |
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
