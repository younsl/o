package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/config"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

func newTestServer(t *testing.T) (*Server, *prometheus.Registry) {
	t.Helper()
	store, err := meta.Open(context.Background(), filepath.Join(t.TempDir(), "srv.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	cfg := &config.Config{
		HTTPAddr: "127.0.0.1:0", MetricsAddr: "127.0.0.1:0",
		ShutdownTimeout: time.Second,
	}
	reg := prometheus.NewRegistry()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return New(cfg, log, store, reg), reg
}

func TestHealthz(t *testing.T) {
	s, _ := newTestServer(t)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz = %d", rec.Code)
	}
}

func TestReadyzReflectsLeadership(t *testing.T) {
	s, _ := newTestServer(t)

	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("readyz before leadership = %d, want 503", rec.Code)
	}

	s.SetReady(true)
	rec = httptest.NewRecorder()
	s.Router().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("readyz after leadership = %d, want 200", rec.Code)
	}
}

func TestRecovererAndMetrics(t *testing.T) {
	s, _ := newTestServer(t)
	s.Router().Get("/boom", func(http.ResponseWriter, *http.Request) {
		panic("kaboom")
	})
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/boom", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("panic route = %d, want 500", rec.Code)
	}
}

func TestRunShutsDownOnContextCancel(t *testing.T) {
	s, reg := newTestServer(t)
	s.SetReady(true)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() { done <- s.Run(ctx, reg) }()

	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned error: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not shut down in time")
	}
}
