package repo

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

func TestReapOnce(t *testing.T) {
	m, eng, store := newTestManager(t)
	ctx := context.Background()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	rec := audit.NewRecorder(store, log, prometheus.NewRegistry())
	m.rec = rec

	// Fixed clock so idleness is deterministic.
	base := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	eng.now = func() time.Time { return base }

	// Repo with a 1h idle TTL.
	ttlCfg := repoconfig.Default()
	ttlCfg.Retention.IdleTTL = repoconfig.Duration(time.Hour)
	gated := mkRepo(t, store, "gated", meta.TypeHosted, "", ttlCfg)
	// Repo with retention disabled (idle_ttl = 0): nothing is reaped.
	off := mkRepo(t, store, "off", meta.TypeHosted, "", repoconfig.Default())

	put := func(repoID int64, path, version string, lastAccessed time.Time) {
		t.Helper()
		if _, err := store.PutArtifact(ctx, meta.Artifact{
			RepoID: repoID, Path: path, Version: version, BlobSHA256: path, Size: 4,
			CachedAt: lastAccessed, LastAccessedAt: lastAccessed,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// In the gated repo: one idle (served 2h ago) and one fresh (served now).
	put(gated.ID, "old/-/old-0.1.0.tgz", "0.1.0", base.Add(-2*time.Hour))
	put(gated.ID, "fresh/-/fresh-2.0.0.tgz", "2.0.0", base)
	// In the disabled repo: an idle artifact that must survive.
	put(off.ID, "keep/-/keep-1.0.0.tgz", "1.0.0", base.Add(-72*time.Hour))

	n, err := m.reapOnce(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("reaped %d, want 1 (only the idle artifact in the gated repo)", n)
	}

	if c, _ := store.CountArtifacts(ctx, gated.ID); c != 1 {
		t.Fatalf("gated repo count = %d, want 1 (fresh survives)", c)
	}
	if _, err := store.GetArtifact(ctx, gated.ID, "fresh/-/fresh-2.0.0.tgz"); err != nil {
		t.Fatalf("fresh artifact removed: %v", err)
	}
	if c, _ := store.CountArtifacts(ctx, off.ID); c != 1 {
		t.Fatalf("disabled repo count = %d, want 1 (retention off)", c)
	}

	rec.Close() // flush buffered audit events
	logs, err := store.ListAuditLogs(ctx, "gated", meta.EventTTLExpire, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 {
		t.Fatalf("ttl.expire audit entries = %d, want 1", len(logs))
	}
	if logs[0].Path != "old/-/old-0.1.0.tgz" || logs[0].Username != "system" {
		t.Fatalf("audit entry = %+v", logs[0])
	}
}
