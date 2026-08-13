// Package scanner walks directory trees and collects files that match the
// configured include/exclude patterns.
package scanner

import (
	"log/slog"
	"os"
	"path/filepath"

	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/bytesize"
	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/matcher"
)

// FileInfo describes a file eligible for deletion.
type FileInfo struct {
	Path string
	Size int64
}

// Scanner traverses directories and collects matching files.
type Scanner struct {
	matcher *matcher.Matcher
	logger  *slog.Logger
}

// New creates a Scanner using the given pattern matcher.
func New(m *matcher.Matcher, logger *slog.Logger) *Scanner {
	return &Scanner{matcher: m, logger: logger}
}

// Scan collects all files under basePath that match the include patterns and
// do not match the exclude patterns. Pattern matching uses paths relative to
// basePath with forward slashes.
func (s *Scanner) Scan(basePath string) []FileInfo {
	var files []FileInfo
	s.walkDirectory(basePath, basePath, &files)
	return files
}

func (s *Scanner) walkDirectory(basePath, currentDir string, files *[]FileInfo) {
	entries, err := os.ReadDir(currentDir)
	if err != nil {
		if os.IsNotExist(err) {
			return
		}
		s.logger.Warn("Error reading directory", "path", currentDir, "error", err)
		return
	}

	for _, entry := range entries {
		path := filepath.Join(currentDir, entry.Name())

		rel, err := filepath.Rel(basePath, path)
		if err != nil {
			rel = entry.Name()
		}
		rel = filepath.ToSlash(rel)

		// DirEntry.Info uses lstat semantics, so symlinks are reported as
		// symlinks instead of their targets.
		info, err := entry.Info()
		if err != nil {
			s.logger.Warn("Error reading metadata", "path", path, "error", err)
			continue
		}

		// Skip symbolic links to prevent infinite loops and unintended
		// deletions outside target-paths.
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				target = "(target unreadable)"
			}
			s.logger.Info("Skipping symbolic link to prevent infinite loops and unintended deletions outside target-paths",
				"symlink", path,
				"relative_path", rel,
				"target", target,
				"file_type", "symlink")
			continue
		}

		if info.IsDir() {
			if s.matcher.ShouldExclude(rel) {
				s.logger.Info("Skipping excluded directory",
					"dir", path,
					"relative_path", rel,
					"file_type", "directory")
				continue
			}
			s.walkDirectory(basePath, path, files)
			continue
		}

		if s.matcher.ShouldExclude(rel) {
			s.logger.Info("Skipping excluded file",
				"file", path,
				"relative_path", rel,
				"file_type", "file",
				"size", bytesize.Human(info.Size()))
			continue
		}
		if !s.matcher.ShouldInclude(rel) {
			continue
		}

		*files = append(*files, FileInfo{Path: path, Size: info.Size()})
	}
}
