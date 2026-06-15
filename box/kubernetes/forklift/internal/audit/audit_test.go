package audit

import (
	"context"
	"io"
	"log/slog"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

func newRecorder(t *testing.T) (*Recorder, *meta.Store) {
	t.Helper()
	store, err := meta.Open(context.Background(), filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	return NewRecorder(store, log, prometheus.NewRegistry()), store
}

func TestRecorderFlushesOnClose(t *testing.T) {
	rec, store := newRecorder(t)

	rec.Record(Event{Repo: "maven-central", Action: meta.EventDownload, Path: "a.jar",
		Username: "alice", Method: "GET", Status: 200, ClientIP: "10.0.0.1", UserAgent: "maven"})
	rec.Record(Event{Repo: "maven-central", Action: meta.EventUpload, Path: "b.jar", Status: 201})
	rec.Close()

	logs, err := store.ListAuditLogs(context.Background(), "maven-central", "", 10, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("len = %d, want 2", len(logs))
	}
	if logs[1].Username != "alice" || logs[1].ClientIP != "10.0.0.1" {
		t.Fatalf("oldest = %+v", logs[1])
	}
}

func TestNilRecorderIsNoop(t *testing.T) {
	var rec *Recorder
	rec.Record(Event{Repo: "r", Action: meta.EventDownload}) // must not panic
	rec.Close()
	rec.RunRetention(context.Background(), time.Hour, time.Hour)
}

func TestPruneOnce(t *testing.T) {
	rec, store := newRecorder(t)
	ctx := context.Background()

	old := time.Now().Add(-48 * time.Hour)
	if err := store.InsertAuditLog(ctx, meta.AuditLog{RepoName: "r", Event: meta.EventDownload, CreatedAt: old}); err != nil {
		t.Fatal(err)
	}
	rec.Record(Event{Repo: "r", Action: meta.EventDownload})
	rec.Close()

	rec.pruneOnce(ctx, 24*time.Hour)
	n, err := store.CountAuditLogs(ctx, "r", "")
	if err != nil || n != 1 {
		t.Fatalf("remaining = %d err=%v, want 1", n, err)
	}
}

func TestRunRetentionStopsOnCancel(t *testing.T) {
	rec, _ := newRecorder(t)
	defer rec.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		rec.RunRetention(ctx, time.Hour, 24*time.Hour)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunRetention did not stop on cancel")
	}
}

func TestClientIP(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "192.0.2.10:54321"
	if got := ClientIP(r); got != "192.0.2.10" {
		t.Fatalf("remote addr ip = %q", got)
	}

	r.Header.Set("X-Forwarded-For", "203.0.113.5, 192.0.2.10")
	if got := ClientIP(r); got != "203.0.113.5" {
		t.Fatalf("xff ip = %q", got)
	}

	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	if got := ClientIP(r); got != "203.0.113.9" {
		t.Fatalf("single xff ip = %q", got)
	}

	r.Header.Del("X-Forwarded-For")
	r.RemoteAddr = "bad-addr"
	if got := ClientIP(r); got != "bad-addr" {
		t.Fatalf("fallback ip = %q", got)
	}
}
