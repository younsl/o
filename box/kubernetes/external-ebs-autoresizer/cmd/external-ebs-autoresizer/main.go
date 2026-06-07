// Command external-ebs-autoresizer continuously watches tagged standalone EC2
// instances and grows their root EBS volume and ext4 filesystem when usage
// crosses a threshold.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/controller"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/events"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/leader"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/observability"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/resizer"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/version"
)

func main() {
	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		slog.Error("configuration error", "error", err)
		os.Exit(1)
	}

	logger := newLogger(cfg.LogLevel, cfg.LogFormat)
	logger.Info("starting external-ebs-autoresizer",
		"version", version.Version, "commit", version.Commit,
		"region", cfg.Region, "reconcile_interval", cfg.ReconcileInterval.String(),
		"threshold_percent", cfg.UsageThresholdPercent, "grow_percent", cfg.GrowPercent,
		"dry_run", cfg.DryRun)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	clients, err := awsx.New(ctx, cfg.Region)
	if err != nil {
		logger.Error("failed to initialize AWS clients", "error", err)
		os.Exit(1)
	}

	metrics := observability.NewMetrics()
	health := observability.NewHealth()

	// Kubernetes Events about resize attempts attach to this controller's own
	// Pod. Disabled gracefully when not running in-cluster (no downward API).
	// Keep the interface nil (not a typed nil) when disabled so the resizer's
	// nil check works.
	var emitter resizer.EventEmitter
	if cfg.PodName != "" {
		e, err := events.New(cfg.PodName, cfg.PodNamespace, cfg.PodUID)
		if err != nil {
			logger.Warn("Kubernetes Event publishing disabled", "error", err)
		} else {
			emitter = e
			defer e.Shutdown()
		}
	} else {
		logger.Info("POD_NAME unset; Kubernetes Event publishing disabled")
	}

	go func() {
		if err := health.Serve(ctx, cfg.HealthPort); err != nil {
			logger.Error("health server failed", "error", err)
		}
	}()
	go func() {
		if err := metrics.Serve(ctx, cfg.MetricsPort); err != nil {
			logger.Error("metrics server failed", "error", err)
		}
	}()

	rsz := resizer.New(cfg, clients, clients, metrics, emitter, logger)
	health.SetReady(true)

	runLoop := func(ctx context.Context) {
		controller.Run(ctx, cfg.ReconcileInterval, func(ctx context.Context) error {
			metrics.ObserveReconcile()
			return rsz.Reconcile(ctx)
		}, logger)
	}

	// Leader election lets the Deployment scale to multiple replicas for HA
	// while only the leader reconciles. Requires in-cluster config; fall back to
	// running directly when disabled or outside a cluster.
	if cfg.LeaderElect && cfg.PodName != "" {
		err = leader.Run(ctx, leader.Config{
			Identity:  cfg.PodName,
			Namespace: cfg.PodNamespace,
			LeaseName: cfg.LeaseName,
		}, logger, runLoop)
		if err != nil {
			logger.Error("leader election failed", "error", err)
			os.Exit(1)
		}
	} else {
		if cfg.LeaderElect {
			logger.Info("POD_NAME unset; leader election disabled, running directly")
		}
		runLoop(ctx)
	}

	health.SetReady(false)
	logger.Info("shutdown complete")
}

func newLogger(level, format string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	var handler slog.Handler
	if strings.ToLower(format) == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(handler)
}
