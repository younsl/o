package meta

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
)

func openApprovalStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "approval.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestUpsertPendingApproval(t *testing.T) {
	s := openApprovalStore(t)
	ctx := context.Background()

	// First demand came from a metadata request with no version.
	created, err := s.UpsertPendingApproval(ctx, "npmjs", "left-pad", "alice", "")
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("first upsert should create")
	}

	// Repeat requests dedup into the same row and bump the counter. A later
	// versioned request records the version; a subsequent empty one must not
	// clobber it.
	for i, ver := range []string{"1.3.0", "", ""} {
		created, err = s.UpsertPendingApproval(ctx, "npmjs", "left-pad", "bob", ver)
		if err != nil {
			t.Fatal(err)
		}
		if created {
			t.Fatalf("repeat upsert %d must not report created", i)
		}
	}
	rows, err := s.ListApprovals(ctx, "npmjs", ApprovalPending, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	a := rows[0]
	if a.RequestCount != 4 || a.RequestedBy != "alice" || a.Status != ApprovalPending {
		t.Fatalf("row = %+v", a)
	}
	if a.LastRequestedVersion != "1.3.0" {
		t.Fatalf("last_requested_version = %q, want 1.3.0 (empty requests must not clobber it)", a.LastRequestedVersion)
	}
	if !a.LastRequestedAt.After(a.FirstRequestedAt) && !a.LastRequestedAt.Equal(a.FirstRequestedAt) {
		t.Fatalf("last_requested_at %v before first %v", a.LastRequestedAt, a.FirstRequestedAt)
	}

	// Approved rows are left untouched by further demand.
	if err := s.DecideApproval(ctx, a.ID, ApprovalApproved, "admin", "ok"); err != nil {
		t.Fatal(err)
	}
	created, err = s.UpsertPendingApproval(ctx, "npmjs", "left-pad", "carol", "")
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("upsert on approved row must not create")
	}
	got, err := s.GetApproval(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ApprovalApproved || got.RequestCount != 4 {
		t.Fatalf("approved row mutated: %+v", got)
	}

	// Rejected rows keep accruing demand.
	if err := s.DecideApproval(ctx, a.ID, ApprovalRejected, "admin", "nope"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.UpsertPendingApproval(ctx, "npmjs", "left-pad", "", ""); err != nil {
		t.Fatal(err)
	}
	got, err = s.GetApproval(ctx, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.RequestCount != 5 || got.Status != ApprovalRejected {
		t.Fatalf("rejected row = %+v", got)
	}
}

func TestApprovalStatusAndDecide(t *testing.T) {
	s := openApprovalStore(t)
	ctx := context.Background()

	if _, err := s.GetApprovalStatus(ctx, "npmjs", "lodash"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("status of unknown package err = %v, want ErrNotFound", err)
	}
	if _, err := s.UpsertPendingApproval(ctx, "npmjs", "lodash", "alice", ""); err != nil {
		t.Fatal(err)
	}
	st, err := s.GetApprovalStatus(ctx, "npmjs", "lodash")
	if err != nil || st != ApprovalPending {
		t.Fatalf("status = %q, %v", st, err)
	}

	rows, _ := s.ListApprovals(ctx, "", "", 10, 0)
	if err := s.DecideApproval(ctx, rows[0].ID, ApprovalApproved, "admin", "reviewed"); err != nil {
		t.Fatal(err)
	}
	st, _ = s.GetApprovalStatus(ctx, "npmjs", "lodash")
	if st != ApprovalApproved {
		t.Fatalf("status after approve = %q", st)
	}
	got, _ := s.GetApproval(ctx, rows[0].ID)
	if got.DecidedBy != "admin" || got.Note != "reviewed" || got.DecidedAt == nil {
		t.Fatalf("decided row = %+v", got)
	}

	// Re-deciding flips the status.
	if err := s.DecideApproval(ctx, rows[0].ID, ApprovalRejected, "admin", "incident"); err != nil {
		t.Fatal(err)
	}
	st, _ = s.GetApprovalStatus(ctx, "npmjs", "lodash")
	if st != ApprovalRejected {
		t.Fatalf("status after reject = %q", st)
	}

	if err := s.DecideApproval(ctx, 9999, ApprovalApproved, "admin", ""); !errors.Is(err, ErrNotFound) {
		t.Fatalf("decide unknown id err = %v, want ErrNotFound", err)
	}
}

func TestUpsertApprovalDecision(t *testing.T) {
	s := openApprovalStore(t)
	ctx := context.Background()

	// Manual pre-approval of a never-requested package.
	a, err := s.UpsertApprovalDecision(ctx, "npmjs", "@company/lib", ApprovalApproved, "admin", "internal")
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != ApprovalApproved || a.RequestCount != 0 || a.DecidedAt == nil {
		t.Fatalf("pre-approval = %+v", a)
	}

	// Overwriting an existing pending row preserves its demand counters.
	if _, err := s.UpsertPendingApproval(ctx, "npmjs", "axios", "alice", ""); err != nil {
		t.Fatal(err)
	}
	a, err = s.UpsertApprovalDecision(ctx, "npmjs", "axios", ApprovalRejected, "admin", "no")
	if err != nil {
		t.Fatal(err)
	}
	if a.Status != ApprovalRejected || a.RequestCount != 1 || a.RequestedBy != "alice" {
		t.Fatalf("overwrite = %+v", a)
	}
}

func TestApproveAllPending(t *testing.T) {
	s := openApprovalStore(t)
	ctx := context.Background()

	for _, p := range []string{"a", "b", "c"} {
		if _, err := s.UpsertPendingApproval(ctx, "npmjs", p, "alice", ""); err != nil {
			t.Fatal(err)
		}
	}
	// A different repo must not be touched by a scoped bulk approve.
	if _, err := s.UpsertPendingApproval(ctx, "pypi", "requests", "", ""); err != nil {
		t.Fatal(err)
	}
	// An already-rejected row in the target repo must stay rejected.
	rej, _ := s.UpsertApprovalDecision(ctx, "npmjs", "evil", ApprovalRejected, "admin", "ioc")

	approved, err := s.ApproveAllPending(ctx, "npmjs", "admin", "batch ok")
	if err != nil {
		t.Fatal(err)
	}
	if len(approved) != 3 {
		t.Fatalf("approved %d rows, want 3", len(approved))
	}
	for _, a := range approved {
		if a.Status != ApprovalApproved || a.DecidedBy != "admin" || a.Note != "batch ok" || a.DecidedAt == nil {
			t.Fatalf("approved row not decided: %+v", a)
		}
	}
	// The rejected row is untouched.
	got, _ := s.GetApproval(ctx, rej.ID)
	if got.Status != ApprovalRejected {
		t.Fatalf("rejected row flipped to %q", got.Status)
	}
	// The other repo's pending row is untouched.
	if st, _ := s.GetApprovalStatus(ctx, "pypi", "requests"); st != ApprovalPending {
		t.Fatalf("pypi row status = %q, want pending", st)
	}
	// No pending rows left in npmjs: a second run approves nothing.
	again, err := s.ApproveAllPending(ctx, "npmjs", "admin", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("second run approved %d rows, want 0", len(again))
	}
}

func TestApprovalListFiltersAndDelete(t *testing.T) {
	s := openApprovalStore(t)
	ctx := context.Background()

	for _, p := range []string{"a", "b", "c"} {
		if _, err := s.UpsertPendingApproval(ctx, "npmjs", p, "", ""); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.UpsertPendingApproval(ctx, "pypi", "requests", "", ""); err != nil {
		t.Fatal(err)
	}
	rows, _ := s.ListApprovals(ctx, "npmjs", "", 10, 0)
	if err := s.DecideApproval(ctx, rows[0].ID, ApprovalApproved, "admin", ""); err != nil {
		t.Fatal(err)
	}

	if n, _ := s.CountApprovals(ctx, "", ""); n != 4 {
		t.Fatalf("total count = %d", n)
	}
	if n, _ := s.CountApprovals(ctx, "npmjs", ApprovalPending); n != 2 {
		t.Fatalf("npmjs pending count = %d", n)
	}
	got, _ := s.ListApprovals(ctx, "", ApprovalPending, 2, 0)
	if len(got) != 2 {
		t.Fatalf("paginated len = %d", len(got))
	}
	got, _ = s.ListApprovals(ctx, "", ApprovalPending, 2, 2)
	if len(got) != 1 {
		t.Fatalf("second page len = %d", len(got))
	}

	if err := s.DeleteApprovalsForRepo(ctx, "npmjs"); err != nil {
		t.Fatal(err)
	}
	if n, _ := s.CountApprovals(ctx, "", ""); n != 1 {
		t.Fatalf("count after delete = %d", n)
	}
}
