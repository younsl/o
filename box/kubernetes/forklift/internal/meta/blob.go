package meta

import (
	"context"
	"database/sql"
	"errors"
)

// GetBlob returns blob metadata by digest.
func (s *Store) GetBlob(ctx context.Context, sha string) (Blob, error) {
	var b Blob
	var created string
	err := s.h().QueryRowContext(ctx,
		`SELECT sha256, size, ref_count, created_at FROM blobs WHERE sha256 = ?`, sha).
		Scan(&b.SHA256, &b.Size, &b.RefCount, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Blob{}, ErrNotFound
	}
	if err != nil {
		return Blob{}, err
	}
	b.CreatedAt = parseTime(created)
	return b, nil
}

// BlobStats returns the number of stored blobs and their total physical size in
// bytes. Because blobs are content-addressed and deduplicated, this reflects
// actual disk usage rather than the logical artifact size.
func (s *Store) BlobStats(ctx context.Context) (count, bytes int64, err error) {
	var c, b sql.NullInt64
	err = s.h().QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(SUM(size), 0) FROM blobs`).Scan(&c, &b)
	if err != nil {
		return 0, 0, err
	}
	return c.Int64, b.Int64, nil
}

// ListUnreferencedBlobs returns digests of blobs with ref_count <= 0, capped by
// limit. The cache sweeper uses this to delete bytes from the blob store.
func (s *Store) ListUnreferencedBlobs(ctx context.Context, limit int) ([]string, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT sha256 FROM blobs WHERE ref_count <= 0 LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			return nil, err
		}
		out = append(out, sha)
	}
	return out, rows.Err()
}

// ListBlobDigests returns blob digests ordered by sha256, starting strictly
// after the cursor, capped by limit. Replication standbys page through this to
// mirror the leader's blob set.
func (s *Store) ListBlobDigests(ctx context.Context, after string, limit int) ([]string, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT sha256 FROM blobs WHERE sha256 > ? ORDER BY sha256 LIMIT ?`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			return nil, err
		}
		out = append(out, sha)
	}
	return out, rows.Err()
}

// DeleteBlobRecord removes a blob row. Callers must delete the bytes from the
// blob store separately and should only call this for unreferenced blobs.
func (s *Store) DeleteBlobRecord(ctx context.Context, sha string) error {
	_, err := s.h().ExecContext(ctx, `DELETE FROM blobs WHERE sha256 = ? AND ref_count <= 0`, sha)
	return err
}
