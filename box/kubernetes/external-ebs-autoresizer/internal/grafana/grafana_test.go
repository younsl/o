package grafana

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func contains(tags []string, want string) bool {
	return slices.Contains(tags, want)
}

func TestAnnotatePostsRegion(t *testing.T) {
	var gotPath, gotAuth, gotCT string
	var gotBody wireAnnotation
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotCT = r.Header.Get("Content-Type")
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, "secret-token", time.Second, []string{"event:ebs-resize"}, discardLogger())
	start := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	end := start.Add(90 * time.Second)
	c.Annotate(context.Background(), "resized vol-123", []string{"instance_id:i-123", "result:success"}, start, end)

	if gotPath != annotationsPath {
		t.Errorf("path = %q, want %q", gotPath, annotationsPath)
	}
	if gotAuth != "Bearer secret-token" {
		t.Errorf("Authorization = %q, want Bearer secret-token", gotAuth)
	}
	if gotCT != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", gotCT)
	}
	if gotBody.Text != "resized vol-123" {
		t.Errorf("text = %q", gotBody.Text)
	}
	if gotBody.Time != start.UnixMilli() {
		t.Errorf("time = %d, want %d", gotBody.Time, start.UnixMilli())
	}
	if gotBody.TimeEnd != end.UnixMilli() {
		t.Errorf("timeEnd = %d, want %d (region)", gotBody.TimeEnd, end.UnixMilli())
	}
	// baseTags must come before per-annotation tags.
	if !contains(gotBody.Tags, "event:ebs-resize") {
		t.Errorf("tags %v missing base tag event:ebs-resize", gotBody.Tags)
	}
	if !contains(gotBody.Tags, "instance_id:i-123") || !contains(gotBody.Tags, "result:success") {
		t.Errorf("tags %v missing per-annotation tags", gotBody.Tags)
	}
}

func TestAnnotatePointOmitsTimeEnd(t *testing.T) {
	var gotBody wireAnnotation
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, "", time.Second, nil, discardLogger())
	start := time.Date(2026, 6, 9, 12, 0, 0, 0, time.UTC)
	c.Annotate(context.Background(), "resize failed", []string{"result:failure"}, start, time.Time{})

	if gotBody.TimeEnd != 0 {
		t.Errorf("timeEnd = %d, want 0 (point annotation)", gotBody.TimeEnd)
	}
}

func TestAnnotateNoTokenOmitsAuthHeader(t *testing.T) {
	var hadAuth bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, hadAuth = r.Header["Authorization"]
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, "", time.Second, nil, discardLogger())
	c.Annotate(context.Background(), "x", nil, time.Unix(0, 0).UTC(), time.Time{})
	if hadAuth {
		t.Error("Authorization header sent with empty token")
	}
}

func TestAnnotateSwallowsServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := New(srv.URL, "t", time.Second, nil, discardLogger())
	// Must not panic or block; errors are logged, not returned.
	c.Annotate(context.Background(), "x", nil, time.Unix(0, 0).UTC(), time.Time{})
}

func TestNewTrimsTrailingSlash(t *testing.T) {
	c := New("http://grafana:3000/", "t", 0, nil, discardLogger())
	if c.endpoint != "http://grafana:3000"+annotationsPath {
		t.Errorf("endpoint = %q", c.endpoint)
	}
}

func TestPreflightSucceeds(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	c := New(srv.URL, "tok", time.Second, nil, discardLogger())
	endpoint, status, latency, err := c.Preflight(context.Background())
	if err != nil {
		t.Fatalf("Preflight error: %v", err)
	}
	if gotPath != healthPath {
		t.Errorf("path = %q, want %q", gotPath, healthPath)
	}
	if gotAuth != "Bearer tok" {
		t.Errorf("Authorization = %q, want Bearer tok", gotAuth)
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
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()

	c := New(srv.URL, "bad", time.Second, nil, discardLogger())
	_, status, _, err := c.Preflight(context.Background())
	if err == nil {
		t.Fatal("Preflight = nil error, want error on 401")
	}
	if status != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", status)
	}
}
