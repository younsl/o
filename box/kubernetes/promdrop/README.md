# promdrop

[![Release](https://img.shields.io/github/v/release/younsl/o?filter=promdrop*&style=flat-square&color=black)](https://github.com/younsl/o/releases?q=promdrop)
[![GitHub Container Registry](https://img.shields.io/badge/ghcr.io-promdrop-black?style=flat-square&logo=docker&logoColor=white)](https://github.com/younsl/o/pkgs/container/promdrop)
[![Rust](https://img.shields.io/badge/rust-1.93-black?style=flat-square&logo=rust&logoColor=white)](https://www.rust-lang.org/)
[![GitHub license](https://img.shields.io/github/license/younsl/o?style=flat-square&color=black)](https://github.com/younsl/o/blob/main/LICENSE)

A CLI tool that generates Prometheus `metric_relabel_configs` to drop unused metrics, helping reduce monitoring costs.

## Features

- Parse Mimirtool JSON output to identify unused metrics
- Group metrics by prefix for efficient regex patterns
- Generate optimized Prometheus relabel configurations
- Export metrics lists as text files per job
- Interactive confirmation before generating configs

## Installation

### From Source

```bash
cargo install --path .
```

### Build from Source

```bash
# Debug build
make build

# Release build (optimized)
make release
```

## Usage

### Basic Usage

```bash
# Generate relabel configs from Mimirtool output
promdrop --file prometheus-metrics.json

# Specify custom output locations
promdrop --file prometheus-metrics.json \
  --txt-output-dir ./unused \
  --output combined_relabel_configs.yaml
```

### Complete Workflow

1. Run Mimirtool to analyze your Prometheus metrics:

```bash
mimirtool analyze prometheus --output=prometheus-metrics.json
```

2. Generate drop configs with promdrop:

```bash
promdrop --file prometheus-metrics.json
```

3. Review the generated files:
   - `unused/summary.txt` - Overview of all unused metrics
   - `unused/<job>_unused_metrics.txt` - Metrics list per job
   - `combined_relabel_configs.yaml` - Prometheus relabel configs

## Command-Line Options

```
Options:
  -f, --file <FILE>              Input prometheus-metrics.json file path
  -t, --txt-output-dir <DIR>     Output directory for .txt files [default: unused]
  -o, --output <FILE>            Output file path for combined YAML [default: combined_relabel_configs.yaml]
  -h, --help                     Print help
  -V, --version                  Print version
```

## Development

### Building

```bash
make build          # Debug build
make release        # Optimized release build
make build-all      # Build for all platforms (requires cross)
```

### Testing

```bash
make test           # Run all tests
cargo test          # Run tests with cargo directly

# Run specific test suites
cargo test --test integration_test      # Integration tests
cargo test --test e2e_conversion_test   # End-to-end tests
cargo test --lib                        # Unit tests only
```

See [Testing Guide](docs/testing.md) for detailed information about the test suite.

### Code Quality

```bash
make fmt            # Format code with rustfmt
make lint           # Run clippy linter
make check          # Check code without building
```

## Architecture

### Project Structure

```
src/
├── main.rs         # CLI entry point and orchestration
├── models.rs       # Data structures and types
├── parser.rs       # JSON parsing logic
├── grouper.rs      # Metric grouping and regex generation
└── output.rs       # File generation (YAML, TXT, tables)
```

### Key Components

**Parser** (`parser.rs`):
- Reads Mimirtool JSON output
- Extracts metrics per job
- Deduplicates and sorts metrics

**Grouper** (`grouper.rs`):
- Groups metrics by prefix (text before first `_`)
- Chunks metrics to fit within regex length limits (1000 chars)
- Generates Prometheus relabel rules

**Output** (`output.rs`):
- Generates summary tables using prettytable-rs
- Creates per-job `.txt` files with metric lists
- Builds combined YAML config with inline comments

## Input Format

Expects JSON from Mimirtool with this structure:

```json
{
  "additional_metric_counts": [
    {
      "metric": "unused_metric_name",
      "job_counts": [
        {"job": "job_name"}
      ]
    }
  ]
}
```

## Output Format

### YAML Configuration

```yaml
# Summary: 120 of 500 unused metrics / 5 prefix groups / 3 rules generated
job_name: api-server
metric_relabel_configs:
  - source_labels: [__name__]
    regex: 'http_(requests|errors|duration)_total'
    action: drop
```

### Text Files

- `unused/summary.txt` - Tabular summary of all jobs and metrics
- `unused/<job>_unused_metrics.txt` - One metric per line for each job

## License

MIT License - see LICENSE file for details.

## Related Tools

- [Grafana Mimirtool](https://grafana.com/docs/mimir/latest/manage/tools/mimirtool/) - Analyze Prometheus metrics usage
- [Mimirtool로 미사용 메트릭 분석하기](https://younsl.github.io/blog/mimirtool-unused-metric/) - Blog post about analyzing unused metrics with Mimirtool
