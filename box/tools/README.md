# tools

Kubernetes and automation CLI tools.

## Core Principles

Built on the [Unix philosophy](https://en.wikipedia.org/wiki/Unix_philosophy): "Do One Thing and Do It Well". Each CLI tool solves one specific operational problem, and internally, the application architecture follows the same principle with small, focused modules.

All CLI tools are built with [Rust](https://github.com/rust-lang/rust) 1.91+. Rust provides key operational benefits: minimal container sizes, low memory footprint, single static binaries with no runtime dependencies, memory safety preventing null pointer and buffer overflow crashes, and compile-time guarantees ensuring system stability in production.

## Tool List

| Category | Name | Language | Description |
|----------|------|----------|-------------|
| CLI | [qg](./qg/) (qr generator) | [Rust](./qg/Cargo.toml) | CLI tool that generates QR code images from text or URLs. |
| CLI | [s3vget](./s3vget/) (S3 version get) | [Rust](./s3vget/Cargo.toml) | S3 Object Version Downloader with interactive prompts and configurable timezone support. |
| CLI | [ij](./ij/) (Instance Jump) | [Rust](./ij/Cargo.toml) | Interactive EC2 Session Manager jump tool with multi-region scanning and fuzzy search. |

## License

All tools and resources in this directory are licensed under the repository's main [MIT License](../../LICENSE).
