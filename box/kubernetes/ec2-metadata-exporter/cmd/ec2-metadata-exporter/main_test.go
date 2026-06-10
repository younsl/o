package main

import (
	"context"
	"log/slog"
	"testing"
)

func TestNewLogger(t *testing.T) {
	cases := []struct {
		level   string
		format  string
		enabled slog.Level
	}{
		{"debug", "text", slog.LevelDebug},
		{"info", "json", slog.LevelInfo},
		{"warn", "json", slog.LevelWarn},
		{"error", "text", slog.LevelError},
		{"unknown", "unknown", slog.LevelInfo},
	}
	for _, tc := range cases {
		logger := newLogger(tc.level, tc.format)
		if !logger.Enabled(context.Background(), tc.enabled) {
			t.Errorf("newLogger(%q, %q) should enable level %v", tc.level, tc.format, tc.enabled)
		}
		if tc.enabled > slog.LevelDebug && logger.Enabled(context.Background(), tc.enabled-4) {
			t.Errorf("newLogger(%q, %q) should not enable level %v", tc.level, tc.format, tc.enabled-4)
		}
	}
}
