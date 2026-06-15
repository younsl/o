package meta

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestMigrateIdempotent(t *testing.T) {
	dir := t.TempDir()
	ctx := context.Background()
	s1, err := Open(ctx, filepath.Join(dir, "db.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	s1.Close()
	// Reopening applies no migrations and must not error.
	s2, err := Open(ctx, filepath.Join(dir, "db.sqlite"))
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	s2.Close()
}

func TestRepositoryCRUD(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	r, err := s.CreateRepository(ctx, Repository{
		Name: "maven-central", Format: FormatMaven, Type: TypeProxy,
		UpstreamURL: "https://repo1.maven.org/maven2",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if r.ID == 0 || r.ConfigJSON != "{}" {
		t.Fatalf("unexpected repo: %+v", r)
	}

	got, err := s.GetRepositoryByName(ctx, "maven-central")
	if err != nil || got.ID != r.ID {
		t.Fatalf("get by name: %v %+v", err, got)
	}

	if err := s.UpdateRepositoryConfig(ctx, r.ID, "https://example.com", `{"cache":{"enabled":false}}`); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, _ = s.GetRepository(ctx, r.ID)
	if got.UpstreamURL != "https://example.com" {
		t.Fatalf("upstream not updated: %s", got.UpstreamURL)
	}

	list, err := s.ListRepositories(ctx)
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v len=%d", err, len(list))
	}

	if err := s.DeleteRepository(ctx, r.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := s.GetRepository(ctx, r.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestArtifactRefCounting(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	repo, _ := s.CreateRepository(ctx, Repository{Name: "r", Format: FormatNPM, Type: TypeHosted})

	pub := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	a, err := s.PutArtifact(ctx, Artifact{
		RepoID: repo.ID, Path: "a/1.0/a-1.0.tgz", Version: "1.0",
		BlobSHA256: "blobA", Size: 10, PublishedAt: &pub,
	})
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if a.PublishedAt == nil || !a.PublishedAt.Equal(pub) {
		t.Fatalf("published_at not persisted: %+v", a.PublishedAt)
	}
	if b, _ := s.GetBlob(ctx, "blobA"); b.RefCount != 1 {
		t.Fatalf("blobA ref = %d, want 1", b.RefCount)
	}

	// Replacing the artifact's blob moves the reference.
	if _, err := s.PutArtifact(ctx, Artifact{
		RepoID: repo.ID, Path: "a/1.0/a-1.0.tgz", Version: "1.0", BlobSHA256: "blobB", Size: 12,
	}); err != nil {
		t.Fatal(err)
	}
	if b, _ := s.GetBlob(ctx, "blobA"); b.RefCount != 0 {
		t.Fatalf("blobA ref = %d, want 0", b.RefCount)
	}
	if b, _ := s.GetBlob(ctx, "blobB"); b.RefCount != 1 {
		t.Fatalf("blobB ref = %d, want 1", b.RefCount)
	}

	unref, _ := s.ListUnreferencedBlobs(ctx, 10)
	if len(unref) != 1 || unref[0] != "blobA" {
		t.Fatalf("unreferenced = %v", unref)
	}

	// Deleting the artifact releases blobB.
	if err := s.DeleteArtifact(ctx, repo.ID, "a/1.0/a-1.0.tgz"); err != nil {
		t.Fatal(err)
	}
	if b, _ := s.GetBlob(ctx, "blobB"); b.RefCount != 0 {
		t.Fatalf("blobB ref = %d, want 0", b.RefCount)
	}
}

func TestArtifactListAndEvict(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	repo, _ := s.CreateRepository(ctx, Repository{Name: "r", Format: FormatGo, Type: TypeProxy})

	for _, p := range []string{"x/v1", "x/v2", "y/v1"} {
		if _, err := s.PutArtifact(ctx, Artifact{RepoID: repo.ID, Path: p, BlobSHA256: "blob-" + p, Size: 100}); err != nil {
			t.Fatal(err)
		}
	}
	xs, err := s.ListArtifacts(ctx, repo.ID, "x/")
	if err != nil || len(xs) != 2 {
		t.Fatalf("list x/: %v len=%d", err, len(xs))
	}

	size, _ := s.RepoSize(ctx, repo.ID)
	if size != 300 {
		t.Fatalf("repo size = %d, want 300", size)
	}

	// Touch y/v1 so it is most-recently used, then evict one (the oldest).
	if err := s.Touch(ctx, repo.ID, "x/v1"); err != nil {
		t.Fatal(err)
	}
	n, err := s.EvictLRU(ctx, repo.ID, 1)
	if err != nil || n != 1 {
		t.Fatalf("evict: %v n=%d", err, n)
	}
	remaining, _ := s.ListArtifacts(ctx, repo.ID, "")
	if len(remaining) != 2 {
		t.Fatalf("after evict len=%d", len(remaining))
	}
}

func TestGetArtifactNotFound(t *testing.T) {
	s := openTestStore(t)
	if _, err := s.GetArtifact(context.Background(), 1, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestListRepoArtifactsAndCount(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	repo, _ := s.CreateRepository(ctx, Repository{Name: "r", Format: FormatNPM, Type: TypeProxy})
	for _, p := range []string{"a/1", "a/2", "b/1"} {
		if _, err := s.PutArtifact(ctx, Artifact{RepoID: repo.ID, Path: p, BlobSHA256: "b" + p, Size: 50}); err != nil {
			t.Fatal(err)
		}
	}
	all, err := s.ListRepoArtifacts(ctx, repo.ID, "", 0)
	if err != nil || len(all) != 3 {
		t.Fatalf("list all: %v len=%d", err, len(all))
	}
	as, _ := s.ListRepoArtifacts(ctx, repo.ID, "a/", 10)
	if len(as) != 2 {
		t.Fatalf("prefix a/ len=%d", len(as))
	}
	n, _ := s.CountArtifacts(ctx, repo.ID)
	if n != 3 {
		t.Fatalf("count = %d", n)
	}
}
