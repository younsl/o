package cleaner

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/config"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func makeConfig(targetPaths []string, threshold int, mode config.CleanupMode, dryRun bool) *config.Config {
	return &config.Config{
		TargetPaths:           targetPaths,
		UsageThresholdPercent: threshold,
		CheckIntervalMinutes:  1,
		IncludePatterns:       []string{"*"},
		ExcludePatterns:       nil,
		CleanupMode:           mode,
		DryRun:                dryRun,
		LogLevel:              "info",
	}
}

func mustCleaner(t *testing.T, cfg *config.Config) *Cleaner {
	t.Helper()
	c, err := New(cfg, discardLogger())
	if err != nil {
		t.Fatalf("New() failed: %v", err)
	}
	return c
}

func createFile(t *testing.T, dir, rel string, content []byte) {
	t.Helper()
	full := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}
	if err := os.WriteFile(full, content, 0o644); err != nil {
		t.Fatalf("WriteFile failed: %v", err)
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func TestNewSuccess(t *testing.T) {
	cfg := makeConfig([]string{"/tmp"}, 80, config.ModeOnce, true)
	if _, err := New(cfg, discardLogger()); err != nil {
		t.Errorf("New() failed: %v", err)
	}
}

func TestNewInvalidIncludePattern(t *testing.T) {
	cfg := makeConfig([]string{"/tmp"}, 80, config.ModeOnce, true)
	cfg.IncludePatterns = []string{"[invalid"}
	if _, err := New(cfg, discardLogger()); err == nil {
		t.Error("expected error for invalid include pattern")
	}
}

func TestNewInvalidExcludePattern(t *testing.T) {
	cfg := makeConfig([]string{"/tmp"}, 80, config.ModeOnce, true)
	cfg.ExcludePatterns = []string{"[invalid"}
	if _, err := New(cfg, discardLogger()); err == nil {
		t.Error("expected error for invalid exclude pattern")
	}
}

func TestStopSetsFlag(t *testing.T) {
	c := mustCleaner(t, makeConfig([]string{"/tmp"}, 80, config.ModeOnce, true))
	if c.stopped.Load() {
		t.Error("stopped flag set before Stop()")
	}
	c.Stop()
	if !c.stopped.Load() {
		t.Error("stopped flag not set after Stop()")
	}
}

func TestDiskUsagePercentAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	c := mustCleaner(t, makeConfig([]string{dir}, 80, config.ModeOnce, true))
	usage := c.diskUsagePercent(dir)
	if usage < 0 || usage > 100 {
		t.Errorf("usage %.2f out of range [0, 100]", usage)
	}
}

func TestDiskUsagePercentNonexistentPath(t *testing.T) {
	c := mustCleaner(t, makeConfig([]string{"/tmp"}, 80, config.ModeOnce, true))
	// Nonexistent paths cannot be statfs'd; usage falls back to 0.
	if usage := c.diskUsagePercent("relative/nonexistent"); usage != 0 {
		t.Errorf("usage = %.2f, want 0", usage)
	}
}

func TestCleanPathNonexistent(t *testing.T) {
	c := mustCleaner(t, makeConfig([]string{"/does/not/exist/zzzz-test"}, 0, config.ModeOnce, true))
	// Must return without panicking.
	c.cleanPath(context.Background(), "/does/not/exist/zzzz-test")
}

func TestCleanPathEmptyDirectory(t *testing.T) {
	dir := t.TempDir()
	c := mustCleaner(t, makeConfig([]string{dir}, 0, config.ModeOnce, false))
	c.cleanPath(context.Background(), dir)
	if !exists(dir) {
		t.Error("directory should still exist")
	}
}

func TestCleanPathDryRunPreservesFiles(t *testing.T) {
	dir := t.TempDir()
	createFile(t, dir, "keep1.txt", []byte("hello"))
	createFile(t, dir, "keep2.txt", []byte("world"))

	c := mustCleaner(t, makeConfig([]string{dir}, 0, config.ModeOnce, true))
	c.cleanPath(context.Background(), dir)

	if !exists(filepath.Join(dir, "keep1.txt")) {
		t.Error("keep1.txt should still exist")
	}
	if !exists(filepath.Join(dir, "keep2.txt")) {
		t.Error("keep2.txt should still exist")
	}
}

func TestCleanPathDeletesFiles(t *testing.T) {
	dir := t.TempDir()
	createFile(t, dir, "delete1.txt", []byte("hello"))
	createFile(t, dir, "delete2.txt", []byte("world"))
	createFile(t, dir, "sub/delete3.txt", []byte("nested"))

	c := mustCleaner(t, makeConfig([]string{dir}, 0, config.ModeOnce, false))
	c.cleanPath(context.Background(), dir)

	for _, name := range []string{"delete1.txt", "delete2.txt", "sub/delete3.txt"} {
		if exists(filepath.Join(dir, name)) {
			t.Errorf("%s should have been deleted", name)
		}
	}
}

func TestCleanPathRespectsStopFlag(t *testing.T) {
	dir := t.TempDir()
	createFile(t, dir, "file1.txt", []byte("a"))
	createFile(t, dir, "file2.txt", []byte("b"))

	c := mustCleaner(t, makeConfig([]string{dir}, 0, config.ModeOnce, false))
	c.Stop()
	c.cleanPath(context.Background(), dir)

	// The deletion loop bails at the stop check before touching the files.
	if !exists(filepath.Join(dir, "file1.txt")) {
		t.Error("file1.txt should still exist")
	}
	if !exists(filepath.Join(dir, "file2.txt")) {
		t.Error("file2.txt should still exist")
	}
}

func TestCleanPathRespectsContextCancel(t *testing.T) {
	dir := t.TempDir()
	createFile(t, dir, "file1.txt", []byte("a"))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	c := mustCleaner(t, makeConfig([]string{dir}, 0, config.ModeOnce, false))
	c.cleanPath(ctx, dir)

	if !exists(filepath.Join(dir, "file1.txt")) {
		t.Error("file1.txt should still exist")
	}
}

func TestPerformCleanupBelowThresholdSkips(t *testing.T) {
	dir := t.TempDir()
	createFile(t, dir, "keep.txt", []byte("data"))

	c := mustCleaner(t, makeConfig([]string{dir}, 100, config.ModeOnce, false))
	c.performCleanup(context.Background())

	if !exists(filepath.Join(dir, "keep.txt")) {
		t.Error("keep.txt should still exist")
	}
}

func TestPerformCleanupExceedsThresholdCleans(t *testing.T) {
	dir := t.TempDir()
	createFile(t, dir, "to-delete.txt", []byte("bytes"))

	c := mustCleaner(t, makeConfig([]string{dir}, 0, config.ModeOnce, false))
	c.performCleanup(context.Background())

	if exists(filepath.Join(dir, "to-delete.txt")) {
		t.Error("to-delete.txt should have been deleted")
	}
}

func TestRunOnceModeExecutesAndReturns(t *testing.T) {
	dir := t.TempDir()
	createFile(t, dir, "once.txt", []byte("x"))

	c := mustCleaner(t, makeConfig([]string{dir}, 0, config.ModeOnce, false))
	if err := c.Run(context.Background()); err != nil {
		t.Fatalf("Run() failed: %v", err)
	}

	if exists(filepath.Join(dir, "once.txt")) {
		t.Error("once.txt should have been deleted")
	}
}

func TestRunIntervalModeReturnsOnContextCancel(t *testing.T) {
	dir := t.TempDir()
	c := mustCleaner(t, makeConfig([]string{dir}, 100, config.ModeInterval, true))

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan error, 1)
	go func() { done <- c.Run(ctx) }()

	select {
	case err := <-done:
		if err != nil {
			t.Errorf("Run() failed: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run() did not exit within 5s after context cancel")
	}
}

func TestRunUnknownMode(t *testing.T) {
	cfg := makeConfig([]string{"/tmp"}, 80, config.CleanupMode("bogus"), true)
	c := mustCleaner(t, cfg)
	if err := c.Run(context.Background()); err == nil {
		t.Error("expected error for unknown cleanup mode")
	}
}
