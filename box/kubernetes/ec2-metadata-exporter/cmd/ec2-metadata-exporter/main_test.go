package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/aws/smithy-go/logging"

	"github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/config"
)

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to find free port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// TestRunStopsOnContextCancel exercises the full wiring in run with a
// pre-cancelled context: the AWS config loads from static test credentials,
// the first scrape fails immediately on the cancelled context, and the
// collector loop exits without touching the network.
func TestRunStopsOnContextCancel(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	t.Setenv("AWS_EC2_METADATA_DISABLED", "true")

	cfg := config.Config{
		Region:         "us-east-1",
		ScrapeInterval: time.Hour,
		MetricsPort:    freePort(t),
		HealthPort:     freePort(t),
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	done := make(chan error, 1)
	go func() { done <- run(ctx, cfg, logger) }()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("run() error = %v, want nil on context cancel", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run did not stop after context cancel")
	}
}

func TestSlogAWSLoggerRoutesByClassification(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
	l := slogAWSLogger{logger}

	l.Logf(logging.Warn, "throttled %d times", 3)
	l.Logf(logging.Debug, "request sent")

	out := buf.String()
	if !strings.Contains(out, `"level":"WARN"`) || !strings.Contains(out, "throttled 3 times") {
		t.Errorf("warn classification not routed to slog Warn: %s", out)
	}
	if !strings.Contains(out, `"level":"DEBUG"`) || !strings.Contains(out, "request sent") {
		t.Errorf("debug classification not routed to slog Debug: %s", out)
	}
	if !strings.Contains(out, `"source":"aws-sdk"`) {
		t.Errorf("aws-sdk source attribute missing: %s", out)
	}
}

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
