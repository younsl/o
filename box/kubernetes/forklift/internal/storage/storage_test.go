package storage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"strings"
	"testing"
)

func TestFSStoreRoundTrip(t *testing.T) {
	s, err := NewFSStore(t.TempDir())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	ctx := context.Background()

	data := []byte("hello forklift")
	want := sha256.Sum256(data)
	wantHex := hex.EncodeToString(want[:])

	digest, n, err := s.Put(ctx, bytes.NewReader(data))
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	if digest != wantHex {
		t.Fatalf("digest = %s, want %s", digest, wantHex)
	}
	if n != int64(len(data)) {
		t.Fatalf("size = %d, want %d", n, len(data))
	}

	ok, err := s.Exists(ctx, digest)
	if err != nil || !ok {
		t.Fatalf("exists = %v, %v", ok, err)
	}

	rc, size, err := s.Open(ctx, digest)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer rc.Close()
	if size != int64(len(data)) {
		t.Fatalf("open size = %d", size)
	}
	got, _ := io.ReadAll(rc)
	if !bytes.Equal(got, data) {
		t.Fatalf("read = %q, want %q", got, data)
	}
}

func TestFSStoreDedup(t *testing.T) {
	s, err := NewFSStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	d1, _, err := s.Put(ctx, strings.NewReader("same bytes"))
	if err != nil {
		t.Fatal(err)
	}
	d2, _, err := s.Put(ctx, strings.NewReader("same bytes"))
	if err != nil {
		t.Fatal(err)
	}
	if d1 != d2 {
		t.Fatalf("expected identical digests, got %s and %s", d1, d2)
	}
}

func TestFSStoreDelete(t *testing.T) {
	s, err := NewFSStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	digest, _, _ := s.Put(ctx, strings.NewReader("to delete"))
	if err := s.Delete(ctx, digest); err != nil {
		t.Fatalf("delete: %v", err)
	}
	ok, _ := s.Exists(ctx, digest)
	if ok {
		t.Fatal("blob should be gone")
	}
	// Deleting a missing blob is a no-op.
	if err := s.Delete(ctx, digest); err != nil {
		t.Fatalf("delete missing: %v", err)
	}
}

func TestFSStoreOpenMissing(t *testing.T) {
	s, _ := NewFSStore(t.TempDir())
	ctx := context.Background()
	_, _, err := s.Open(ctx, strings.Repeat("a", 64))
	if err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	// Invalid digests are treated as not found, not errors.
	if _, _, err := s.Open(ctx, "short"); err != ErrNotFound {
		t.Fatalf("invalid digest err = %v", err)
	}
	if ok, _ := s.Exists(ctx, "bad"); ok {
		t.Fatal("invalid digest should not exist")
	}
}
