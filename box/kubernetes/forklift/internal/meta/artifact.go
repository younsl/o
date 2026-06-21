package meta

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// PutArtifact upserts an artifact at (RepoID, Path), maintaining blob reference
// counts. The blob bytes must already be in the blob store. CachedAt /
// LastAccessedAt / UpdatedAt are set to now when zero.
func (s *Store) PutArtifact(ctx context.Context, a Artifact) (Artifact, error) {
	now := nowRFC3339()
	if a.ContentType == "" {
		a.ContentType = "application/octet-stream"
	}
	if a.MetadataJSON == "" {
		a.MetadataJSON = "{}"
	}
	// Callers may stamp cache times explicitly (engine uses its own clock for
	// testable freshness); otherwise default to now.
	cached, accessed := now, now
	if !a.CachedAt.IsZero() {
		cached = a.CachedAt.UTC().Format(time.RFC3339Nano)
	}
	if !a.LastAccessedAt.IsZero() {
		accessed = a.LastAccessedAt.UTC().Format(time.RFC3339Nano)
	}

	tx, err := s.h().BeginTx(ctx, nil)
	if err != nil {
		return Artifact{}, err
	}
	defer tx.Rollback()

	// Ensure the blob record exists (ref_count starts at 0, adjusted below).
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO blobs(sha256, size, ref_count, created_at) VALUES(?, ?, 0, ?)
         ON CONFLICT(sha256) DO NOTHING`, a.BlobSHA256, a.Size, now); err != nil {
		return Artifact{}, wrap("ensure blob", err)
	}

	// Find the blob currently referenced at this path, if any.
	var oldBlob string
	err = tx.QueryRowContext(ctx,
		`SELECT blob_sha256 FROM artifacts WHERE repo_id = ? AND path = ?`,
		a.RepoID, a.Path).Scan(&oldBlob)
	hadOld := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Artifact{}, err
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO artifacts(repo_id, path, version, blob_sha256, size, content_type, metadata_json, published_at, cached_at, last_accessed_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id, path) DO UPDATE SET
             version = excluded.version,
             blob_sha256 = excluded.blob_sha256,
             size = excluded.size,
             content_type = excluded.content_type,
             metadata_json = excluded.metadata_json,
             published_at = excluded.published_at,
             cached_at = excluded.cached_at,
             last_accessed_at = excluded.last_accessed_at,
             updated_at = excluded.updated_at`,
		a.RepoID, a.Path, a.Version, a.BlobSHA256, a.Size, a.ContentType, a.MetadataJSON,
		formatTimePtr(a.PublishedAt), cached, accessed, now); err != nil {
		return Artifact{}, wrap("upsert artifact", err)
	}

	switch {
	case !hadOld:
		if err := adjustRef(ctx, tx, a.BlobSHA256, +1); err != nil {
			return Artifact{}, err
		}
	case oldBlob != a.BlobSHA256:
		if err := adjustRef(ctx, tx, a.BlobSHA256, +1); err != nil {
			return Artifact{}, err
		}
		if err := adjustRef(ctx, tx, oldBlob, -1); err != nil {
			return Artifact{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return Artifact{}, err
	}
	return s.GetArtifact(ctx, a.RepoID, a.Path)
}

func adjustRef(ctx context.Context, tx *sql.Tx, sha string, delta int) error {
	_, err := tx.ExecContext(ctx, `UPDATE blobs SET ref_count = ref_count + ? WHERE sha256 = ?`, delta, sha)
	return err
}

// GetArtifact returns the artifact at (repoID, path).
func (s *Store) GetArtifact(ctx context.Context, repoID int64, path string) (Artifact, error) {
	return s.scanArtifact(s.h().QueryRowContext(ctx,
		`SELECT id, repo_id, path, version, blob_sha256, size, content_type, metadata_json, published_at, cached_at, last_accessed_at, updated_at
         FROM artifacts WHERE repo_id = ? AND path = ?`, repoID, path))
}

// ListArtifacts returns artifacts in a repository whose path begins with prefix.
func (s *Store) ListArtifacts(ctx context.Context, repoID int64, prefix string) ([]Artifact, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT id, repo_id, path, version, blob_sha256, size, content_type, metadata_json, published_at, cached_at, last_accessed_at, updated_at
         FROM artifacts WHERE repo_id = ? AND path LIKE ? ORDER BY path`,
		repoID, prefix+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Artifact
	for rows.Next() {
		a, err := scanArtifactRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// ListRepoArtifacts returns a repository's artifacts whose path begins with
// prefix, most-recently-accessed first, capped by limit. It powers the artifact
// browser in the UI.
func (s *Store) ListRepoArtifacts(ctx context.Context, repoID int64, prefix string, limit int) ([]Artifact, error) {
	if limit <= 0 {
		limit = 500
	}
	rows, err := s.h().QueryContext(ctx,
		`SELECT id, repo_id, path, version, blob_sha256, size, content_type, metadata_json, published_at, cached_at, last_accessed_at, updated_at
         FROM artifacts WHERE repo_id = ? AND path LIKE ? ORDER BY last_accessed_at DESC LIMIT ?`,
		repoID, prefix+"%", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Artifact
	for rows.Next() {
		a, err := scanArtifactRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// CountArtifacts returns the number of artifacts in a repository.
func (s *Store) CountArtifacts(ctx context.Context, repoID int64) (int64, error) {
	var n int64
	err := s.h().QueryRowContext(ctx, `SELECT COUNT(*) FROM artifacts WHERE repo_id = ?`, repoID).Scan(&n)
	return n, err
}

// Touch updates an artifact's last_accessed_at to now (for LRU eviction).
func (s *Store) Touch(ctx context.Context, repoID int64, path string) error {
	_, err := s.h().ExecContext(ctx,
		`UPDATE artifacts SET last_accessed_at = ? WHERE repo_id = ? AND path = ?`,
		nowRFC3339(), repoID, path)
	return err
}

// DeleteArtifact removes an artifact and decrements its blob reference count.
func (s *Store) DeleteArtifact(ctx context.Context, repoID int64, path string) error {
	tx, err := s.h().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var blob string
	err = tx.QueryRowContext(ctx,
		`SELECT blob_sha256 FROM artifacts WHERE repo_id = ? AND path = ?`, repoID, path).Scan(&blob)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM artifacts WHERE repo_id = ? AND path = ?`, repoID, path); err != nil {
		return err
	}
	if err := adjustRef(ctx, tx, blob, -1); err != nil {
		return err
	}
	return tx.Commit()
}

// PurgeArtifacts removes every artifact in a repository in one transaction,
// decrementing each referenced blob's count, and returns the number of rows
// deleted. Unreferenced blobs are reclaimed separately by the sweeper. Used by
// the repository's "purge all artifacts" admin action.
func (s *Store) PurgeArtifacts(ctx context.Context, repoID int64) (int, error) {
	tx, err := s.h().BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// Drop one reference for every artifact about to be deleted. Two artifacts in
	// this repo can point at the same blob, so subtract the per-blob row count
	// rather than a flat 1 (which would leak references and pin the blob).
	if _, err := tx.ExecContext(ctx,
		`UPDATE blobs SET ref_count = ref_count - (
             SELECT COUNT(*) FROM artifacts
             WHERE artifacts.repo_id = ? AND artifacts.blob_sha256 = blobs.sha256)
         WHERE sha256 IN (SELECT blob_sha256 FROM artifacts WHERE repo_id = ?)`,
		repoID, repoID); err != nil {
		return 0, wrap("purge adjust refs", err)
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM artifacts WHERE repo_id = ?`, repoID)
	if err != nil {
		return 0, wrap("purge artifacts", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return int(n), nil
}

// ListExpiredArtifacts returns artifacts in a repository last accessed (served)
// before cutoff, oldest first, capped by limit. Path and Version are populated
// so the idle-retention reaper can audit exactly what it removes. The cutoff is
// compared against the RFC3339Nano UTC text in last_accessed_at, whose
// lexicographic order matches chronological order.
func (s *Store) ListExpiredArtifacts(ctx context.Context, repoID int64, cutoff time.Time, limit int) ([]Artifact, error) {
	if limit <= 0 {
		limit = 256
	}
	rows, err := s.h().QueryContext(ctx,
		`SELECT id, repo_id, path, version, blob_sha256, size, content_type, metadata_json, published_at, cached_at, last_accessed_at, updated_at
         FROM artifacts WHERE repo_id = ? AND last_accessed_at < ? ORDER BY last_accessed_at ASC LIMIT ?`,
		repoID, cutoff.UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Artifact
	for rows.Next() {
		a, err := scanArtifactRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// EvictLRU removes up to limit least-recently-accessed artifacts in a repository
// and returns the freed paths. Blob ref counts are decremented; unreferenced
// blobs are reclaimed separately via ListUnreferencedBlobs.
func (s *Store) EvictLRU(ctx context.Context, repoID int64, limit int) (int, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT path FROM artifacts WHERE repo_id = ? ORDER BY last_accessed_at ASC LIMIT ?`,
		repoID, limit)
	if err != nil {
		return 0, err
	}
	var paths []string
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			rows.Close()
			return 0, err
		}
		paths = append(paths, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, p := range paths {
		if err := s.DeleteArtifact(ctx, repoID, p); err != nil && !errors.Is(err, ErrNotFound) {
			return 0, err
		}
	}
	return len(paths), nil
}

// RepoStats holds per-repository artifact aggregates for list views.
type RepoStats struct {
	ArtifactCount int64
	TotalSize     int64
}

// ScanTarget is a stored artifact's repository format with its path and
// version, enough to derive an OSV scan coordinate for backfill scanning.
type ScanTarget struct {
	Format  string
	Path    string
	Version string
}

// ListScanTargets returns stored artifacts that carry a version, joined with
// their repository format, paged by artifact id (ascending). Used by the
// backfill worker to scan already-uploaded packages.
func (s *Store) ListScanTargets(ctx context.Context, limit, offset int) ([]ScanTarget, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT r.format, a.path, a.version
		   FROM artifacts a JOIN repositories r ON a.repo_id = r.id
		  WHERE a.version != ''
		  ORDER BY a.id LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, wrap("list scan targets", err)
	}
	defer rows.Close()
	var out []ScanTarget
	for rows.Next() {
		var t ScanTarget
		if err := rows.Scan(&t.Format, &t.Path, &t.Version); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// AllRepoStats returns artifact count and total size for every repository that
// has artifacts, in one query (repositories without artifacts are absent).
func (s *Store) AllRepoStats(ctx context.Context) (map[int64]RepoStats, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT repo_id, COUNT(*), COALESCE(SUM(size), 0) FROM artifacts GROUP BY repo_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]RepoStats{}
	for rows.Next() {
		var id int64
		var st RepoStats
		if err := rows.Scan(&id, &st.ArtifactCount, &st.TotalSize); err != nil {
			return nil, err
		}
		out[id] = st
	}
	return out, rows.Err()
}

// RepoSize returns the total size of artifacts stored in a repository.
func (s *Store) RepoSize(ctx context.Context, repoID int64) (int64, error) {
	var size sql.NullInt64
	err := s.h().QueryRowContext(ctx,
		`SELECT SUM(size) FROM artifacts WHERE repo_id = ?`, repoID).Scan(&size)
	if err != nil {
		return 0, err
	}
	return size.Int64, nil
}

func (s *Store) scanArtifact(row *sql.Row) (Artifact, error) {
	var a Artifact
	var published sql.NullString
	var cached, accessed, updated string
	err := row.Scan(&a.ID, &a.RepoID, &a.Path, &a.Version, &a.BlobSHA256, &a.Size,
		&a.ContentType, &a.MetadataJSON, &published, &cached, &accessed, &updated)
	if errors.Is(err, sql.ErrNoRows) {
		return Artifact{}, ErrNotFound
	}
	if err != nil {
		return Artifact{}, err
	}
	fillArtifactTimes(&a, published, cached, accessed, updated)
	return a, nil
}

func scanArtifactRows(rows *sql.Rows) (Artifact, error) {
	var a Artifact
	var published sql.NullString
	var cached, accessed, updated string
	if err := rows.Scan(&a.ID, &a.RepoID, &a.Path, &a.Version, &a.BlobSHA256, &a.Size,
		&a.ContentType, &a.MetadataJSON, &published, &cached, &accessed, &updated); err != nil {
		return Artifact{}, err
	}
	fillArtifactTimes(&a, published, cached, accessed, updated)
	return a, nil
}

func fillArtifactTimes(a *Artifact, published sql.NullString, cached, accessed, updated string) {
	if published.Valid {
		a.PublishedAt = parseTimePtr(&published.String)
	}
	a.CachedAt = parseTime(cached)
	a.LastAccessedAt = parseTime(accessed)
	a.UpdatedAt = parseTime(updated)
}
