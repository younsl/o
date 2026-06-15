package meta

import (
	"context"
	"errors"
	"testing"
)

func TestVersionDenyCRUD(t *testing.T) {
	s := openApprovalStore(t)
	ctx := context.Background()

	denied, err := s.IsVersionDenied(ctx, "npmjs", "lodash", "4.17.99")
	if err != nil || denied {
		t.Fatalf("empty table: denied=%v err=%v", denied, err)
	}

	d, err := s.UpsertVersionDeny(ctx, "npmjs", "lodash", "4.17.99", "IOC", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if d.ID == 0 || d.Reason != "IOC" || d.CreatedBy != "alice" || d.CreatedAt.IsZero() {
		t.Fatalf("created deny = %+v", d)
	}

	denied, err = s.IsVersionDenied(ctx, "npmjs", "lodash", "4.17.99")
	if err != nil || !denied {
		t.Fatalf("denied=%v err=%v, want true", denied, err)
	}
	// Exact-version semantics: other versions, packages and repos stay open.
	for _, c := range [][3]string{
		{"npmjs", "lodash", "4.17.21"},
		{"npmjs", "left-pad", "4.17.99"},
		{"npm-internal", "lodash", "4.17.99"},
	} {
		if denied, _ := s.IsVersionDenied(ctx, c[0], c[1], c[2]); denied {
			t.Fatalf("%v unexpectedly denied", c)
		}
	}

	// Re-deny is idempotent and refreshes reason/author, keeping the same row.
	d2, err := s.UpsertVersionDeny(ctx, "npmjs", "lodash", "4.17.99", "CVE-2026-0001", "bob")
	if err != nil {
		t.Fatal(err)
	}
	if d2.ID != d.ID || d2.Reason != "CVE-2026-0001" || d2.CreatedBy != "bob" {
		t.Fatalf("re-deny = %+v, want same id with refreshed fields", d2)
	}

	got, err := s.GetVersionDeny(ctx, d.ID)
	if err != nil || got.Package != "lodash" || got.Version != "4.17.99" {
		t.Fatalf("get = %+v err=%v", got, err)
	}

	if err := s.DeleteVersionDeny(ctx, d.ID); err != nil {
		t.Fatal(err)
	}
	if denied, _ := s.IsVersionDenied(ctx, "npmjs", "lodash", "4.17.99"); denied {
		t.Fatal("deleted deny still blocks")
	}
	if err := s.DeleteVersionDeny(ctx, d.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("double delete err = %v, want ErrNotFound", err)
	}
	if _, err := s.GetVersionDeny(ctx, d.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get deleted err = %v, want ErrNotFound", err)
	}
}

func TestVersionDenyListAndRepoCleanup(t *testing.T) {
	s := openApprovalStore(t)
	ctx := context.Background()

	seed := [][3]string{
		{"npmjs", "lodash", "4.17.99"},
		{"npmjs", "left-pad", "1.3.0"},
		{"pypi-proxy", "requests", "2.99.0"},
	}
	for _, c := range seed {
		if _, err := s.UpsertVersionDeny(ctx, c[0], c[1], c[2], "", "sec"); err != nil {
			t.Fatal(err)
		}
	}

	all, err := s.ListVersionDenies(ctx, "", 10, 0)
	if err != nil || len(all) != 3 {
		t.Fatalf("list all = %d err=%v, want 3", len(all), err)
	}
	// Newest first.
	if all[0].Package != "requests" {
		t.Fatalf("order: first = %s, want requests", all[0].Package)
	}
	scoped, err := s.ListVersionDenies(ctx, "npmjs", 10, 0)
	if err != nil || len(scoped) != 2 {
		t.Fatalf("list npmjs = %d err=%v, want 2", len(scoped), err)
	}
	if n, _ := s.CountVersionDenies(ctx, ""); n != 3 {
		t.Fatalf("count all = %d, want 3", n)
	}
	if n, _ := s.CountVersionDenies(ctx, "pypi-proxy"); n != 1 {
		t.Fatalf("count pypi-proxy = %d, want 1", n)
	}
	// Pagination.
	page, err := s.ListVersionDenies(ctx, "", 2, 2)
	if err != nil || len(page) != 1 {
		t.Fatalf("page = %d err=%v, want 1", len(page), err)
	}

	if err := s.DeleteVersionDeniesForRepo(ctx, "npmjs"); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.CountVersionDenies(ctx, ""); n != 1 {
		t.Fatalf("after repo cleanup count = %d, want 1", n)
	}
}
