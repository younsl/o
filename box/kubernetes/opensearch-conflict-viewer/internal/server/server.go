// Package server exposes the aggregated conflict snapshot over HTTP: an
// embedded web UI, a JSON API, Prometheus metrics, and health probes.
package server

import (
	"context"
	_ "embed"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/conflict"
)

//go:embed ui.html
var uiHTML []byte

// Fetcher produces a fresh conflict snapshot from the backing OpenSearch.
type Fetcher interface {
	Fetch(ctx context.Context) (conflict.Snapshot, error)
}

// Metrics holds every Prometheus series the viewer publishes.
type Metrics struct {
	ConflictFields       *prometheus.GaugeVec
	ConflictPatterns     prometheus.Gauge
	PatternsTotal        prometheus.Gauge
	LastRefreshTimestamp prometheus.Gauge
	RefreshDuration      prometheus.Gauge
	RefreshErrors        prometheus.Counter
}

// NewMetrics registers the viewer metrics on the given registry.
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{
		ConflictFields: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "opensearch_mapping_conflict_fields",
			Help: "Number of fields with conflicting mapping types per index pattern.",
		}, []string{"index_pattern"}),
		ConflictPatterns: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "opensearch_mapping_conflict_patterns",
			Help: "Number of index patterns with at least one mapping conflict.",
		}),
		PatternsTotal: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "opensearch_mapping_conflict_patterns_scanned_total",
			Help: "Number of index patterns scanned in the last refresh.",
		}),
		LastRefreshTimestamp: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "opensearch_mapping_conflict_last_refresh_timestamp_seconds",
			Help: "Unix timestamp of the last successful refresh.",
		}),
		RefreshDuration: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "opensearch_mapping_conflict_refresh_duration_seconds",
			Help: "Duration of the last successful refresh.",
		}),
		RefreshErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "opensearch_mapping_conflict_refresh_errors_total",
			Help: "Total number of failed refresh attempts.",
		}),
	}
	reg.MustRegister(m.ConflictFields, m.ConflictPatterns, m.PatternsTotal,
		m.LastRefreshTimestamp, m.RefreshDuration, m.RefreshErrors)
	return m
}

// Store keeps the latest snapshot behind a mutex.
type Store struct {
	mu       sync.RWMutex
	snapshot conflict.Snapshot
	ready    bool
}

// Set replaces the latest snapshot.
func (s *Store) Set(snap conflict.Snapshot) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot = snap
	s.ready = true
}

// Get returns the latest snapshot and whether one exists yet.
func (s *Store) Get() (conflict.Snapshot, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.snapshot, s.ready
}

// Service wires the fetcher, store, and metrics together.
type Service struct {
	fetcher Fetcher
	store   *Store
	metrics *Metrics
	log     *slog.Logger
}

// NewService builds a Service.
func NewService(fetcher Fetcher, store *Store, metrics *Metrics, log *slog.Logger) *Service {
	return &Service{fetcher: fetcher, store: store, metrics: metrics, log: log}
}

// Refresh fetches one snapshot, stores it, and updates metrics.
func (s *Service) Refresh(ctx context.Context) error {
	start := time.Now()
	snap, err := s.fetcher.Fetch(ctx)
	if err != nil {
		s.metrics.RefreshErrors.Inc()
		return err
	}

	s.store.Set(snap)
	s.metrics.ConflictFields.Reset()
	for pattern, pc := range snap.Result {
		s.metrics.ConflictFields.WithLabelValues(pattern).Set(float64(len(pc.Conflicts)))
	}
	s.metrics.ConflictPatterns.Set(float64(snap.PatternsWithConflict))
	s.metrics.PatternsTotal.Set(float64(snap.PatternsTotal))
	s.metrics.LastRefreshTimestamp.Set(float64(snap.RefreshedAt.Unix()))
	s.metrics.RefreshDuration.Set(time.Since(start).Seconds())

	s.log.Info("snapshot refreshed",
		"patterns_total", snap.PatternsTotal,
		"patterns_with_conflicts", snap.PatternsWithConflict,
		"scanned_indices", snap.ScannedIndices,
		"scanned_fields", snap.ScannedFields,
		"duration", time.Since(start).Round(time.Millisecond).String(),
	)
	return nil
}

// RunRefresher refreshes immediately and then on every tick until ctx ends.
func (s *Service) RunRefresher(ctx context.Context, interval time.Duration) {
	if err := s.Refresh(ctx); err != nil {
		s.log.Error("initial refresh failed", "error", err)
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.Refresh(ctx); err != nil {
				s.log.Error("refresh failed", "error", err)
			}
		}
	}
}

// Handler returns the HTTP mux serving the UI, API, metrics, and probes.
func (s *Service) Handler(gatherer prometheus.Gatherer) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(uiHTML)
	})

	mux.HandleFunc("GET /api/conflicts", func(w http.ResponseWriter, _ *http.Request) {
		snap, ready := s.store.Get()
		if !ready {
			http.Error(w, `{"error":"snapshot not ready yet"}`, http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(snap)
	})

	mux.Handle("GET /metrics", promhttp.HandlerFor(gatherer, promhttp.HandlerOpts{}))

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("ok"))
	})

	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		if _, ready := s.store.Get(); !ready {
			http.Error(w, "snapshot not ready yet", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})

	return mux
}
