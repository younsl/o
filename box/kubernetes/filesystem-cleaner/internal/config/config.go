// Package config parses command-line flags and environment variables into
// the runtime configuration. Flags take precedence over environment
// variables, which take precedence over built-in defaults.
package config

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"
)

// ErrVersion is returned by Parse when the --version flag is set.
var ErrVersion = errors.New("version requested")

// CleanupMode selects between a single cleanup run and periodic cleanup.
type CleanupMode string

const (
	// ModeOnce performs a single cleanup and exits (init container).
	ModeOnce CleanupMode = "once"
	// ModeInterval performs periodic cleanup (sidecar container).
	ModeInterval CleanupMode = "interval"
)

// ParseCleanupMode parses a case-insensitive cleanup mode string.
func ParseCleanupMode(s string) (CleanupMode, error) {
	switch strings.ToLower(s) {
	case "once":
		return ModeOnce, nil
	case "interval":
		return ModeInterval, nil
	default:
		return "", fmt.Errorf("invalid cleanup mode: %s", s)
	}
}

// Config holds the runtime configuration.
type Config struct {
	TargetPaths           []string
	UsageThresholdPercent int
	CheckIntervalMinutes  int
	IncludePatterns       []string
	ExcludePatterns       []string
	CleanupMode           CleanupMode
	DryRun                bool
	LogLevel              string
}

// SlogLevel maps the configured log level to a slog.Level. "trace" maps
// below slog.LevelDebug so a future trace level can slot in unchanged.
func (c *Config) SlogLevel() (slog.Level, error) {
	switch strings.ToLower(c.LogLevel) {
	case "trace":
		return slog.LevelDebug - 4, nil
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("invalid log level: %s", c.LogLevel)
	}
}

// Parse builds a Config from the given command-line arguments (excluding the
// program name). Errors are written to output along with flag usage.
func Parse(args []string, output io.Writer) (*Config, error) {
	defThreshold, err := envInt("USAGE_THRESHOLD_PERCENT", 80)
	if err != nil {
		return nil, err
	}
	defInterval, err := envInt("CHECK_INTERVAL_MINUTES", 10)
	if err != nil {
		return nil, err
	}
	defDryRun, err := envBool("DRY_RUN", false)
	if err != nil {
		return nil, err
	}

	fs := flag.NewFlagSet("filesystem-cleaner", flag.ContinueOnError)
	fs.SetOutput(output)

	targetPaths := fs.String("target-paths",
		envOr("TARGET_PATHS", "/home/runner/_work"),
		"Target filesystem paths to clean (comma-separated)")
	threshold := fs.Int("usage-threshold-percent", defThreshold,
		"Disk usage percentage threshold to trigger cleanup (0-100)")
	interval := fs.Int("check-interval-minutes", defInterval,
		"Interval between cleanup checks in minutes")
	include := fs.String("include-patterns",
		envOr("INCLUDE_PATTERNS", "*"),
		"Glob patterns to include for deletion (e.g., *.tmp, **/cache/**)")
	exclude := fs.String("exclude-patterns",
		envOr("EXCLUDE_PATTERNS", "**/.git/**,**/node_modules/**,*.log"),
		"Glob patterns to exclude from deletion (e.g., **/.git/**, **/node_modules/**)")
	mode := fs.String("cleanup-mode",
		envOr("CLEANUP_MODE", "interval"),
		"Cleanup mode: 'once' or 'interval'")
	dryRun := fs.Bool("dry-run", defDryRun,
		"Dry run mode - no files will be deleted")
	logLevel := fs.String("log-level",
		envOr("LOG_LEVEL", "info"),
		"Log level (trace, debug, info, warn, error)")
	showVersion := fs.Bool("version", false,
		"Print version information and exit")

	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if *showVersion {
		return nil, ErrVersion
	}

	cleanupMode, err := ParseCleanupMode(*mode)
	if err != nil {
		return nil, err
	}
	if *threshold < 0 || *threshold > 100 {
		return nil, fmt.Errorf("usage-threshold-percent must be between 0 and 100, got %d", *threshold)
	}
	if *interval < 1 {
		return nil, fmt.Errorf("check-interval-minutes must be at least 1, got %d", *interval)
	}
	targets := splitList(*targetPaths)
	if len(targets) == 0 {
		return nil, errors.New("target-paths must not be empty")
	}

	cfg := &Config{
		TargetPaths:           targets,
		UsageThresholdPercent: *threshold,
		CheckIntervalMinutes:  *interval,
		IncludePatterns:       splitList(*include),
		ExcludePatterns:       splitList(*exclude),
		CleanupMode:           cleanupMode,
		DryRun:                *dryRun,
		LogLevel:              *logLevel,
	}
	if _, err := cfg.SlogLevel(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// splitList splits a comma-separated string, trimming whitespace and
// dropping empty entries.
func splitList(s string) []string {
	var out []string
	for part := range strings.SplitSeq(s, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func envOr(key, def string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return def
}

func envInt(key string, def int) (int, error) {
	v, ok := os.LookupEnv(key)
	if !ok {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("environment variable %s: %w", key, err)
	}
	return n, nil
}

func envBool(key string, def bool) (bool, error) {
	v, ok := os.LookupEnv(key)
	if !ok {
		return def, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("environment variable %s: %w", key, err)
	}
	return b, nil
}
