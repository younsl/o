package observability

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestMetricsExposesSeries(t *testing.T) {
	m := NewMetrics()
	m.RegisterBuildInfo("1.2.3", "abc123")
	m.WebhooksReceived.WithLabelValues("analyzing").Inc()
	m.SlackMessages.WithLabelValues("parent", "ok").Inc()
	m.Analyses.WithLabelValues("alert-triage-agent", "ok").Inc()
	m.AnalysesSkipped.WithLabelValues("deduplicated").Inc()
	m.AnalysisDuration.Observe(12)
	m.AnalysesInflight.Set(1)
	m.WebhookDuration.Observe(0.02)
	m.AlertsReceived.WithLabelValues("critical", "firing").Inc()
	m.SlackTruncations.WithLabelValues("thread").Inc()
	m.ParentLookupTries.Observe(2)
	m.AnalysisQueueWait.Observe(3)
	m.AnalysesQueued.Set(2)
	m.AnalysisSlots.Set(4)
	m.DedupeEntries.Set(7)
	m.ObserveSlackRequest("conversations.history", "rate_limited", 250*time.Millisecond)
	m.ObserveAgentRequest("tasks/get", "ok", 100*time.Millisecond)
	m.ObserveAgentTask("alert-triage-agent", "completed", 6, 42*time.Second)

	body := scrape(t, m)
	for _, want := range []string{
		`kagent_alert_bridge_build_info{commit="abc123"`,
		`version="1.2.3"`,
		`kagent_alert_bridge_webhooks_received_total{result="analyzing"} 1`,
		`kagent_alert_bridge_webhook_duration_seconds_count 1`,
		`kagent_alert_bridge_alerts_received_total{severity="critical",status="firing"} 1`,
		`kagent_alert_bridge_slack_messages_total{kind="parent",result="ok"} 1`,
		`kagent_alert_bridge_slack_messages_truncated_total{kind="thread"} 1`,
		`kagent_alert_bridge_slack_api_requests_total{method="conversations.history",result="rate_limited"} 1`,
		`kagent_alert_bridge_slack_api_request_duration_seconds_count{method="conversations.history"} 1`,
		`kagent_alert_bridge_parent_lookup_attempts_count 1`,
		`kagent_alert_bridge_analyses_total{agent="alert-triage-agent",result="ok"} 1`,
		`kagent_alert_bridge_analyses_skipped_total{reason="deduplicated"} 1`,
		`kagent_alert_bridge_analysis_duration_seconds_count 1`,
		`kagent_alert_bridge_analysis_queue_wait_seconds_count 1`,
		`kagent_alert_bridge_analyses_inflight 1`,
		`kagent_alert_bridge_analyses_queued 2`,
		`kagent_alert_bridge_analysis_slots 4`,
		`kagent_alert_bridge_dedupe_entries 7`,
		`kagent_alert_bridge_agent_requests_total{method="tasks/get",result="ok"} 1`,
		`kagent_alert_bridge_agent_request_duration_seconds_count{method="tasks/get"} 1`,
		`kagent_alert_bridge_agent_task_duration_seconds_sum{agent="alert-triage-agent",state="completed"} 42`,
		`kagent_alert_bridge_agent_task_duration_seconds_count{agent="alert-triage-agent",state="completed"} 1`,
		`kagent_alert_bridge_agent_task_polls_sum 6`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("/metrics missing %q", want)
		}
	}
	// The Go and process collectors come from the same registry, so their
	// absence would mean the runtime is invisible in Prometheus.
	if !strings.Contains(body, "go_goroutines") {
		t.Error("/metrics missing the Go collector series")
	}
}

// The Slack and A2A clients accept a nil metric set, which every recording
// helper has to survive: a panic here would take down a client that only wanted
// the transport.
func TestObserveHelpersAcceptNilMetrics(t *testing.T) {
	var m *Metrics
	m.ObserveSlackRequest("chat.postMessage", "ok", time.Second)
	m.ObserveAgentRequest("message/send", "error", time.Second)
	m.ObserveAgentTask("alert-triage-agent", "failed", 3, time.Second)
}

func scrape(t *testing.T, m *Metrics) string {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	port := freePort(t)
	go func() {
		if err := ServeMetrics(ctx, port, m.Registry(), testLogger()); err != nil {
			t.Errorf("ServeMetrics() error = %v", err)
		}
	}()

	body, err := getWithRetry(t, "http://127.0.0.1:"+strconv.Itoa(port)+"/metrics")
	if err != nil {
		t.Fatalf("scrape failed: %v", err)
	}
	return body
}

func TestHealthHandler(t *testing.T) {
	handler := Health{}.Handler()

	for _, path := range []string{"/healthz", "/readyz"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, rec.Code)
		}
	}
}

func TestServeShutsDownWithContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	port := freePort(t)
	errCh := make(chan error, 1)
	go func() { errCh <- Serve(ctx, port, Health{}.Handler(), testLogger()) }()

	if _, err := getWithRetry(t, "http://127.0.0.1:"+strconv.Itoa(port)+"/healthz"); err != nil {
		t.Fatalf("server never came up: %v", err)
	}
	cancel()

	select {
	case err := <-errCh:
		if err != nil {
			t.Errorf("Serve() error = %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Serve() did not return after the context was cancelled")
	}
}

// A port already in use must surface as an error instead of a silent no-op.
func TestServeReportsListenError(t *testing.T) {
	// Serve binds every interface, so the conflicting listener has to as well:
	// on macOS a wildcard bind succeeds while 127.0.0.1 alone is held.
	ln, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := Serve(ctx, port, Health{}.Handler(), testLogger()); err == nil {
		t.Fatal("expected an error when the port is taken")
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

func getWithRetry(t *testing.T, url string) (string, error) {
	t.Helper()
	var lastErr error
	for range 50 {
		resp, err := http.Get(url)
		if err != nil {
			lastErr = err
			time.Sleep(20 * time.Millisecond)
			continue
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		return string(body), err
	}
	return "", lastErr
}
