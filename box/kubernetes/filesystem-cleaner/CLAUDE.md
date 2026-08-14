# CLAUDE.md

Guidance for Claude Code working in this directory. Only non-derivable conventions and traps live here; read the code, Makefile, and README for everything else.

## Overview

Go 1.26.6 filesystem cleaner for Kubernetes, run as an init container (`once` mode) or sidecar (`interval` mode). Ported from Rust. Standard library only — do not add third-party dependencies without a strong reason.

## Traps

- **Glob semantics are intentionally non-standard.** `internal/matcher` preserves the Rust globset defaults the tool shipped with: `*` and `?` match across `/`, and `**` is special only as a full path component. Do not "fix" this to `path.Match` or doublestar semantics — deployed exclude patterns like `*.log` rely on matching at any depth.
- **Patterns match paths relative to the target path**, with forward slashes. Exclude applies to files and directories, include applies to files only.
- **Symlinks are never followed or deleted.** This guards against infinite loops and deletions outside target paths. Keep lstat semantics (`DirEntry.Info`) when touching the scanner.
- **Disk usage is `(total - available) / total`** from `statfs(2)`, where available is the unprivileged (`Bavail`) figure. This matches the previous Rust behavior and can differ from `df`.

## Conventions

- The image runs as `USER 65532:65532` on `scratch` with no CA certificates: the cleaner makes no network calls, so do not add TLS-dependent features without updating the Dockerfile.
- In Kubernetes the cleaner must run as the same UID/GID as the container whose files it deletes (e.g. `1001` for actions-runner) and share the same volume mount path.
- CI (`release-go-scratch-containers.yml`) gates on gofmt, `go vet`, race-enabled tests, and 70% line coverage. Release triggers are documented in the repo root CLAUDE.md.
