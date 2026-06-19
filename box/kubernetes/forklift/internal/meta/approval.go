package meta

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// PackageApproval is one package-level approval decision (or pending request)
// for a proxy repository. The package string is the canonical per-format name
// (npm package, normalized PyPI project, maven group:artifact, crate name, go
// module path).
type PackageApproval struct {
	ID                   int64
	RepoName             string
	Package              string
	Status               string
	RequestedBy          string // first requester, empty = anonymous
	DecidedBy            string
	Note                 string
	RequestCount         int64
	LastRequestedVersion string // last version seen in a blocked request, "" if none carried one
	FirstRequestedAt     time.Time
	LastRequestedAt      time.Time
	DecidedAt            *time.Time
}

// Approval status constants.
const (
	ApprovalPending  = "pending"
	ApprovalApproved = "approved"
	ApprovalRejected = "rejected"
)

// Approval audit event constants.
const (
	EventApprovalRequest = "approval.request"
	EventApprovalApprove = "approval.approve"
	EventApprovalReject  = "approval.reject"
)

const approvalCols = `id, repo_name, package, status, requested_by, decided_by, note,
       request_count, last_requested_version, first_requested_at, last_requested_at, decided_at`

// GetApprovalStatus returns a package's approval status for a repository.
// Hot path for the approval gate: a single indexed point read. Returns
// ErrNotFound when the package has never been requested or decided.
func (s *Store) GetApprovalStatus(ctx context.Context, repoName, pkg string) (string, error) {
	var status string
	err := s.h().QueryRowContext(ctx,
		`SELECT status FROM package_approvals WHERE repo_name = ? AND package = ?`,
		repoName, pkg).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return status, wrap("get approval status", err)
}

// UpsertPendingApproval records demand for an unapproved package: it creates a
// pending row on first request and bumps request_count/last_requested_at on
// subsequent ones. Approved rows are left untouched. Returns created=true only
// when a new pending row was inserted (drives the approval.request audit event).
//
// version is the version observed in the blocked request ("" for metadata
// requests that carry none). It is display-only context for the queue; a
// non-empty value overwrites the stored one, but an empty value never clobbers
// a version already recorded from an earlier versioned request.
func (s *Store) UpsertPendingApproval(ctx context.Context, repoName, pkg, username, version string) (bool, error) {
	now := nowRFC3339()
	var count int64
	err := s.h().QueryRowContext(ctx,
		`INSERT INTO package_approvals(repo_name, package, status, requested_by, last_requested_version, first_requested_at, last_requested_at)
         VALUES(?, ?, 'pending', ?, ?, ?, ?)
         ON CONFLICT(repo_name, package) DO UPDATE SET
             request_count = request_count + 1,
             last_requested_at = excluded.last_requested_at,
             last_requested_version = CASE
                 WHEN excluded.last_requested_version != '' THEN excluded.last_requested_version
                 ELSE package_approvals.last_requested_version END
             WHERE package_approvals.status != 'approved'
         RETURNING request_count`,
		repoName, pkg, username, version, now, now).Scan(&count)
	if errors.Is(err, sql.ErrNoRows) {
		// The DO UPDATE WHERE clause skipped an approved row.
		return false, nil
	}
	if err != nil {
		return false, wrap("upsert pending approval", err)
	}
	return count == 1, nil
}

// GetApproval returns one approval row by id.
func (s *Store) GetApproval(ctx context.Context, id int64) (PackageApproval, error) {
	row := s.h().QueryRowContext(ctx,
		`SELECT `+approvalCols+` FROM package_approvals WHERE id = ?`, id)
	a, err := scanApproval(row)
	if errors.Is(err, sql.ErrNoRows) {
		return PackageApproval{}, ErrNotFound
	}
	return a, wrap("get approval", err)
}

// ListApprovals returns approval rows, newest first. repoName and status are
// optional filters.
func (s *Store) ListApprovals(ctx context.Context, repoName, status string, limit, offset int) ([]PackageApproval, error) {
	q := `SELECT ` + approvalCols + ` FROM package_approvals WHERE 1=1`
	args := []any{}
	if repoName != "" {
		q += ` AND repo_name = ?`
		args = append(args, repoName)
	}
	if status != "" {
		q += ` AND status = ?`
		args = append(args, status)
	}
	q += ` ORDER BY id DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)

	rows, err := s.h().QueryContext(ctx, q, args...)
	if err != nil {
		return nil, wrap("list approvals", err)
	}
	defer rows.Close()
	out := []PackageApproval{}
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, wrap("scan approval", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountApprovals returns the number of approval rows matching the optional
// repoName and status filters.
func (s *Store) CountApprovals(ctx context.Context, repoName, status string) (int64, error) {
	q := `SELECT COUNT(*) FROM package_approvals WHERE 1=1`
	args := []any{}
	if repoName != "" {
		q += ` AND repo_name = ?`
		args = append(args, repoName)
	}
	if status != "" {
		q += ` AND status = ?`
		args = append(args, status)
	}
	var n int64
	err := s.h().QueryRowContext(ctx, q, args...).Scan(&n)
	return n, wrap("count approvals", err)
}

// DecideApproval sets a row's status (approved or rejected), recording who
// decided and an optional note. Re-deciding is allowed (approve after reject
// and vice versa).
func (s *Store) DecideApproval(ctx context.Context, id int64, status, decidedBy, note string) error {
	res, err := s.h().ExecContext(ctx,
		`UPDATE package_approvals SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?`,
		status, decidedBy, note, nowRFC3339(), id)
	if err != nil {
		return wrap("decide approval", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ApproveAllPending approves every pending package in one repository in a
// single statement and returns the rows it changed (for the audit log).
// Already approved or rejected rows are left untouched. Scoped to one
// repository so the per-repository approve permission check stays meaningful.
func (s *Store) ApproveAllPending(ctx context.Context, repoName, decidedBy, note string) ([]PackageApproval, error) {
	rows, err := s.h().QueryContext(ctx,
		`UPDATE package_approvals SET status = 'approved', decided_by = ?, note = ?, decided_at = ?
         WHERE repo_name = ? AND status = 'pending'
         RETURNING `+approvalCols,
		decidedBy, note, nowRFC3339(), repoName)
	if err != nil {
		return nil, wrap("approve all pending", err)
	}
	defer rows.Close()
	out := []PackageApproval{}
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, wrap("scan approval", err)
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// UpsertApprovalDecision creates or overwrites a decision for a package that
// may not have been requested yet (manual pre-approval via the admin API).
func (s *Store) UpsertApprovalDecision(ctx context.Context, repoName, pkg, status, decidedBy, note string) (PackageApproval, error) {
	now := nowRFC3339()
	row := s.h().QueryRowContext(ctx,
		`INSERT INTO package_approvals(repo_name, package, status, decided_by, note, request_count, first_requested_at, last_requested_at, decided_at)
         VALUES(?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(repo_name, package) DO UPDATE SET
             status = excluded.status,
             decided_by = excluded.decided_by,
             note = excluded.note,
             decided_at = excluded.decided_at
         RETURNING `+approvalCols,
		repoName, pkg, status, decidedBy, note, now, now, now)
	a, err := scanApproval(row)
	return a, wrap("upsert approval decision", err)
}

// DeleteApprovalsForRepo removes all approval rows for a repository. Called on
// repository deletion so a recreated same-name repo does not inherit old trust
// decisions.
func (s *Store) DeleteApprovalsForRepo(ctx context.Context, repoName string) error {
	_, err := s.h().ExecContext(ctx,
		`DELETE FROM package_approvals WHERE repo_name = ?`, repoName)
	return wrap("delete approvals for repo", err)
}

// scanApproval reads one approval row from a *sql.Row or *sql.Rows.
func scanApproval(row interface{ Scan(...any) error }) (PackageApproval, error) {
	var a PackageApproval
	var first, last string
	var decided sql.NullString
	if err := row.Scan(&a.ID, &a.RepoName, &a.Package, &a.Status, &a.RequestedBy,
		&a.DecidedBy, &a.Note, &a.RequestCount, &a.LastRequestedVersion, &first, &last, &decided); err != nil {
		return PackageApproval{}, err
	}
	a.FirstRequestedAt = parseTime(first)
	a.LastRequestedAt = parseTime(last)
	a.DecidedAt = nullTimePtr(decided)
	return a, nil
}
