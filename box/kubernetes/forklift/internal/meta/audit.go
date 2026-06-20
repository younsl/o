package meta

import (
	"context"
	"time"
)

// AuditLog is one recorded repository event: artifact traffic (download,
// upload, delete) or a repository configuration change (repo.create,
// repo.update, repo.delete).
type AuditLog struct {
	ID        int64
	RepoName  string
	Event     string
	Path      string
	Username  string // empty = anonymous
	Method    string
	Status    int
	ClientIP  string
	UserAgent string
	CreatedAt time.Time
}

// Audit event constants.
const (
	EventDownload   = "download"
	EventUpload     = "upload"
	EventDelete     = "delete"
	EventRepoCreate = "repo.create"
	EventRepoUpdate = "repo.update"
	EventRepoDelete = "repo.delete"
	EventTTLExpire  = "ttl.expire" // artifact auto-deleted by the idle retention reaper
	EventVulnBlock  = "vuln.block" // request blocked by the vulnerability policy
)

// InsertAuditLog appends one audit log entry. CreatedAt defaults to now when
// unset.
func (s *Store) InsertAuditLog(ctx context.Context, l AuditLog) error {
	created := l.CreatedAt
	if created.IsZero() {
		created = time.Now()
	}
	_, err := s.h().ExecContext(ctx,
		`INSERT INTO audit_logs(repo_name, event, path, username, method, status, client_ip, user_agent, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		l.RepoName, l.Event, l.Path, l.Username, l.Method, l.Status, l.ClientIP, l.UserAgent,
		created.UTC().Format(time.RFC3339Nano))
	return wrap("insert audit log", err)
}

// ListAuditLogs returns a repository's audit log entries, newest first. event
// filters to one event type when non-empty.
func (s *Store) ListAuditLogs(ctx context.Context, repoName, event string, limit, offset int) ([]AuditLog, error) {
	q := `SELECT id, repo_name, event, path, username, method, status, client_ip, user_agent, created_at
          FROM audit_logs WHERE repo_name = ?`
	args := []any{repoName}
	if event != "" {
		q += ` AND event = ?`
		args = append(args, event)
	}
	q += ` ORDER BY id DESC LIMIT ? OFFSET ?`
	args = append(args, limit, offset)

	rows, err := s.h().QueryContext(ctx, q, args...)
	if err != nil {
		return nil, wrap("list audit logs", err)
	}
	defer rows.Close()
	out := []AuditLog{}
	for rows.Next() {
		var l AuditLog
		var created string
		if err := rows.Scan(&l.ID, &l.RepoName, &l.Event, &l.Path, &l.Username, &l.Method,
			&l.Status, &l.ClientIP, &l.UserAgent, &created); err != nil {
			return nil, wrap("scan audit log", err)
		}
		l.CreatedAt = parseTime(created)
		out = append(out, l)
	}
	return out, rows.Err()
}

// CountAuditLogs returns the number of audit log entries for a repository,
// optionally filtered to one event type.
func (s *Store) CountAuditLogs(ctx context.Context, repoName, event string) (int64, error) {
	q := `SELECT COUNT(*) FROM audit_logs WHERE repo_name = ?`
	args := []any{repoName}
	if event != "" {
		q += ` AND event = ?`
		args = append(args, event)
	}
	var n int64
	err := s.h().QueryRowContext(ctx, q, args...).Scan(&n)
	return n, wrap("count audit logs", err)
}

// PruneAuditLogs deletes entries older than before and reports how many rows
// were removed. Used by the retention loop.
func (s *Store) PruneAuditLogs(ctx context.Context, before time.Time) (int64, error) {
	res, err := s.h().ExecContext(ctx,
		`DELETE FROM audit_logs WHERE created_at < ?`,
		before.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return 0, wrap("prune audit logs", err)
	}
	return res.RowsAffected()
}
