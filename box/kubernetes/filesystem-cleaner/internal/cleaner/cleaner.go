// Package cleaner orchestrates filesystem cleanup: it monitors disk usage,
// schedules cleanup runs (once or on an interval), and deletes files
// collected by the scanner.
package cleaner

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"sync/atomic"
	"time"

	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/bytesize"
	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/config"
	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/disk"
	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/matcher"
	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/scanner"
)

// Cleaner runs cleanup cycles against the configured target paths.
type Cleaner struct {
	cfg     *config.Config
	scanner *scanner.Scanner
	logger  *slog.Logger
	stopped atomic.Bool
}

// New creates a Cleaner, compiling the configured glob patterns.
func New(cfg *config.Config, logger *slog.Logger) (*Cleaner, error) {
	m, err := matcher.New(cfg.IncludePatterns, cfg.ExcludePatterns)
	if err != nil {
		return nil, err
	}
	return &Cleaner{
		cfg:     cfg,
		scanner: scanner.New(m, logger),
		logger:  logger,
	}, nil
}

// Run executes the cleaner in the configured mode until it finishes (once
// mode) or the context is cancelled (interval mode).
func (c *Cleaner) Run(ctx context.Context) error {
	switch c.cfg.CleanupMode {
	case config.ModeOnce:
		c.logger.Info("Running in 'once' mode - single cleanup execution")
		c.performCleanup(ctx)
		c.logger.Info("Cleanup completed, exiting")
		return nil

	case config.ModeInterval:
		c.logger.Info("Running in 'interval' mode - periodic cleanup",
			"interval_minutes", c.cfg.CheckIntervalMinutes)

		c.performCleanup(ctx)

		ticker := time.NewTicker(time.Duration(c.cfg.CheckIntervalMinutes) * time.Minute)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				c.logger.Info("Cleaner stopped")
				return nil
			case <-ticker.C:
				if c.stopped.Load() {
					c.logger.Info("Cleaner stopped")
					return nil
				}
				c.performCleanup(ctx)
			}
		}

	default:
		return fmt.Errorf("unknown cleanup mode: %s", c.cfg.CleanupMode)
	}
}

// Stop requests a graceful shutdown of the cleaner.
func (c *Cleaner) Stop() {
	c.stopped.Store(true)
}

func (c *Cleaner) interrupted(ctx context.Context) bool {
	return c.stopped.Load() || ctx.Err() != nil
}

// performCleanup runs one cleanup cycle over all target paths.
func (c *Cleaner) performCleanup(ctx context.Context) {
	c.logger.Info("Starting cleanup cycle")
	start := time.Now()

	for _, path := range c.cfg.TargetPaths {
		usage := c.diskUsagePercent(path)

		if usage > float64(c.cfg.UsageThresholdPercent) {
			c.logger.Warn("Disk usage exceeds threshold, starting cleanup",
				"path", path,
				"usage", usage,
				"threshold", c.cfg.UsageThresholdPercent,
				"cleanup_mode", string(c.cfg.CleanupMode),
				"dry_run", c.cfg.DryRun)
			c.cleanPath(ctx, path)
		} else {
			c.logger.Info("Disk usage is below threshold, skipping cleanup",
				"path", path,
				"usage", usage,
				"threshold", c.cfg.UsageThresholdPercent,
				"cleanup_mode", string(c.cfg.CleanupMode))
		}
	}

	c.logger.Info("Cleanup cycle completed",
		"duration_secs", int(time.Since(start).Seconds()))
}

// diskUsagePercent returns the used percentage of the filesystem containing
// path, or 0 when the filesystem cannot be inspected.
func (c *Cleaner) diskUsagePercent(path string) float64 {
	usage, err := disk.UsagePercent(path)
	if err != nil {
		c.logger.Error("Failed to get disk usage", "path", path, "error", err)
		return 0
	}
	return usage
}

// cleanPath deletes matching files under basePath.
func (c *Cleaner) cleanPath(ctx context.Context, basePath string) {
	if _, err := os.Stat(basePath); err != nil {
		c.logger.Error("Path does not exist", "path", basePath)
		return
	}

	initialUsage := c.diskUsagePercent(basePath)

	files := c.scanner.Scan(basePath)
	if len(files) == 0 {
		c.logger.Info("No files to clean",
			"path", basePath,
			"initial_usage_percent", initialUsage)
		return
	}

	var totalSize int64
	for _, f := range files {
		totalSize += f.Size
	}

	c.logger.Info("Starting cleanup operation",
		"path", basePath,
		"initial_usage_percent", initialUsage,
		"file_count", len(files),
		"total_size", bytesize.Human(totalSize))

	deletedCount := 0
	var freedSpace int64

	for _, file := range files {
		if c.interrupted(ctx) {
			c.logger.Info("Cleanup interrupted by shutdown")
			break
		}

		if c.cfg.DryRun {
			c.logger.Info("[DRY-RUN] Would delete file",
				"file", file.Path,
				"size", bytesize.Human(file.Size))
			continue
		}

		if err := os.Remove(file.Path); err != nil {
			c.logger.Error("Failed to delete file",
				"file", file.Path,
				"error", err)
			continue
		}
		c.logger.Info("File deleted successfully",
			"file", file.Path,
			"size", bytesize.Human(file.Size))
		deletedCount++
		freedSpace += file.Size
	}

	finalUsage := c.diskUsagePercent(basePath)
	usageReduction := initialUsage - finalUsage

	if c.cfg.DryRun {
		c.logger.Info("Cleanup completed (DRY-RUN)",
			"path", basePath,
			"initial_usage_percent", initialUsage,
			"final_usage_percent", finalUsage,
			"usage_reduction", usageReduction,
			"would_delete", len(files))
		return
	}
	c.logger.Info("Cleanup completed successfully",
		"path", basePath,
		"initial_usage_percent", initialUsage,
		"final_usage_percent", finalUsage,
		"usage_reduction", usageReduction,
		"deleted_count", deletedCount,
		"freed_space", bytesize.Human(freedSpace))
}
