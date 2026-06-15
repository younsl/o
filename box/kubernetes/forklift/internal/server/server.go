// Package server wires the chi router, middleware, health/metrics endpoints and
// graceful shutdown. Package protocol handlers and the admin API are mounted by
// the caller.
package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/younsl/o/box/kubernetes/forklift/internal/config"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// Server holds HTTP server state.
type Server struct {
	cfg    *config.Config
	log    *slog.Logger
	store  *meta.Store
	router *chi.Mux

	// ready reflects whether this instance should receive traffic. In HA mode it
	// is toggled by leader election; otherwise it is set true at startup.
	ready atomic.Bool

	reqDuration *prometheus.HistogramVec
	reqTotal    *prometheus.CounterVec
}

// New creates a Server with health, metrics and middleware configured. Mount
// additional routes via Router before calling Run.
func New(cfg *config.Config, log *slog.Logger, store *meta.Store, reg *prometheus.Registry) *Server {
	s := &Server{
		cfg:    cfg,
		log:    log,
		store:  store,
		router: chi.NewRouter(),
		reqDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: "forklift",
			Name:      "http_request_duration_seconds",
			Help:      "HTTP request latency.",
			Buckets:   prometheus.DefBuckets,
		}, []string{"method", "route", "status"}),
		reqTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift",
			Name:      "http_requests_total",
			Help:      "Total HTTP requests.",
		}, []string{"method", "route", "status"}),
	}
	reg.MustRegister(s.reqDuration, s.reqTotal)

	s.router.Use(s.recoverer)
	s.router.Use(s.logRequests)
	s.router.Get("/healthz", s.handleHealthz)
	s.router.Get("/readyz", s.handleReadyz)
	return s
}

// Router exposes the mux so callers can mount routes before Run.
func (s *Server) Router() *chi.Mux { return s.router }

// SetReady toggles readiness (used by leader election).
func (s *Server) SetReady(ready bool) { s.ready.Store(ready) }

// Run starts the main and metrics listeners and blocks until ctx is cancelled,
// then shuts down gracefully.
func (s *Server) Run(ctx context.Context, reg *prometheus.Registry) error {
	main := &http.Server{
		Addr:              s.cfg.HTTPAddr,
		Handler:           s.router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	metricsMux := http.NewServeMux()
	metricsMux.Handle("/metrics", promhttp.HandlerFor(reg, promhttp.HandlerOpts{}))
	metrics := &http.Server{
		Addr:              s.cfg.MetricsAddr,
		Handler:           metricsMux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 2)
	go func() {
		s.log.Info("http listening", "addr", s.cfg.HTTPAddr)
		if err := main.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	go func() {
		s.log.Info("metrics listening", "addr", s.cfg.MetricsAddr)
		if err := metrics.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case <-ctx.Done():
		s.log.Info("shutting down")
	case err := <-errCh:
		s.log.Error("server error", "err", err)
		return err
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), s.cfg.ShutdownTimeout)
	defer cancel()
	_ = metrics.Shutdown(shutdownCtx)
	return main.Shutdown(shutdownCtx)
}
