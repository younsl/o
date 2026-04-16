# tools

Kubernetes and automation CLI tools.

## Core Principles

Built on the [Unix philosophy](https://en.wikipedia.org/wiki/Unix_philosophy): "Do One Thing and Do It Well". Each CLI tool solves one specific operational problem, and internally, the application architecture follows the same principle with small, focused modules.

All CLI tools are built with [Rust](https://github.com/rust-lang/rust) 1.93+. Rust provides key operational benefits: minimal container sizes, low memory footprint, single static binaries with no runtime dependencies, memory safety preventing null pointer and buffer overflow crashes, and compile-time guarantees ensuring system stability in production.

## Tool List

| Category | Name | Language | Description |
|----------|------|----------|-------------|
| CLI | [qg](./qg/) (qr generator) | [Rust](./qg/Cargo.toml) | CLI tool that generates QR code images from text or URLs. |
| CLI | [ij](./ij/) (Infra Janitor) | [Rust](./ij/Cargo.toml) | EC2 operations CLI for SSM connect and AMI cleanup with multi-region scanning. |

## License

All tools and resources in this directory are licensed under the repository's main [MIT License](../../LICENSE).
