package meta

import (
	"context"
	"testing"
	"time"
)

func TestVulnScanStore(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	// Missing coordinate -> ErrNotFound.
	if _, err := s.GetVulnScan(ctx, "npm", "lodash", "1.0.0"); err != ErrNotFound {
		t.Fatalf("missing scan err = %v, want ErrNotFound", err)
	}

	// Upsert + round-trip (ids survive JSON encoding).
	if err := s.UpsertVulnScan(ctx, "npm", "lodash", "1.0.0", "high", []string{"CVE-1", "GHSA-2"}); err != nil {
		t.Fatal(err)
	}
	got, err := s.GetVulnScan(ctx, "npm", "lodash", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if got.MaxSeverity != "high" || len(got.VulnIDs) != 2 || got.VulnIDs[0] != "CVE-1" {
		t.Fatalf("round-trip = %+v", got)
	}

	// Upsert again refreshes severity/ids in place (no duplicate row).
	if err := s.UpsertVulnScan(ctx, "npm", "lodash", "1.0.0", "critical", []string{"CVE-1"}); err != nil {
		t.Fatal(err)
	}
	got, _ = s.GetVulnScan(ctx, "npm", "lodash", "1.0.0")
	if got.MaxSeverity != "critical" || len(got.VulnIDs) != 1 {
		t.Fatalf("after refresh = %+v", got)
	}

	// Stale listing: a far-future cutoff returns the row; a past cutoff does not.
	stale, err := s.ListStaleVulnScans(ctx, time.Now().Add(time.Hour), 10)
	if err != nil || len(stale) != 1 {
		t.Fatalf("stale (future cutoff) = %d err=%v", len(stale), err)
	}
	old, err := s.ListStaleVulnScans(ctx, time.Now().Add(-time.Hour), 10)
	if err != nil || len(old) != 0 {
		t.Fatalf("stale (past cutoff) = %d err=%v", len(old), err)
	}
}
