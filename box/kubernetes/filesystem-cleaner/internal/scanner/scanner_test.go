package scanner

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/matcher"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func createTestFile(t *testing.T, base, rel string, content []byte) {
	t.Helper()
	full := filepath.Join(base, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	if err := os.WriteFile(full, content, 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
}

func mustMatcher(t *testing.T, include, exclude []string) *matcher.Matcher {
	t.Helper()
	m, err := matcher.New(include, exclude)
	if err != nil {
		t.Fatalf("matcher.New failed: %v", err)
	}
	return m
}

func hasSuffix(files []FileInfo, suffix string) bool {
	for _, f := range files {
		if strings.HasSuffix(f.Path, suffix) {
			return true
		}
	}
	return false
}

func TestScanWithExclude(t *testing.T) {
	dir := t.TempDir()
	createTestFile(t, dir, "test.txt", []byte("test"))
	createTestFile(t, dir, ".git/config", []byte("config"))
	createTestFile(t, dir, "node_modules/lib.js", []byte("js"))

	m := mustMatcher(t, []string{"*"}, []string{"**/.git/**", "**/node_modules/**"})
	files := New(m, discardLogger()).Scan(dir)

	if len(files) != 1 {
		t.Fatalf("got %d files, want 1: %v", len(files), files)
	}
	if !hasSuffix(files, "test.txt") {
		t.Error("expected test.txt in results")
	}
}

func TestScanNestedDirectories(t *testing.T) {
	dir := t.TempDir()
	createTestFile(t, dir, "build/groovy-dsl/cache.jar", []byte("jar"))
	createTestFile(t, dir, "build/other/file.txt", []byte("txt"))

	m := mustMatcher(t, []string{"*"}, []string{"**/groovy-dsl/**"})
	files := New(m, discardLogger()).Scan(dir)

	if len(files) != 1 {
		t.Fatalf("got %d files, want 1: %v", len(files), files)
	}
	if !hasSuffix(files, "file.txt") {
		t.Error("expected file.txt in results")
	}
}

func TestScanNonexistentPath(t *testing.T) {
	m := mustMatcher(t, []string{"*"}, nil)
	files := New(m, discardLogger()).Scan("/does/not/exist/zzzz-test")

	if len(files) != 0 {
		t.Errorf("got %d files, want 0", len(files))
	}
}

func TestScanReportsFileSize(t *testing.T) {
	dir := t.TempDir()
	createTestFile(t, dir, "sized.bin", []byte("12345"))

	m := mustMatcher(t, []string{"*"}, nil)
	files := New(m, discardLogger()).Scan(dir)

	if len(files) != 1 {
		t.Fatalf("got %d files, want 1", len(files))
	}
	if files[0].Size != 5 {
		t.Errorf("Size = %d, want 5", files[0].Size)
	}
}

func TestSkipSymbolicLinks(t *testing.T) {
	dir := t.TempDir()
	createTestFile(t, dir, "real_file.txt", []byte("content"))
	createTestFile(t, dir, "target/important.dat", []byte("important"))

	if err := os.Symlink(filepath.Join(dir, "target"), filepath.Join(dir, "link_to_target")); err != nil {
		t.Fatalf("Symlink failed: %v", err)
	}

	m := mustMatcher(t, []string{"*"}, nil)
	files := New(m, discardLogger()).Scan(dir)

	if !hasSuffix(files, "real_file.txt") {
		t.Error("expected real_file.txt in results")
	}
	if !hasSuffix(files, "important.dat") {
		t.Error("expected important.dat in results")
	}
	// 2 files, not 3: the symlinked directory must not be traversed.
	if len(files) != 2 {
		t.Errorf("got %d files, want 2: %v", len(files), files)
	}
}

func TestSkipCircularSymlinks(t *testing.T) {
	dir := t.TempDir()
	createTestFile(t, dir, "dir/file.txt", []byte("test"))

	if err := os.Symlink("..", filepath.Join(dir, "dir/link_to_parent")); err != nil {
		t.Fatalf("Symlink failed: %v", err)
	}

	m := mustMatcher(t, []string{"*"}, nil)
	files := New(m, discardLogger()).Scan(dir)

	// Must complete without infinite recursion and find only dir/file.txt.
	if len(files) != 1 {
		t.Fatalf("got %d files, want 1: %v", len(files), files)
	}
	if !hasSuffix(files, "file.txt") {
		t.Error("expected file.txt in results")
	}
}
