// Package controller runs the periodic reconcile loop for the long-running
// process.
package controller

import (
	"context"
	"log/slog"
	"time"
)

// ReconcileFunc performs one reconcile pass.
type ReconcileFunc func(ctx context.Context) error

// Run executes fn immediately, then on every interval tick, until ctx is
// cancelled. Per-pass errors are logged and do not stop the loop.
func Run(ctx context.Context, interval time.Duration, fn ReconcileFunc, logger *slog.Logger) {
	reconcile := func() {
		start := time.Now()
		if err := fn(ctx); err != nil {
			logger.Error("reconcile pass failed", "error", err, "elapsed", time.Since(start).String())
			return
		}
		logger.Info("reconcile pass completed", "elapsed", time.Since(start).String())
	}

	reconcile()

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("controller shutting down")
			return
		case <-ticker.C:
			reconcile()
		}
	}
}
