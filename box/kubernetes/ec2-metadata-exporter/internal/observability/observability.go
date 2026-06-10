// Package observability serves the Prometheus metrics and health endpoints.
package observability

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Health exposes /healthz (liveness) and /readyz (readiness) endpoints.
type Health struct {
	ready atomic.Bool
}

// NewHealth returns a Health that reports not-ready until SetReady(true).
func NewHealth() *Health {
	return &Health{}
}

// SetReady toggles the readiness state.
func (h *Health) SetReady(ready bool) {
	h.ready.Store(ready)
}

// Serve runs the health HTTP server until ctx is cancelled.
func (h *Health) Serve(ctx context.Context, port int) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if h.ready.Load() {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	return serveUntilDone(ctx, port, mux)
}

// ServeMetrics runs the /metrics HTTP server for the given registry until ctx
// is cancelled.
func ServeMetrics(ctx context.Context, port int, registry *prometheus.Registry) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{}))
	return serveUntilDone(ctx, port, mux)
}

func serveUntilDone(ctx context.Context, port int, handler http.Handler) error {
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}
