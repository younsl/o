// Package storage provides a content-addressed blob store. Blobs are immutable
// and keyed by their SHA-256 digest, which makes concurrent reads safe across
// replicas sharing a ReadWriteMany PersistentVolume and lets repositories share
// identical bytes (dedup).
package storage

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// ErrNotFound is returned when a blob digest is not present in the store.
var ErrNotFound = errors.New("blob not found")

// BlobStore stores and retrieves immutable, content-addressed blobs.
type BlobStore interface {
	// Put streams r into the store and returns the SHA-256 digest (hex) and the
	// number of bytes written. Writing an already-present blob is a no-op.
	Put(ctx context.Context, r io.Reader) (digest string, size int64, err error)
	// Open returns a reader for the blob identified by digest.
	Open(ctx context.Context, digest string) (io.ReadCloser, int64, error)
	// Exists reports whether a blob is present.
	Exists(ctx context.Context, digest string) (bool, error)
	// Delete removes a blob. Deleting a missing blob returns nil.
	Delete(ctx context.Context, digest string) error
}

// FSStore is a filesystem-backed BlobStore laid out as <root>/blobs/aa/bb/<digest>.
type FSStore struct {
	root string
}

// NewFSStore creates the blob directory under root and returns an FSStore.
func NewFSStore(root string) (*FSStore, error) {
	base := filepath.Join(root, "blobs")
	if err := os.MkdirAll(base, 0o755); err != nil {
		return nil, fmt.Errorf("create blob dir: %w", err)
	}
	tmp := filepath.Join(base, "tmp")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return nil, fmt.Errorf("create blob tmp dir: %w", err)
	}
	return &FSStore{root: base}, nil
}

func (s *FSStore) path(digest string) string {
	// Fan out by the first two byte-pairs to avoid huge directories.
	return filepath.Join(s.root, digest[0:2], digest[2:4], digest)
}

// Put implements BlobStore. It writes to a temp file while hashing, then renames
// into the digest path. The rename is atomic on the same filesystem so partial
// writes are never observed by readers.
func (s *FSStore) Put(ctx context.Context, r io.Reader) (string, int64, error) {
	tmp, err := os.CreateTemp(filepath.Join(s.root, "tmp"), "blob-*")
	if err != nil {
		return "", 0, fmt.Errorf("create temp blob: %w", err)
	}
	tmpName := tmp.Name()
	defer func() {
		tmp.Close()
		os.Remove(tmpName) // no-op if already renamed away
	}()

	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), r)
	if err != nil {
		return "", 0, fmt.Errorf("write blob: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		return "", 0, fmt.Errorf("sync blob: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", 0, fmt.Errorf("close blob: %w", err)
	}

	digest := hex.EncodeToString(h.Sum(nil))
	dst := s.path(digest)
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return "", 0, fmt.Errorf("create blob shard dir: %w", err)
	}
	// If the blob already exists, the bytes are identical by construction; keep
	// the existing one and drop the temp file.
	if _, statErr := os.Stat(dst); statErr == nil {
		return digest, n, nil
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return "", 0, fmt.Errorf("commit blob: %w", err)
	}
	return digest, n, nil
}

// Open implements BlobStore.
func (s *FSStore) Open(ctx context.Context, digest string) (io.ReadCloser, int64, error) {
	if !validDigest(digest) {
		return nil, 0, ErrNotFound
	}
	f, err := os.Open(s.path(digest))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, ErrNotFound
		}
		return nil, 0, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return f, fi.Size(), nil
}

// Exists implements BlobStore.
func (s *FSStore) Exists(ctx context.Context, digest string) (bool, error) {
	if !validDigest(digest) {
		return false, nil
	}
	_, err := os.Stat(s.path(digest))
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

// Delete implements BlobStore.
func (s *FSStore) Delete(ctx context.Context, digest string) error {
	if !validDigest(digest) {
		return nil
	}
	err := os.Remove(s.path(digest))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// WalkDigests calls fn for every stored blob digest in lexicographic order.
// Replication uses the ordering to diff the local set against the leader's
// cursor-paged listing without holding both sets in memory. Walking stops at
// the first error returned by fn.
func (s *FSStore) WalkDigests(ctx context.Context, fn func(digest string) error) error {
	l1, err := sortedDirs(s.root)
	if err != nil {
		return err
	}
	for _, d1 := range l1 {
		if d1 == "tmp" {
			continue
		}
		l2, err := sortedDirs(filepath.Join(s.root, d1))
		if err != nil {
			return err
		}
		for _, d2 := range l2 {
			entries, err := os.ReadDir(filepath.Join(s.root, d1, d2))
			if err != nil {
				return err
			}
			for _, e := range entries {
				if err := ctx.Err(); err != nil {
					return err
				}
				if e.IsDir() || !validDigest(e.Name()) {
					continue
				}
				if err := fn(e.Name()); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func sortedDirs(path string) ([]string, error) {
	entries, err := os.ReadDir(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}

func validDigest(d string) bool {
	if len(d) != 64 {
		return false
	}
	_, err := hex.DecodeString(d)
	return err == nil
}
