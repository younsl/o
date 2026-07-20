package observability

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"runtime"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to find free port: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func waitForStatus(t *testing.T, url string, want int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == want {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("did not get status %d from %s in time", want, url)
}

func TestHealthEndpoints(t *testing.T) {
	port := freePort(t)
	h := NewHealth()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.Serve(ctx, port, testLogger()) }()

	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	waitForStatus(t, base+"/healthz", http.StatusOK)
	waitForStatus(t, base+"/readyz", http.StatusServiceUnavailable)

	h.SetReady(true)
	waitForStatus(t, base+"/readyz", http.StatusOK)

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Serve returned error: %v", err)
	}
}

func TestServeReturnsErrorWhenPortBusy(t *testing.T) {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatalf("failed to occupy port: %v", err)
	}
	defer l.Close()
	port := l.Addr().(*net.TCPAddr).Port

	h := NewHealth()
	if err := h.Serve(context.Background(), port, testLogger()); err == nil {
		t.Fatal("Serve on a busy port should return an error")
	}
}

func TestRegisterBuildInfo(t *testing.T) {
	registry := prometheus.NewRegistry()
	RegisterBuildInfo(registry, "1.2.3", "abc1234")

	families, err := registry.Gather()
	if err != nil {
		t.Fatalf("Gather() error = %v", err)
	}
	if len(families) != 1 || families[0].GetName() != "ec2_metadata_build_info" {
		t.Fatalf("expected only ec2_metadata_build_info, got %v", families)
	}
	metric := families[0].GetMetric()[0]
	if got := metric.GetGauge().GetValue(); got != 1 {
		t.Fatalf("build_info value = %v, want 1", got)
	}
	labels := map[string]string{}
	for _, lp := range metric.GetLabel() {
		labels[lp.GetName()] = lp.GetValue()
	}
	if labels["version"] != "1.2.3" || labels["commit"] != "abc1234" {
		t.Fatalf("build_info labels = %v, want version=1.2.3 commit=abc1234", labels)
	}
	if labels["go_version"] != runtime.Version() {
		t.Fatalf("go_version label = %q, want %q", labels["go_version"], runtime.Version())
	}
}

func TestServeMetrics(t *testing.T) {
	port := freePort(t)
	registry := prometheus.NewRegistry()
	gauge := prometheus.NewGauge(prometheus.GaugeOpts{Name: "test_metric", Help: "test"})
	registry.MustRegister(gauge)
	gauge.Set(42)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- ServeMetrics(ctx, port, registry, testLogger()) }()

	waitForStatus(t, fmt.Sprintf("http://127.0.0.1:%d/metrics", port), http.StatusOK)

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("ServeMetrics returned error: %v", err)
	}
}
