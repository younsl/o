package alertmanager

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestNotifyPostsV2Alert(t *testing.T) {
	var gotPath string
	var gotBody []wireAlert
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		if ct := r.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", ct)
		}
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, time.Second, map[string]string{"cluster": "prod"}, discardLogger())
	start := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	c.Notify(context.Background(), "warning", "EBSRootVolumeAutoresizeFailed", "boom", "instance i-123 failed",
		map[string]string{"instance_id": "i-123", "cluster": "override"}, start)

	if gotPath != alertsPath {
		t.Errorf("path = %q, want %q", gotPath, alertsPath)
	}
	if len(gotBody) != 1 {
		t.Fatalf("got %d alerts, want 1", len(gotBody))
	}
	a := gotBody[0]
	if a.Labels["alertname"] != "EBSRootVolumeAutoresizeFailed" {
		t.Errorf("alertname = %q", a.Labels["alertname"])
	}
	if a.Labels["severity"] != "warning" {
		t.Errorf("severity = %q", a.Labels["severity"])
	}
	if a.Labels["instance_id"] != "i-123" {
		t.Errorf("instance_id = %q", a.Labels["instance_id"])
	}
	// Per-alert labels override the client's static extraLabels.
	if a.Labels["cluster"] != "override" {
		t.Errorf("cluster = %q, want override", a.Labels["cluster"])
	}
	if a.Annotations["summary"] != "boom" {
		t.Errorf("summary = %q", a.Annotations["summary"])
	}
	if a.Annotations["description"] != "instance i-123 failed" {
		t.Errorf("description = %q", a.Annotations["description"])
	}
	if a.StartsAt != "2026-06-09T12:00:00Z" {
		t.Errorf("startsAt = %q", a.StartsAt)
	}
}

func TestNotifySwallowsServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := New(srv.URL, time.Second, nil, discardLogger())
	// Must not panic or block; errors are logged, not returned.
	c.Notify(context.Background(), "info", "EBSRootVolumeAutoresizeCompleted", "ok", "", nil, time.Unix(0, 0).UTC())
}

func TestNewTrimsTrailingSlash(t *testing.T) {
	c := New("http://alertmanager:9093/", 0, nil, discardLogger())
	if c.endpoint != "http://alertmanager:9093"+alertsPath {
		t.Errorf("endpoint = %q", c.endpoint)
	}
}

func TestPreflightSucceeds(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, time.Second, nil, discardLogger())
	endpoint, status, latency, err := c.Preflight(context.Background())
	if err != nil {
		t.Fatalf("Preflight error: %v", err)
	}
	if gotPath != healthPath {
		t.Errorf("path = %q, want %q", gotPath, healthPath)
	}
	if status != http.StatusOK {
		t.Errorf("status = %d, want 200", status)
	}
	if endpoint != srv.URL+healthPath {
		t.Errorf("endpoint = %q", endpoint)
	}
	if latency <= 0 {
		t.Errorf("latency = %v, want > 0", latency)
	}
}

func TestPreflightNon2xxReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	c := New(srv.URL, time.Second, nil, discardLogger())
	_, status, _, err := c.Preflight(context.Background())
	if err == nil {
		t.Fatal("Preflight = nil error, want error on 503")
	}
	if status != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", status)
	}
}
