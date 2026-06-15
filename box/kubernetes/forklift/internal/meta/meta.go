// Package meta is the SQLite-backed metadata store: repositories, artifacts,
// blob reference counts, users, roles, and tokens. It uses the pure-Go
// modernc.org/sqlite driver so the binary stays CGO-free and statically links
// for scratch containers.
package meta

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Store wraps the SQLite database handle. The handle is guarded by a RWMutex
// so PV-based replication can atomically swap in a replicated snapshot when a
// standby is promoted to leader (see SwapFromSnapshot).
type Store struct {
	mu   sync.RWMutex
	db   *sql.DB
	path string
}

// Open opens (creating if needed) the SQLite database at path and applies any
// pending migrations. WAL mode and a busy timeout reduce lock contention; the
// single-writer guarantee for HA is provided by leader election, not the DB.
func Open(ctx context.Context, path string) (*Store, error) {
	db, err := openAndMigrate(ctx, path)
	if err != nil {
		return nil, err
	}
	return &Store{db: db, path: path}, nil
}

func openAndMigrate(ctx context.Context, path string) (*sql.DB, error) {
	dsn := path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite tolerates a single writer; cap connections to keep it predictable.
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if err := migrate(ctx, db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return db, nil
}

// h returns the current database handle. Callers may keep using a handle that
// is concurrently swapped; queries on a closed handle fail and are retried by
// probes, which is acceptable because swaps only happen on a traffic-less
// standby during promotion.
func (s *Store) h() *sql.DB {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.db
}

// DB exposes the underlying handle for advanced callers (tests, health checks).
func (s *Store) DB() *sql.DB { return s.h() }

// Path returns the database file path.
func (s *Store) Path() string { return s.path }

// Close closes the database.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Close()
}

// Ping verifies database connectivity.
func (s *Store) Ping(ctx context.Context) error { return s.h().PingContext(ctx) }

// Snapshot writes a consistent point-in-time copy of the database to dst using
// VACUUM INTO. The destination must not exist; any stale file is removed first.
func (s *Store) Snapshot(ctx context.Context, dst string) error {
	if err := os.Remove(dst); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove stale snapshot: %w", err)
	}
	if _, err := s.h().ExecContext(ctx, `VACUUM INTO ?`, dst); err != nil {
		return fmt.Errorf("vacuum into: %w", err)
	}
	return nil
}

// SwapFromSnapshot atomically replaces the database file with the snapshot at
// snapshotPath and reopens the handle. It is used when a replication standby
// is promoted to leader: the standby's local database is discarded in favor of
// the snapshot pulled from the previous leader. The store must not be serving
// write traffic when this is called (the standby is not Ready).
func (s *Store) SwapFromSnapshot(ctx context.Context, snapshotPath string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.db.Close(); err != nil {
		return fmt.Errorf("close current db: %w", err)
	}
	// Drop WAL sidecar files belonging to the old database before the rename so
	// SQLite never pairs the new file with a stale WAL.
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := os.Remove(s.path + suffix); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", suffix, err)
		}
	}
	if err := os.Rename(snapshotPath, s.path); err != nil {
		return fmt.Errorf("replace db file: %w", err)
	}
	db, err := openAndMigrate(ctx, s.path)
	if err != nil {
		return fmt.Errorf("reopen after swap: %w", err)
	}
	s.db = db
	return nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
    )`); err != nil {
		return err
	}

	applied := map[int]bool{}
	rows, err := db.QueryContext(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		version, err := migrationVersion(name)
		if err != nil {
			return err
		}
		if applied[version] {
			continue
		}
		body, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`,
			version, nowRFC3339()); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func migrationVersion(name string) (int, error) {
	// File names look like 0001_init.sql.
	idx := strings.IndexByte(name, '_')
	if idx <= 0 {
		return 0, fmt.Errorf("bad migration name %q", name)
	}
	var v int
	if _, err := fmt.Sscanf(name[:idx], "%d", &v); err != nil {
		return 0, fmt.Errorf("bad migration version in %q: %w", name, err)
	}
	return v, nil
}

func nowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}
