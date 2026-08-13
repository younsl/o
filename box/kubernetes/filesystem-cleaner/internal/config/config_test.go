package config

import (
	"errors"
	"io"
	"log/slog"
	"testing"
)

func parse(t *testing.T, args ...string) (*Config, error) {
	t.Helper()
	return Parse(args, io.Discard)
}

func TestParseCleanupMode(t *testing.T) {
	cases := []struct {
		in      string
		want    CleanupMode
		wantErr bool
	}{
		{"once", ModeOnce, false},
		{"interval", ModeInterval, false},
		{"ONCE", ModeOnce, false},
		{"Interval", ModeInterval, false},
		{"invalid", "", true},
	}
	for _, c := range cases {
		got, err := ParseCleanupMode(c.in)
		if c.wantErr {
			if err == nil {
				t.Errorf("ParseCleanupMode(%q) expected error", c.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseCleanupMode(%q) failed: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("ParseCleanupMode(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestParseDefaults(t *testing.T) {
	cfg, err := parse(t)
	if err != nil {
		t.Fatalf("Parse() failed: %v", err)
	}

	if len(cfg.TargetPaths) != 1 || cfg.TargetPaths[0] != "/home/runner/_work" {
		t.Errorf("TargetPaths = %v, want [/home/runner/_work]", cfg.TargetPaths)
	}
	if cfg.UsageThresholdPercent != 80 {
		t.Errorf("UsageThresholdPercent = %d, want 80", cfg.UsageThresholdPercent)
	}
	if cfg.CheckIntervalMinutes != 10 {
		t.Errorf("CheckIntervalMinutes = %d, want 10", cfg.CheckIntervalMinutes)
	}
	if len(cfg.IncludePatterns) != 1 || cfg.IncludePatterns[0] != "*" {
		t.Errorf("IncludePatterns = %v, want [*]", cfg.IncludePatterns)
	}
	wantExclude := []string{"**/.git/**", "**/node_modules/**", "*.log"}
	if len(cfg.ExcludePatterns) != len(wantExclude) {
		t.Fatalf("ExcludePatterns = %v, want %v", cfg.ExcludePatterns, wantExclude)
	}
	for i, p := range wantExclude {
		if cfg.ExcludePatterns[i] != p {
			t.Errorf("ExcludePatterns[%d] = %q, want %q", i, cfg.ExcludePatterns[i], p)
		}
	}
	if cfg.CleanupMode != ModeInterval {
		t.Errorf("CleanupMode = %q, want %q", cfg.CleanupMode, ModeInterval)
	}
	if cfg.DryRun {
		t.Error("DryRun = true, want false")
	}
	if cfg.LogLevel != "info" {
		t.Errorf("LogLevel = %q, want info", cfg.LogLevel)
	}
}

func TestParseFlags(t *testing.T) {
	cfg, err := parse(t,
		"--target-paths=/tmp,/var/tmp",
		"--usage-threshold-percent=70",
		"--cleanup-mode=once",
		"--dry-run",
		"--log-level=debug",
	)
	if err != nil {
		t.Fatalf("Parse() failed: %v", err)
	}

	if len(cfg.TargetPaths) != 2 {
		t.Errorf("TargetPaths = %v, want 2 entries", cfg.TargetPaths)
	}
	if cfg.UsageThresholdPercent != 70 {
		t.Errorf("UsageThresholdPercent = %d, want 70", cfg.UsageThresholdPercent)
	}
	if cfg.CleanupMode != ModeOnce {
		t.Errorf("CleanupMode = %q, want %q", cfg.CleanupMode, ModeOnce)
	}
	if !cfg.DryRun {
		t.Error("DryRun = false, want true")
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("LogLevel = %q, want debug", cfg.LogLevel)
	}
}

func TestParseEnvOverrides(t *testing.T) {
	t.Setenv("TARGET_PATHS", "/data")
	t.Setenv("USAGE_THRESHOLD_PERCENT", "50")
	t.Setenv("CLEANUP_MODE", "once")
	t.Setenv("DRY_RUN", "true")

	cfg, err := parse(t)
	if err != nil {
		t.Fatalf("Parse() failed: %v", err)
	}

	if len(cfg.TargetPaths) != 1 || cfg.TargetPaths[0] != "/data" {
		t.Errorf("TargetPaths = %v, want [/data]", cfg.TargetPaths)
	}
	if cfg.UsageThresholdPercent != 50 {
		t.Errorf("UsageThresholdPercent = %d, want 50", cfg.UsageThresholdPercent)
	}
	if cfg.CleanupMode != ModeOnce {
		t.Errorf("CleanupMode = %q, want %q", cfg.CleanupMode, ModeOnce)
	}
	if !cfg.DryRun {
		t.Error("DryRun = false, want true")
	}
}

func TestParseFlagBeatsEnv(t *testing.T) {
	t.Setenv("USAGE_THRESHOLD_PERCENT", "50")

	cfg, err := parse(t, "--usage-threshold-percent=90")
	if err != nil {
		t.Fatalf("Parse() failed: %v", err)
	}
	if cfg.UsageThresholdPercent != 90 {
		t.Errorf("UsageThresholdPercent = %d, want 90", cfg.UsageThresholdPercent)
	}
}

func TestParseInvalidEnvInt(t *testing.T) {
	t.Setenv("USAGE_THRESHOLD_PERCENT", "not-a-number")
	if _, err := parse(t); err == nil {
		t.Error("expected error for invalid USAGE_THRESHOLD_PERCENT")
	}
}

func TestParseInvalidEnvBool(t *testing.T) {
	t.Setenv("DRY_RUN", "not-a-bool")
	if _, err := parse(t); err == nil {
		t.Error("expected error for invalid DRY_RUN")
	}
}

func TestParseThresholdOutOfRange(t *testing.T) {
	if _, err := parse(t, "--usage-threshold-percent=101"); err == nil {
		t.Error("expected error for threshold above 100")
	}
	if _, err := parse(t, "--usage-threshold-percent=-1"); err == nil {
		t.Error("expected error for negative threshold")
	}
}

func TestParseInvalidInterval(t *testing.T) {
	if _, err := parse(t, "--check-interval-minutes=0"); err == nil {
		t.Error("expected error for zero interval")
	}
}

func TestParseInvalidMode(t *testing.T) {
	if _, err := parse(t, "--cleanup-mode=bogus"); err == nil {
		t.Error("expected error for invalid cleanup mode")
	}
}

func TestParseInvalidLogLevel(t *testing.T) {
	if _, err := parse(t, "--log-level=bogus"); err == nil {
		t.Error("expected error for invalid log level")
	}
}

func TestParseEmptyTargetPaths(t *testing.T) {
	if _, err := parse(t, "--target-paths=,"); err == nil {
		t.Error("expected error for empty target paths")
	}
}

func TestParseVersionFlag(t *testing.T) {
	_, err := parse(t, "--version")
	if !errors.Is(err, ErrVersion) {
		t.Errorf("expected ErrVersion, got %v", err)
	}
}

func TestSlogLevel(t *testing.T) {
	cases := []struct {
		in   string
		want slog.Level
	}{
		{"trace", slog.LevelDebug - 4},
		{"debug", slog.LevelDebug},
		{"info", slog.LevelInfo},
		{"warn", slog.LevelWarn},
		{"error", slog.LevelError},
		{"WARN", slog.LevelWarn},
	}
	for _, c := range cases {
		cfg := &Config{LogLevel: c.in}
		got, err := cfg.SlogLevel()
		if err != nil {
			t.Errorf("SlogLevel(%q) failed: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("SlogLevel(%q) = %v, want %v", c.in, got, c.want)
		}
	}

	cfg := &Config{LogLevel: "bogus"}
	if _, err := cfg.SlogLevel(); err == nil {
		t.Error("expected error for invalid log level")
	}
}
