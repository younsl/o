package meta

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func newAuditStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "audit.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestAuditLogInsertListCount(t *testing.T) {
	s := newAuditStore(t)
	ctx := context.Background()

	entries := []AuditLog{
		{RepoName: "maven-central", Event: EventDownload, Path: "com/acme/app/1.0/app-1.0.jar",
			Username: "alice", Method: "GET", Status: 200, ClientIP: "10.0.0.1", UserAgent: "maven"},
		{RepoName: "maven-central", Event: EventDownload, Path: "com/acme/app/2.0/app-2.0.jar",
			Status: 404},
		{RepoName: "maven-central", Event: EventUpload, Path: "com/acme/app/3.0/app-3.0.jar",
			Username: "bob", Method: "PUT", Status: 201},
		{RepoName: "npm-proxy", Event: EventDownload, Path: "react/-/react-18.0.0.tgz", Status: 200},
	}
	for _, e := range entries {
		if err := s.InsertAuditLog(ctx, e); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}

	logs, err := s.ListAuditLogs(ctx, "maven-central", "", 100, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(logs) != 3 {
		t.Fatalf("len = %d, want 3", len(logs))
	}
	// Newest first.
	if logs[0].Event != EventUpload || logs[0].Username != "bob" {
		t.Fatalf("first log = %+v, want newest upload by bob", logs[0])
	}
	if logs[2].ClientIP != "10.0.0.1" || logs[2].UserAgent != "maven" {
		t.Fatalf("oldest log fields = %+v", logs[2])
	}
	if logs[0].CreatedAt.IsZero() {
		t.Fatal("created_at not set")
	}

	// Event filter.
	logs, err = s.ListAuditLogs(ctx, "maven-central", EventDownload, 100, 0)
	if err != nil {
		t.Fatalf("list filtered: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("filtered len = %d, want 2", len(logs))
	}

	// Pagination.
	logs, err = s.ListAuditLogs(ctx, "maven-central", "", 1, 1)
	if err != nil {
		t.Fatalf("list paginated: %v", err)
	}
	if len(logs) != 1 || logs[0].Status != 404 {
		t.Fatalf("paginated = %+v", logs)
	}

	n, err := s.CountAuditLogs(ctx, "maven-central", "")
	if err != nil || n != 3 {
		t.Fatalf("count = %d err=%v, want 3", n, err)
	}
	n, err = s.CountAuditLogs(ctx, "maven-central", EventUpload)
	if err != nil || n != 1 {
		t.Fatalf("count uploads = %d err=%v, want 1", n, err)
	}
}

func TestAuditLogPrune(t *testing.T) {
	s := newAuditStore(t)
	ctx := context.Background()

	old := time.Now().Add(-48 * time.Hour)
	if err := s.InsertAuditLog(ctx, AuditLog{RepoName: "r", Event: EventDownload, CreatedAt: old}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertAuditLog(ctx, AuditLog{RepoName: "r", Event: EventDownload}); err != nil {
		t.Fatal(err)
	}

	n, err := s.PruneAuditLogs(ctx, time.Now().Add(-24*time.Hour))
	if err != nil {
		t.Fatalf("prune: %v", err)
	}
	if n != 1 {
		t.Fatalf("pruned = %d, want 1", n)
	}
	left, err := s.CountAuditLogs(ctx, "r", "")
	if err != nil || left != 1 {
		t.Fatalf("remaining = %d err=%v, want 1", left, err)
	}
}
