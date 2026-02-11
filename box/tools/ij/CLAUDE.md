# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`ij` is an interactive EC2 Session Manager connection tool written in Rust. It scans all AWS regions concurrently and connects to instances via SSM. Inspired by [gossm](https://github.com/gjbae1212/gossm).

**Key features:**
- Multi-region parallel scanning (22 AWS regions)
- Interactive instance selection with arrow keys
- Tag-based filtering (`-t Key=Value`)
- SSH-style escape sequences (`Enter ~ .` to disconnect)
- PTY-based session management with proper signal handling

## Development Commands

```bash
make build      # Debug build (target/debug/)
make release    # Optimized release build (target/release/)
make run        # Build and run
make dev        # Run with debug logging (--log-level debug)
make test       # Run tests (cargo test --verbose)
make fmt        # Format code (cargo fmt)
make lint       # Run clippy (cargo clippy -- -D warnings)
make install    # Install to ~/.cargo/bin/
make deps       # Update dependencies (cargo update)
make clean      # Remove build artifacts
```

## Architecture

### Source Structure

Single-file application (`src/main.rs`) organized into logical sections:

1. **Build Information** (lines 25-31): Version info from `build.rs` (commit hash, build date)
2. **CLI Arguments** (lines 37-68): Clap-based argument parsing with env var support
3. **Instance Model** (lines 74-135): `Instance` struct and table formatting helpers
4. **AWS Regions** (lines 141-149): Static list of 22 regions to scan
5. **EC2 Instance Listing** (lines 155-288): Async parallel region scanning
6. **Escape Sequence Detection** (lines 294-348): SSH-style `Enter ~ .` disconnect
7. **Session Manager Connection** (lines 354-587): PTY-based SSM session with I/O loop
8. **Interactive Selection** (lines 593-623): dialoguer-based instance picker
9. **Main** (lines 629-692): Entry point with async runtime

### Key Dependencies

| Crate | Purpose |
|-------|---------|
| `aws-sdk-ec2` | EC2 API calls |
| `clap` | CLI argument parsing with derive macros |
| `dialoguer` | Interactive selection UI |
| `tokio` | Async runtime for parallel scanning |
| `nix` | Unix PTY/signal handling |
| `tracing` | Structured logging |

### Build-Time Configuration

`build.rs` injects git commit hash and build date as environment variables:
- `BUILD_COMMIT`: Short git commit hash
- `BUILD_DATE`: Build date (YYYY-MM-DD)

## Technical Notes

### PTY and Escape Sequence Handling

The tool uses a PTY (pseudo-terminal) to intercept I/O between the user and SSM session:

1. Opens PTY pair (master/slave)
2. Sets terminal to raw mode (no echo, no line buffering)
3. Spawns `aws ssm start-session` with slave as stdin/stdout/stderr
4. Runs I/O loop: reads stdin -> detects escape sequences -> forwards to master
5. Restores terminal settings on exit

Escape sequences (SSH-style):
- `Enter ~ .`: Disconnect from session
- `Enter ~ ?`: Show help

### Signal Handling

- `SIGINT` and `SIGTSTP` are ignored in parent process (passed through to SSM session)
- Signals are restored to default handlers after session ends

### AWS Profile Resolution Order

1. `--profile` flag (highest priority)
2. Positional argument (`ij prod`)
3. `AWS_PROFILE` environment variable
4. Default profile (lowest priority)

## AWS Permissions Required

```json
{
  "Effect": "Allow",
  "Action": ["ec2:DescribeInstances", "ssm:StartSession"],
  "Resource": "*"
}
```

Target EC2 instances need IAM role with `AmazonSSMManagedInstanceCore` policy.

## Prerequisites

- AWS CLI v2
- Session Manager plugin (`session-manager-plugin`)
- Configured AWS credentials
- Rust 1.93+
