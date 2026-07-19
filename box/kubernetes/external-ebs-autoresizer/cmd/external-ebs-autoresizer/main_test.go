package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

type fakePreflight struct {
	err   error
	calls int
}

func (f *fakePreflight) Preflight(_ context.Context) (string, int, time.Duration, error) {
	f.calls++
	if f.err != nil {
		return "http://x/health", 503, time.Millisecond, f.err
	}
	return "http://x/health", 200, time.Millisecond, nil
}

func TestRunPreflightSucceedsFirstTry(t *testing.T) {
	f := &fakePreflight{}
	runPreflight(context.Background(), testLogger(), "grafana", f)
	if f.calls != 1 {
		t.Errorf("calls = %d, want 1", f.calls)
	}
}

func TestRunPreflightRetriesThenFails(t *testing.T) {
	old := preflightBackoff
	preflightBackoff = 0
	defer func() { preflightBackoff = old }()

	f := &fakePreflight{err: errors.New("boom")}
	runPreflight(context.Background(), testLogger(), "alertmanager", f)
	if f.calls != preflightAttempts {
		t.Errorf("calls = %d, want %d", f.calls, preflightAttempts)
	}
}

func TestRunPreflightStopsOnContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f := &fakePreflight{err: errors.New("boom")}
	runPreflight(ctx, testLogger(), "grafana", f)
	// Cancelled context: first attempt runs, then the backoff wait returns
	// immediately without exhausting all attempts.
	if f.calls < 1 || f.calls >= preflightAttempts {
		t.Errorf("calls = %d, want between 1 and %d", f.calls, preflightAttempts-1)
	}
}

func TestNewLogger(t *testing.T) {
	cases := []struct {
		level  string
		format string
	}{
		{"debug", "json"},
		{"warn", "text"},
		{"error", "json"},
		{"info", "text"},
		{"unknown", "unknown"},
	}
	for _, tc := range cases {
		if got := newLogger(tc.level, tc.format); got == nil {
			t.Errorf("newLogger(%q, %q) = nil", tc.level, tc.format)
		}
	}
}

func TestLogResizePolicyBothModes(t *testing.T) {
	// Purely informational logging: assert both grow-mode branches run without
	// panicking on a minimal config.
	logResizePolicy(testLogger(), &config.Config{GrowMode: config.GrowModePercent, GrowPercent: 10})
	logResizePolicy(testLogger(), &config.Config{GrowMode: config.GrowModeAbsolute, GrowAmount: "10GiB", GrowAmountGiB: 10})
}
