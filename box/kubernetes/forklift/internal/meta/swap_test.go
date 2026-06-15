package meta

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSnapshotAndSwap(t *testing.T) {
	ctx := context.Background()

	leader := openTestStore(t)
	if _, err := leader.CreateRepository(ctx, Repository{
		Name: "snap-repo", Format: FormatGo, Type: TypeProxy, UpstreamURL: "https://proxy.golang.org",
	}); err != nil {
		t.Fatal(err)
	}
	snapshot := filepath.Join(t.TempDir(), "snapshot.db")
	if err := leader.Snapshot(ctx, snapshot); err != nil {
		t.Fatalf("snapshot: %v", err)
	}

	// Snapshot must overwrite a stale destination file.
	if err := leader.Snapshot(ctx, snapshot); err != nil {
		t.Fatalf("re-snapshot: %v", err)
	}

	standby := openTestStore(t)
	if _, err := standby.CreateRepository(ctx, Repository{
		Name: "standby-only", Format: FormatNPM, Type: TypeHosted,
	}); err != nil {
		t.Fatal(err)
	}
	if err := standby.SwapFromSnapshot(ctx, snapshot); err != nil {
		t.Fatalf("swap: %v", err)
	}

	// The snapshot's data replaces the standby's local data on the same handle.
	if _, err := standby.GetRepositoryByName(ctx, "snap-repo"); err != nil {
		t.Fatalf("snapshot repo not visible after swap: %v", err)
	}
	if _, err := standby.GetRepositoryByName(ctx, "standby-only"); err == nil {
		t.Fatal("pre-swap local repo should be gone")
	}
	// The snapshot file is consumed by the rename.
	if _, err := os.Stat(snapshot); !os.IsNotExist(err) {
		t.Fatal("snapshot file should be moved into place")
	}
	// Writes keep working after the swap.
	if _, err := standby.CreateRepository(ctx, Repository{
		Name: "post-swap", Format: FormatCargo, Type: TypeHosted,
	}); err != nil {
		t.Fatalf("write after swap: %v", err)
	}
}

func TestListBlobDigests(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	for i := range 5 {
		sha := fmt.Sprintf("%064d", i)
		if _, err := s.DB().ExecContext(ctx,
			`INSERT INTO blobs(sha256, size, ref_count, created_at) VALUES(?, 1, 1, ?)`,
			sha, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
			t.Fatal(err)
		}
	}

	page1, err := s.ListBlobDigests(ctx, "", 3)
	if err != nil || len(page1) != 3 {
		t.Fatalf("page1 = %v, err %v", page1, err)
	}
	page2, err := s.ListBlobDigests(ctx, page1[len(page1)-1], 3)
	if err != nil || len(page2) != 2 {
		t.Fatalf("page2 = %v, err %v", page2, err)
	}
	all := append(page1, page2...)
	for i := 1; i < len(all); i++ {
		if all[i-1] >= all[i] {
			t.Fatalf("not strictly ordered: %v", all)
		}
	}
}
