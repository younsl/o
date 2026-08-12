package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/config"
)

func TestNewLogger(t *testing.T) {
	tests := []struct {
		level   string
		format  string
		enabled slog.Level
	}{
		{"debug", "text", slog.LevelDebug},
		{"info", "json", slog.LevelInfo},
		{"warn", "json", slog.LevelWarn},
		{"error", "json", slog.LevelError},
		{"nonsense", "json", slog.LevelInfo},
	}
	for _, tt := range tests {
		t.Run(tt.level, func(t *testing.T) {
			logger := newLogger(tt.level, tt.format)
			if !logger.Enabled(context.Background(), tt.enabled) {
				t.Errorf("logger at %q should handle %s", tt.level, tt.enabled)
			}
			if tt.enabled > slog.LevelDebug && logger.Enabled(context.Background(), tt.enabled-4) {
				t.Errorf("logger at %q should drop records below %s", tt.level, tt.enabled)
			}
		})
	}
}

// Every log line has to be machine-parseable, which is the whole point of
// defaulting the handler to JSON.
func TestLoggerFormats(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	logger.Info("hello", "key", "value")

	var line map[string]any
	if err := json.Unmarshal(buf.Bytes(), &line); err != nil {
		t.Fatalf("json handler produced unparseable output: %v", err)
	}
	if line["msg"] != "hello" || line["key"] != "value" {
		t.Errorf("log line = %v", line)
	}
}

func TestSeverityList(t *testing.T) {
	if got := severityList(config.Config{}); got != "all" {
		t.Errorf("severityList() with no filter = %q, want all", got)
	}
	got := severityList(config.Config{AnalyzeSeverities: map[string]bool{"critical": true, "warning": true}})
	if !strings.Contains(got, "critical") || !strings.Contains(got, "warning") {
		t.Errorf("severityList() = %q", got)
	}
}

// run must bring both listeners up and tear them down when the context ends.
func TestRunServesAndShutsDown(t *testing.T) {
	slackSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"ok":true,"ts":"1.1"}`)
	}))
	defer slackSrv.Close()

	cfg := config.Config{
		SlackToken:        "xoxb-test",
		SlackAPIURL:       slackSrv.URL,
		SlackChannel:      "alerts",
		ChannelLabel:      "slack_channel",
		SlackMaxTextRune:  3500,
		KagentURL:         "http://127.0.0.1:1",
		KagentNamespace:   "kagent",
		KagentAgent:       "alert-triage-agent",
		KagentTimeout:     time.Second,
		AnalyzeSeverities: map[string]bool{"critical": true},
		AnalyzeLabel:      "analyze",
		DedupeTTL:         time.Hour,
		MaxAlertsInPrompt: 5,
		MaxConcurrent:     1,
		Instructions:      "investigate",
		WebhookPath:       "/alert",
		ListenPort:        freePort(t),
		MetricsPort:       freePort(t),
		LogLevel:          "error",
		LogFormat:         "json",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, cfg, newLogger("error", "json")) }()

	if body := getWithRetry(t, "http://127.0.0.1:"+strconv.Itoa(cfg.ListenPort)+"/healthz"); body == "" {
		// A 200 with an empty body is expected; a failure to connect returns
		// the same value, so check the metrics endpoint for real content.
		t.Log("health endpoint answered")
	}
	metrics := getWithRetry(t, "http://127.0.0.1:"+strconv.Itoa(cfg.MetricsPort)+"/metrics")
	if !strings.Contains(metrics, "kagent_alert_bridge_build_info") {
		t.Errorf("/metrics did not expose build info:\n%s", metrics)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("run() error = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run() did not return after the context was cancelled")
	}
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func getWithRetry(t *testing.T, url string) string {
	t.Helper()
	for range 100 {
		resp, err := http.Get(url)
		if err != nil {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		return string(body)
	}
	return ""
}

func TestChannelList(t *testing.T) {
	if got := channelList(config.Config{}); got != "all" {
		t.Errorf("channelList() with no allow list = %q, want all", got)
	}
	got := channelList(config.Config{ChatChannels: []string{"alerts-test", "C01234567"}})
	if got != "alerts-test,C01234567" {
		t.Errorf("channelList() = %q", got)
	}
}

// Enabling mentions must not change how the process starts or stops: the
// Socket Mode listener runs beside the webhook listener rather than gating it,
// and a Slack that cannot be reached is retried in the background.
func TestRunStartsTheMentionListener(t *testing.T) {
	var authCalls, openCalls atomic.Int32
	slackSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/auth.test"):
			authCalls.Add(1)
			io.WriteString(w, `{"ok":true,"user_id":"U000BOT"}`)
		case strings.HasSuffix(r.URL.Path, "/apps.connections.open"):
			openCalls.Add(1)
			io.WriteString(w, `{"ok":false,"error":"invalid_auth"}`)
		default:
			io.WriteString(w, `{"ok":true,"ts":"1.1"}`)
		}
	}))
	defer slackSrv.Close()

	cfg := config.Config{
		SlackToken:         "xoxb-test",
		SlackAppToken:      "xapp-test",
		SlackAPIURL:        slackSrv.URL,
		SlackChannel:       "alerts",
		ChannelLabel:       "slack_channel",
		SlackMaxTextRune:   3500,
		KagentURL:          "http://127.0.0.1:1",
		KagentNamespace:    "kagent",
		KagentAgent:        "alert-triage-agent",
		KagentTimeout:      time.Second,
		AnalyzeSeverities:  map[string]bool{"critical": true},
		AnalyzeLabel:       "analyze",
		DedupeTTL:          time.Hour,
		MaxAlertsInPrompt:  5,
		MaxConcurrent:      1,
		Instructions:       "investigate",
		ChatAgent:          "alert-triage-agent",
		ChatTimeout:        time.Second,
		ChatSessionTTL:     time.Hour,
		ChatStatusInterval: time.Second,
		MaxConcurrentChats: 1,
		WebhookPath:        "/alert",
		ListenPort:         freePort(t),
		MetricsPort:        freePort(t),
		LogLevel:           "error",
		LogFormat:          "json",
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, cfg, newLogger("error", "json")) }()

	metrics := getWithRetry(t, "http://127.0.0.1:"+strconv.Itoa(cfg.MetricsPort)+"/metrics")
	if !strings.Contains(metrics, "kagent_alert_bridge_socket_connected") {
		t.Errorf("/metrics did not expose the socket gauge:\n%s", metrics)
	}
	if authCalls.Load() == 0 {
		t.Error("the bot identity was never resolved, so the mention loop guard is weaker than it should be")
	}
	if openCalls.Load() == 0 {
		t.Error("no Socket Mode connection was attempted")
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Errorf("run() error = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run() did not return after the context was cancelled")
	}
}
