package meta

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// VersionDeny is one per-version deny entry for a proxy repository: the exact
// (package, version) is blocked regardless of the package's approval status.
// The package string follows the same canonical per-format convention as
// PackageApproval; the version is the exact string seen in request paths
// (go modules keep the "v" prefix).
type VersionDeny struct {
	ID        int64
	RepoName  string
	Package   string
	Version   string
	Reason    string
	CreatedBy string
	CreatedAt time.Time
}

// Version-deny audit event constants.
const (
	EventDenyCreate = "deny.create"
	EventDenyDelete = "deny.delete"
	EventDenyBlock  = "deny.block"
)

const denyCols = `id, repo_name, package, version, reason, created_by, created_at`

// IsVersionDenied reports whether an exact (package, version) is denied in a
// repository. Hot path for the approval gate: a single point read on the
// UNIQUE(repo_name, package, version) index.
func (s *Store) IsVersionDenied(ctx context.Context, repoName, pkg, version string) (bool, error) {
	var one int
	err := s.h().QueryRowContext(ctx,
		`SELECT 1 FROM version_denies WHERE repo_name = ? AND package = ? AND version = ?`,
		repoName, pkg, version).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, wrap("is version denied", err)
}

// UpsertVersionDeny creates a deny entry, or refreshes reason/created_by when
// the same (repo, package, version) is denied again (idempotent re-deny).
func (s *Store) UpsertVersionDeny(ctx context.Context, repoName, pkg, version, reason, createdBy string) (VersionDeny, error) {
	row := s.h().QueryRowContext(ctx,
		`INSERT INTO version_denies(repo_name, package, version, reason, created_by, created_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_name, package, version) DO UPDATE SET
             reason = excluded.reason,
             created_by = excluded.created_by
         RETURNING `+denyCols,
		repoName, pkg, version, reason, createdBy, nowRFC3339())
	d, err := scanVersionDeny(row)
	return d, wrap("upsert version deny", err)
}

// GetVersionDeny returns one deny entry by id.
func (s *Store) GetVersionDeny(ctx context.Context, id int64) (VersionDeny, error) {
	row := s.h().QueryRowContext(ctx,
		`SELECT `+denyCols+` FROM version_denies WHERE id = ?`, id)
	d, err := scanVersionDeny(row)
	if errors.Is(err, sql.ErrNoRows) {
		return VersionDeny{}, ErrNotFound
	}
	return d, wrap("get version deny", err)
}

// ListVersionDenies returns deny entries, newest first. repoName is an
// optional filter.
func (s *Store) ListVersionDenies(ctx context.Context, repoName string, limit, offset int) ([]VersionDeny, error) {
	q := `SELECT ` + denyCols + ` FROM version_denies WHERE 1=1`
	args := []any{}
	if repoName != "" {
		q += ` AND repo_name = ?`
		args = append(args, repoName)
	}
	q += ` ORDER BY id DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)

	rows, err := s.h().QueryContext(ctx, q, args...)
	if err != nil {
		return nil, wrap("list version denies", err)
	}
	defer rows.Close()
	out := []VersionDeny{}
	for rows.Next() {
		d, err := scanVersionDeny(rows)
		if err != nil {
			return nil, wrap("scan version deny", err)
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// CountVersionDenies returns the number of deny entries matching the optional
// repoName filter.
func (s *Store) CountVersionDenies(ctx context.Context, repoName string) (int64, error) {
	q := `SELECT COUNT(*) FROM version_denies WHERE 1=1`
	args := []any{}
	if repoName != "" {
		q += ` AND repo_name = ?`
		args = append(args, repoName)
	}
	var n int64
	err := s.h().QueryRowContext(ctx, q, args...).Scan(&n)
	return n, wrap("count version denies", err)
}

// DeleteVersionDeny removes one deny entry (un-deny). The next request for
// the version goes back through the regular approval/age gates.
func (s *Store) DeleteVersionDeny(ctx context.Context, id int64) error {
	res, err := s.h().ExecContext(ctx, `DELETE FROM version_denies WHERE id = ?`, id)
	if err != nil {
		return wrap("delete version deny", err)
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

// DeleteVersionDeniesForRepo removes all deny entries for a repository.
// Called on repository deletion so a recreated same-name repo does not
// inherit old deny decisions.
func (s *Store) DeleteVersionDeniesForRepo(ctx context.Context, repoName string) error {
	_, err := s.h().ExecContext(ctx,
		`DELETE FROM version_denies WHERE repo_name = ?`, repoName)
	return wrap("delete version denies for repo", err)
}

// scanVersionDeny reads one deny row from a *sql.Row or *sql.Rows.
func scanVersionDeny(row interface{ Scan(...any) error }) (VersionDeny, error) {
	var d VersionDeny
	var created string
	if err := row.Scan(&d.ID, &d.RepoName, &d.Package, &d.Version, &d.Reason,
		&d.CreatedBy, &created); err != nil {
		return VersionDeny{}, err
	}
	d.CreatedAt = parseTime(created)
	return d, nil
}
