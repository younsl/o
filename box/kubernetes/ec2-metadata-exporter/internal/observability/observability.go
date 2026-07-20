// Package observability serves the Prometheus metrics and health endpoints.
package observability

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
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

// Serve runs the health HTTP server until ctx is cancelled. Server-internal
// errors are routed through logger so all output stays structured.
func (h *Health) Serve(ctx context.Context, port int, logger *slog.Logger) error {
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
	return serveUntilDone(ctx, port, mux, logger)
}

// RegisterBuildInfo registers the standard build_info gauge on the registry.
func RegisterBuildInfo(registry *prometheus.Registry, version, commit string) {
	buildInfo := prometheus.NewGaugeVec(prometheus.GaugeOpts{
		Name: "ec2_metadata_build_info",
		Help: "Build information. Value is always 1; labels carry the version, git commit, and Go runtime version.",
	}, []string{"version", "commit", "go_version"})
	buildInfo.WithLabelValues(version, commit, runtime.Version()).Set(1)
	registry.MustRegister(buildInfo)
}

// ServeMetrics runs the /metrics HTTP server for the given registry until ctx
// is cancelled. Handler and server-internal errors are routed through logger
// so all output stays structured.
func ServeMetrics(ctx context.Context, port int, registry *prometheus.Registry, logger *slog.Logger) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(registry, promhttp.HandlerOpts{
		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}))
	return serveUntilDone(ctx, port, mux, logger)
}

func serveUntilDone(ctx context.Context, port int, handler http.Handler, logger *slog.Logger) error {
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelError),
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
