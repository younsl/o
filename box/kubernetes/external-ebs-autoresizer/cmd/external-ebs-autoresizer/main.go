// Command external-ebs-autoresizer continuously watches tagged standalone EC2
// instances and grows their root EBS volume and filesystem (ext2/3/4 or XFS)
// when usage crosses a threshold.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"k8s.io/klog/v2"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/controller"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/leader"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/observability"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/policy"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/resizer"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/version"
)

func main() {
	if err := newRootCommand().Execute(); err != nil {
		os.Exit(1)
	}
}

// runDaemon loads the config at path and runs the controller until signalled.
func runDaemon(configFile string) error {
	cfg, err := config.Load(configFile)
	if err != nil {
		slog.Error("configuration error", "file", configFile, "error", err)
		return err
	}

	logger := newLogger(cfg.LogLevel, cfg.LogFormat)
	// Standardize every log line on this slog handler: our own packages log
	// through the injected logger, any library using the slog default picks it
	// up via SetDefault, and client-go (leader election, event broadcaster)
	// logs through klog, which is routed to the same handler here. Without the
	// klog routing, lease renewal failures would bypass the JSON format and
	// land unstructured on stderr.
	slog.SetDefault(logger)
	klog.SetSlogLogger(logger)
	logger.Info("starting external-ebs-autoresizer",
		"version", version.Version, "commit", version.Commit,
		"region", cfg.Region, "reconcile_interval", cfg.ReconcileInterval.String(),
		"dry_run", cfg.DryRun)
	logResizePolicy(logger, cfg)

	// Per-instance-group resize policies. Validation failures are fatal so a
	// broken policy entry never silently falls back to the global settings.
	resolver, err := policy.New(cfg)
	if err != nil {
		logger.Error("policy configuration error", "file", configFile, "error", err)
		return err
	}
	if resolver.Len() > 0 {
		logger.Info("instance-group resize policies loaded",
			"count", resolver.Len(), "policies", resolver.Summaries())
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	clients, err := awsx.New(ctx, cfg.Region)
	if err != nil {
		logger.Error("failed to initialize AWS clients", "error", err)
		return err
	}
	clients.PollInterval = cfg.SSMPollInterval

	metrics := observability.NewMetrics()
	health := observability.NewHealth()

	snk := buildSinks(ctx, cfg, logger)
	defer snk.shutdown()

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

	rsz := resizer.New(cfg, resolver, clients, clients, metrics, snk.emitter, snk.notifier, snk.annotator, logger)
	health.SetReady(true)

	runLoop := func(ctx context.Context) {
		controller.Run(ctx, cfg.ReconcileInterval, func(ctx context.Context) (int, error) {
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
			return err
		}
	} else {
		if cfg.LeaderElect {
			logger.Info("POD_NAME unset; leader election disabled, running directly")
		}
		runLoop(ctx)
	}

	health.SetReady(false)
	logger.Info("shutdown complete")
	return nil
}

// logResizePolicy logs the effective volume growth policy (mode and amount) at
// INFO so the resize behavior is unambiguous in the Pod's startup logs. In
// percent mode it reports the growth percentage; in absolute mode it reports
// the fixed GiB increment (and the raw configured value).
func logResizePolicy(logger *slog.Logger, cfg *config.Config) {
	switch cfg.GrowMode {
	case config.GrowModeAbsolute:
		logger.Info("Resize policy has been configured to grow each volume by a fixed absolute amount once root filesystem usage crosses the threshold",
			"grow_mode", cfg.GrowMode,
			"grow_amount", cfg.GrowAmount,
			"grow_amount_gib", cfg.GrowAmountGiB,
			"usage_threshold_percent", cfg.UsageThresholdPercent,
			"max_volume_size_gib", cfg.MaxVolumeSizeGiB)
	default:
		logger.Info("Resize policy has been configured to grow each volume by a percentage of its current size once root filesystem usage crosses the threshold",
			"grow_mode", cfg.GrowMode,
			"grow_percent", cfg.GrowPercent,
			"usage_threshold_percent", cfg.UsageThresholdPercent,
			"max_volume_size_gib", cfg.MaxVolumeSizeGiB)
	}
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
