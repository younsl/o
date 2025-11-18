# Actions Runner

[![GHCR](https://img.shields.io/badge/ghcr.io-younsl%2Factions--runner-000000?style=flat-square&logo=github&logoColor=white)](https://github.com/younsl/o/pkgs/container/actions-runner)
[![License](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

GitHub Actions runner optimized for Korea with multiple APT package sources for faster and more reliable downloads.

## Base Image

Built on [`summerwind/actions-runner:v2.329.0-ubuntu-24.04`](https://hub.docker.com/r/summerwind/actions-runner/tags)

## Additions

- Multiple APT package sources (includes Kakao mirror) using [DEB822 format](https://repolib.readthedocs.io/en/latest/deb822-format.html) (official standard since Ubuntu 24.04)
- Build essentials (`make`)

## Why This Image

- **Faster downloads** in Korea with local package sources
- **High availability** through multiple package servers
- **Drop-in replacement** for standard runner images

## Quick Start

```bash
# Build
docker build -t actions-runner . --platform linux/amd64

# Use in your runner deployment
# (Replace summerwind/actions-runner with this image)
```

## Project Structure

This project follows a common Docker pattern where the directory structure mirrors the container's filesystem layout. Configuration files are organized under `etc/apt/sources.list.d/` matching their actual destination path `/etc/apt/sources.list.d/` in the container. This approach makes it immediately clear where files will be placed and simplifies adding new configuration files.

## Customization

Add or modify APT repository sources by placing `.sources` files in `etc/apt/sources.list.d/`.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for version history and release notes.

## References

- [Actions Runner Available Images](https://github.com/actions/runner-images?tab=readme-ov-file#available-images)
