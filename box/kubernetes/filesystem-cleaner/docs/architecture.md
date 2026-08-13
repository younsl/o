# Architecture

This document explains how filesystem-cleaner is built and organized. You'll learn:

- **What each component does** - Clear responsibilities for every package
- **How they work together** - Data flow from CLI input to file deletion
- **Why this design** - Single responsibility principle in action

If you're contributing code, debugging, or just curious about the internals, start here.

## Design Philosophy

filesystem-cleaner follows the Unix philosophy: **"Do one thing and do it well"**. Each package has a single, well-defined responsibility.

## Component Overview

```
┌──────────────────────────┐
│ cmd/filesystem-cleaner   │  Entry point - CLI initialization & signal handling
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│ internal/cleaner         │  Orchestrator - Schedules cleanup & monitors disk usage
└────────────┬─────────────┘
             │
      ┌──────┴──────┬──────────────┐
      ▼             ▼              ▼
┌───────────┐ ┌───────────┐ ┌───────────┐
│ internal/ │ │ internal/ │ │ internal/ │
│ matcher   │ │ scanner   │ │ disk      │
│ Pattern   │ │ Directory │ │ Filesystem│
│ matching  │ │ traversal │ │ usage     │
└───────────┘ └───────────┘ └───────────┘
```

## Components

### cmd/filesystem-cleaner
**Responsibility**: Application entry point

- Parse CLI arguments via `internal/config`
- Set up structured logging with `log/slog`
- Handle shutdown signals (SIGTERM, SIGINT) via `signal.NotifyContext`
- Start the cleaner

### internal/config
**Responsibility**: Configuration management

- Define CLI flags with the standard `flag` package
- Resolve environment variable fallbacks (flag > env > default)
- Validate configuration values (threshold range, mode, log level)
- Define `CleanupMode` (`once`/`interval`)

### internal/matcher
**Responsibility**: Pattern matching logic

Answers one question: *"Does this relative path match the configured glob patterns?"*

Glob patterns are translated into anchored regular expressions at startup. The semantics mirror the Rust globset crate (default settings) used before the Go port: `*` and `?` match across `/`, and `**` as a full component matches zero or more path components.

**Key Methods**:
- `ShouldExclude(path) bool` - Check if path matches exclude patterns
- `ShouldInclude(path) bool` - Check if path matches include patterns

### internal/scanner
**Responsibility**: File system traversal

Walks directory trees and collects files based on pattern rules.

**How it works**:
1. Start from the target path
2. For each entry:
   - Calculate the relative path (forward slashes)
   - Skip symbolic links (prevents infinite loops and deletions outside target paths)
   - If directory and not excluded, recurse
   - If file, keep it when it passes exclude then include filters
3. Return the list of files to delete with their sizes

### internal/disk
**Responsibility**: Filesystem usage

Reports the used-space percentage of the filesystem containing a path via `statfs(2)`. Usage is `(total - available) / total`, where available is the space usable by unprivileged processes.

### internal/cleaner
**Responsibility**: Cleanup orchestration

Coordinates all components to perform the actual cleanup operation.

**Key Responsibilities**:
- **Scheduling**: Run once or periodically based on `CleanupMode`
- **Disk monitoring**: Check if usage exceeds the threshold
- **Coordination**: Use the scanner to find files, then delete them
- **Logging**: Report cleanup progress and results

**Workflow**:
```
1. Check disk usage
   ↓
2. If > threshold:
   ├─> Scan target path for matching files
   ├─> Delete files (or dry-run)
   └─> Log results (freed space, file count)
3. If interval mode:
   └─> Wait for the next tick and repeat
```

### internal/bytesize
**Responsibility**: Human-readable byte formatting for log output (e.g. `1.5 MiB`).

### internal/version
**Responsibility**: Build-time version information injected via `-ldflags -X`.

## Data Flow

```
User → CLI Args → Config → Cleaner
                              ↓
                    ┌─────────┴─────────┐
                    ↓                   ↓
            Disk Monitor          Matcher + Scanner
                    ↓                   ↓
            Threshold Check       File Collection
                    ↓                   ↓
                    └─────────┬─────────┘
                              ↓
                        File Deletion
                              ↓
                      Logging & Results
```

## Design Principles

### 1. Single Responsibility Principle
Each package does **one thing only**:
- `matcher` - Pattern matching
- `scanner` - File traversal
- `disk` - Filesystem usage
- `cleaner` - Orchestration

### 2. Dependency Direction
```
cleaner → scanner → matcher
   ↓
config, disk
```

Dependencies flow in one direction. Lower-level packages (`matcher`, `scanner`, `disk`) don't know about higher-level ones (`cleaner`).

### 3. Testability
Each package has its own unit tests using `t.TempDir()` for real filesystem operations, and the test suite runs with the race detector in CI.

### 4. Unix Philosophy
> "Write programs that do one thing and do it well. Write programs to work together."

- Small, focused packages
- Clear interfaces between components
- Easy to understand, test, and modify

## Adding New Features

**Want to add a new pattern type?**
→ Modify `internal/matcher` only

**Want to change directory traversal logic?**
→ Modify `internal/scanner` only

**Want to add a new scheduling mode?**
→ Modify `internal/cleaner` only

Each change is **isolated to one package**, making the codebase easy to maintain and extend.

## Performance Considerations

- **Scanner**: Traverses directories only once per cleanup cycle
- **Matcher**: Glob patterns are compiled to regular expressions once at startup
- **Memory**: Files are collected in memory before deletion (acceptable for typical workspace sizes)
- **Binary**: Statically linked with CGO disabled, packaged on `scratch`
