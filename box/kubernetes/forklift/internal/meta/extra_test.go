package meta

import (
	"context"
	"errors"
	"testing"
)

func TestRolePermissionQueries(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	u, err := s.CreateUser(ctx, User{Username: "dev"})
	if err != nil {
		t.Fatal(err)
	}
	r1, err := s.CreateRole(ctx, Role{Name: "readers"})
	if err != nil {
		t.Fatal(err)
	}
	r2, err := s.CreateRole(ctx, Role{Name: "writers"})
	if err != nil {
		t.Fatal(err)
	}
	p1, err := s.AddPermission(ctx, Permission{RoleID: r1.ID, RepoPattern: "*", Actions: "read"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPermission(ctx, Permission{RoleID: r2.ID, RepoPattern: "maven-*", Actions: "write"}); err != nil {
		t.Fatal(err)
	}
	if err := s.AssignRole(ctx, u.ID, r1.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.AssignRole(ctx, u.ID, r2.ID); err != nil {
		t.Fatal(err)
	}

	// ListPermissions returns every permission across roles.
	perms, err := s.ListPermissions(ctx)
	if err != nil || len(perms) != 2 {
		t.Fatalf("list permissions = %d err=%v, want 2", len(perms), err)
	}

	// RolesByUser maps the user to both roles, ordered by name.
	byUser, err := s.RolesByUser(ctx)
	if err != nil {
		t.Fatal(err)
	}
	roles := byUser[u.ID]
	if len(roles) != 2 || roles[0].Name != "readers" || roles[1].Name != "writers" {
		t.Fatalf("roles for user = %+v", roles)
	}

	// DeletePermission is scoped to its role: a wrong role ID must not delete.
	if err := s.DeletePermission(ctx, r2.ID, p1.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-role delete err = %v, want ErrNotFound", err)
	}
	if err := s.DeletePermission(ctx, r1.ID, p1.ID); err != nil {
		t.Fatal(err)
	}
	perms, _ = s.ListPermissions(ctx)
	if len(perms) != 1 {
		t.Fatalf("after delete = %d, want 1", len(perms))
	}
}

func TestBlobRecordLifecycle(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	repo, err := s.CreateRepository(ctx, Repository{Name: "r", Format: FormatMaven, Type: TypeHosted})
	if err != nil {
		t.Fatal(err)
	}
	art, err := s.PutArtifact(ctx, Artifact{
		RepoID: repo.ID, Path: "a/b.jar", BlobSHA256: "deadbeef", Size: 4,
	})
	if err != nil {
		t.Fatal(err)
	}

	// Referenced blobs are not deletable candidates.
	if shas, _ := s.ListUnreferencedBlobs(ctx, 10); len(shas) != 0 {
		t.Fatalf("unreferenced = %v, want none", shas)
	}

	// Deleting the repo unreferences the blob; the record can then be removed.
	if err := s.DeleteRepository(ctx, repo.ID); err != nil {
		t.Fatal(err)
	}
	shas, err := s.ListUnreferencedBlobs(ctx, 10)
	if err != nil || len(shas) != 1 || shas[0] != art.BlobSHA256 {
		t.Fatalf("unreferenced = %v err=%v", shas, err)
	}
	if err := s.DeleteBlobRecord(ctx, art.BlobSHA256); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetBlob(ctx, art.BlobSHA256); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get after delete err = %v, want ErrNotFound", err)
	}
	// Deleting an already-removed record is a sweeper-friendly no-op.
	if err := s.DeleteBlobRecord(ctx, art.BlobSHA256); err != nil {
		t.Fatalf("double delete err = %v, want nil", err)
	}
}

func TestStoreAccessors(t *testing.T) {
	s := openTestStore(t)
	if err := s.Ping(context.Background()); err != nil {
		t.Fatalf("ping: %v", err)
	}
	if s.Path() == "" {
		t.Fatal("path empty")
	}
	if s.DB() == nil {
		t.Fatal("db handle nil")
	}
}

func TestAllRepoStats(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	r1, err := s.CreateRepository(ctx, Repository{Name: "stats-a", Format: FormatMaven, Type: TypeHosted})
	if err != nil {
		t.Fatal(err)
	}
	r2, err := s.CreateRepository(ctx, Repository{Name: "stats-b", Format: FormatNPM, Type: TypeHosted})
	if err != nil {
		t.Fatal(err)
	}
	for i, a := range []Artifact{
		{RepoID: r1.ID, Path: "a/1.jar", BlobSHA256: "b1", Size: 100},
		{RepoID: r1.ID, Path: "a/2.jar", BlobSHA256: "b2", Size: 50},
		{RepoID: r2.ID, Path: "p/-/p-1.tgz", BlobSHA256: "b3", Size: 7},
	} {
		if _, err := s.PutArtifact(ctx, a); err != nil {
			t.Fatalf("put %d: %v", i, err)
		}
	}

	stats, err := s.AllRepoStats(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st := stats[r1.ID]; st.ArtifactCount != 2 || st.TotalSize != 150 {
		t.Fatalf("r1 stats = %+v, want {2 150}", st)
	}
	if st := stats[r2.ID]; st.ArtifactCount != 1 || st.TotalSize != 7 {
		t.Fatalf("r2 stats = %+v, want {1 7}", st)
	}
	if _, ok := stats[999]; ok {
		t.Fatal("unexpected stats for unknown repo")
	}
}
