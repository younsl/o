// Command filesystem-cleaner monitors disk usage of target paths and deletes
// matching files when usage exceeds a threshold. It runs as a Kubernetes
// init container (once mode) or sidecar (interval mode).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/cleaner"
	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/config"
	"github.com/younsl/o/box/kubernetes/filesystem-cleaner/internal/version"
)

func main() {
	os.Exit(run())
}

func run() int {
	cfg, err := config.Parse(os.Args[1:], os.Stderr)
	if err != nil {
		if errors.Is(err, config.ErrVersion) {
			fmt.Printf("filesystem-cleaner %s\ncommit: %s\n", version.Version, version.Commit)
			return 0
		}
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintln(os.Stderr, err)
		return 2
	}

	level, err := cfg.SlogLevel()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(logger)

	logger.Info("Starting filesystem-cleaner",
		"version", version.Version,
		"commit", version.Commit)
	logger.Info("Configuration loaded",
		"target_paths", cfg.TargetPaths,
		"usage_threshold_percent", cfg.UsageThresholdPercent,
		"cleanup_mode", string(cfg.CleanupMode),
		"include_patterns", cfg.IncludePatterns,
		"exclude_patterns", cfg.ExcludePatterns,
		"dry_run", cfg.DryRun,
		"log_level", cfg.LogLevel,
		"check_interval_minutes", cfg.CheckIntervalMinutes)

	if cfg.DryRun {
		logger.Warn("Running in DRY-RUN mode - no files will be deleted")
	}

	c, err := cleaner.New(cfg, logger)
	if err != nil {
		logger.Error("Failed to create cleaner", "error", err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		c.Stop()
	}()

	if err := c.Run(ctx); err != nil {
		logger.Error("Failed to run cleaner", "error", err)
		return 1
	}
	return 0
}
