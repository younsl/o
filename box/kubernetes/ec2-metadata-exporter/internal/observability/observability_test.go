package observability

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
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
	go func() { done <- h.Serve(ctx, port) }()

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

func TestServeMetrics(t *testing.T) {
	port := freePort(t)
	registry := prometheus.NewRegistry()
	gauge := prometheus.NewGauge(prometheus.GaugeOpts{Name: "test_metric", Help: "test"})
	registry.MustRegister(gauge)
	gauge.Set(42)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- ServeMetrics(ctx, port, registry) }()

	waitForStatus(t, fmt.Sprintf("http://127.0.0.1:%d/metrics", port), http.StatusOK)

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("ServeMetrics returned error: %v", err)
	}
}
