package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/conflict"
)

type fakeFetcher struct {
	snap conflict.Snapshot
	err  error
}

func (f *fakeFetcher) Fetch(context.Context) (conflict.Snapshot, error) {
	return f.snap, f.err
}

func snapshot() conflict.Snapshot {
	return conflict.Snapshot{
		RefreshedAt:          time.Unix(1700000000, 0).UTC(),
		PatternsTotal:        10,
		PatternsWithConflict: 1,
		ScannedIndices:       5,
		ScannedFields:        100,
		Result: map[string]conflict.PatternConflicts{
			"logs-a-*": {
				IndexCount: 2,
				Conflicts: map[string]conflict.TypeIndices{
					"f": {"text": {"logs-a-1"}, "long": {"logs-a-2"}},
				},
			},
		},
	}
}

func newService(f Fetcher) (*Service, *prometheus.Registry) {
	reg := prometheus.NewRegistry()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewService(f, &Store{}, NewMetrics(reg), log), reg
}

func TestRefreshUpdatesStoreAndMetrics(t *testing.T) {
	svc, reg := newService(&fakeFetcher{snap: snapshot()})
	if err := svc.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}

	snap, ready := svc.store.Get()
	if !ready || snap.PatternsWithConflict != 1 {
		t.Fatalf("store = (%+v, %v)", snap, ready)
	}

	families, err := reg.Gather()
	if err != nil {
		t.Fatalf("Gather: %v", err)
	}
	got := map[string]bool{}
	for _, mf := range families {
		got[mf.GetName()] = true
	}
	for _, name := range []string{
		"opensearch_mapping_conflict_fields",
		"opensearch_mapping_conflict_patterns",
		"opensearch_mapping_conflict_patterns_scanned_total",
		"opensearch_mapping_conflict_last_refresh_timestamp_seconds",
		"opensearch_mapping_conflict_refresh_duration_seconds",
	} {
		if !got[name] {
			t.Errorf("metric %s not gathered", name)
		}
	}
}

func TestRefreshError(t *testing.T) {
	svc, reg := newService(&fakeFetcher{err: errors.New("boom")})
	if err := svc.Refresh(context.Background()); err == nil {
		t.Fatal("expected error")
	}
	families, _ := reg.Gather()
	for _, mf := range families {
		if mf.GetName() == "opensearch_mapping_conflict_refresh_errors_total" {
			if v := mf.GetMetric()[0].GetCounter().GetValue(); v != 1 {
				t.Fatalf("refresh_errors_total = %v, want 1", v)
			}
			return
		}
	}
	t.Fatal("refresh_errors_total not gathered")
}

func TestHandlerBeforeFirstRefresh(t *testing.T) {
	svc, reg := newService(&fakeFetcher{snap: snapshot()})
	handler := svc.Handler(reg)

	for path, want := range map[string]int{
		"/":              http.StatusOK,
		"/healthz":       http.StatusOK,
		"/api/conflicts": http.StatusServiceUnavailable,
		"/readyz":        http.StatusServiceUnavailable,
	} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != want {
			t.Errorf("GET %s = %d, want %d", path, rec.Code, want)
		}
	}
}

func TestHandlerAfterRefresh(t *testing.T) {
	svc, reg := newService(&fakeFetcher{snap: snapshot()})
	if err := svc.Refresh(context.Background()); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
	handler := svc.Handler(reg)

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(rec.Body.String(), "OpenSearch Mapping Conflicts") {
		t.Error("UI does not contain the page title")
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/conflicts", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"logs-a-*"`) {
		t.Errorf("GET /api/conflicts = %d body %q", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("GET /readyz = %d, want 200", rec.Code)
	}

	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "opensearch_mapping_conflict_patterns") {
		t.Errorf("GET /metrics = %d", rec.Code)
	}
}

func TestRunRefresherStopsOnCancel(t *testing.T) {
	svc, _ := newService(&fakeFetcher{err: errors.New("boom")})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		svc.RunRefresher(ctx, time.Minute)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunRefresher did not stop on context cancel")
	}
}
