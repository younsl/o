package meta

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// CreateRepository inserts a repository and returns it with its assigned ID.
func (s *Store) CreateRepository(ctx context.Context, r Repository) (Repository, error) {
	now := nowRFC3339()
	if r.ConfigJSON == "" {
		r.ConfigJSON = "{}"
	}
	res, err := s.h().ExecContext(ctx,
		`INSERT INTO repositories(name, format, type, upstream_url, config_json, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
		r.Name, r.Format, r.Type, r.UpstreamURL, r.ConfigJSON, now, now)
	if err != nil {
		return Repository{}, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Repository{}, err
	}
	return s.GetRepository(ctx, id)
}

// GetRepository returns a repository by ID.
func (s *Store) GetRepository(ctx context.Context, id int64) (Repository, error) {
	return s.scanRepository(s.h().QueryRowContext(ctx,
		`SELECT id, name, format, type, upstream_url, config_json, created_at, updated_at, disabled
         FROM repositories WHERE id = ?`, id))
}

// GetRepositoryByName returns a repository by name.
func (s *Store) GetRepositoryByName(ctx context.Context, name string) (Repository, error) {
	return s.scanRepository(s.h().QueryRowContext(ctx,
		`SELECT id, name, format, type, upstream_url, config_json, created_at, updated_at, disabled
         FROM repositories WHERE name = ?`, name))
}

// ListRepositories returns all repositories ordered by name.
func (s *Store) ListRepositories(ctx context.Context) ([]Repository, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT id, name, format, type, upstream_url, config_json, created_at, updated_at, disabled
         FROM repositories ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Repository
	for rows.Next() {
		r, err := s.scanRepositoryRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// UpdateRepositoryConfig updates the upstream URL and config JSON of a repository.
func (s *Store) UpdateRepositoryConfig(ctx context.Context, id int64, upstreamURL, configJSON string) error {
	res, err := s.h().ExecContext(ctx,
		`UPDATE repositories SET upstream_url = ?, config_json = ?, updated_at = ? WHERE id = ?`,
		upstreamURL, configJSON, nowRFC3339(), id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// DeleteRepository removes a repository. Artifacts cascade; blob ref counts are
// decremented first so unreferenced blobs can be garbage-collected.
func (s *Store) DeleteRepository(ctx context.Context, id int64) error {
	tx, err := s.h().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`UPDATE blobs SET ref_count = ref_count - 1
         WHERE sha256 IN (SELECT blob_sha256 FROM artifacts WHERE repo_id = ?)`, id); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM repositories WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if err := ensureAffected(res); err != nil {
		return err
	}
	return tx.Commit()
}

// SetRepositoryDisabled toggles a repository's online/offline state.
func (s *Store) SetRepositoryDisabled(ctx context.Context, id int64, disabled bool) error {
	res, err := s.h().ExecContext(ctx,
		`UPDATE repositories SET disabled = ?, updated_at = ? WHERE id = ?`,
		boolToInt(disabled), nowRFC3339(), id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

func (s *Store) scanRepository(row *sql.Row) (Repository, error) {
	var r Repository
	var created, updated string
	var disabled int
	err := row.Scan(&r.ID, &r.Name, &r.Format, &r.Type, &r.UpstreamURL, &r.ConfigJSON, &created, &updated, &disabled)
	if errors.Is(err, sql.ErrNoRows) {
		return Repository{}, ErrNotFound
	}
	if err != nil {
		return Repository{}, err
	}
	r.CreatedAt = parseTime(created)
	r.UpdatedAt = parseTime(updated)
	r.Disabled = disabled != 0
	return r, nil
}

func (s *Store) scanRepositoryRows(rows *sql.Rows) (Repository, error) {
	var r Repository
	var created, updated string
	var disabled int
	if err := rows.Scan(&r.ID, &r.Name, &r.Format, &r.Type, &r.UpstreamURL, &r.ConfigJSON, &created, &updated, &disabled); err != nil {
		return Repository{}, err
	}
	r.CreatedAt = parseTime(created)
	r.UpdatedAt = parseTime(updated)
	r.Disabled = disabled != 0
	return r, nil
}

func ensureAffected(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func wrap(op string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", op, err)
}
