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
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/alertmanager"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/controller"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/events"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/grafana"
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
		"dry_run", cfg.DryRun)
	logResizePolicy(logger, cfg)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	clients, err := awsx.New(ctx, cfg.Region)
	if err != nil {
		logger.Error("failed to initialize AWS clients", "error", err)
		os.Exit(1)
	}
	clients.PollInterval = cfg.SSMPollInterval

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

	// Alertmanager alerting about resize attempts. Disabled unless explicitly
	// enabled. Keep the interface nil (not a typed nil) when disabled so the
	// resizer's nil check works.
	var notifier resizer.AlertNotifier
	if cfg.AlertmanagerEnabled {
		amClient := alertmanager.New(cfg.AlertmanagerURL, cfg.AlertmanagerTimeout, cfg.AlertmanagerLabels, cfg.AlertmanagerDashboardURL, logger)
		logger.Info("Alertmanager alerting enabled", "url", cfg.AlertmanagerURL, "notify_on", cfg.AlertmanagerNotifyOn)
		runPreflight(ctx, logger, "alertmanager", amClient)
		notifier = amClient
	} else {
		logger.Info("Alertmanager alerting disabled")
	}

	// Grafana annotations about resize attempts. Disabled unless explicitly
	// enabled. Keep the interface nil (not a typed nil) when disabled so the
	// resizer's nil check works. The API token is never logged.
	var annotator resizer.Annotator
	if cfg.GrafanaAnnotationEnabled {
		gfClient := grafana.New(cfg.GrafanaURL, cfg.GrafanaAPIToken, cfg.GrafanaTimeout, cfg.GrafanaAnnotationTags, logger)
		logger.Info("Grafana annotations enabled", "url", cfg.GrafanaURL, "annotate_on", cfg.GrafanaAnnotateOn, "tags", cfg.GrafanaAnnotationTags)
		runPreflight(ctx, logger, "grafana", gfClient)
		annotator = gfClient
	} else {
		logger.Info("Grafana annotations disabled")
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

	rsz := resizer.New(cfg, clients, clients, metrics, emitter, notifier, annotator, logger)
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

// preflightAttempts is how many times a startup connectivity check is tried
// before it is reported as failed. preflightBackoff is the delay between tries.
const preflightAttempts = 3

// preflightBackoff is the delay between preflight retries. It is a var so tests
// can shorten it.
var preflightBackoff = 2 * time.Second

// preflighter performs a one-time startup connectivity check, returning the
// checked endpoint, the HTTP status, the request latency, and an error.
type preflighter interface {
	Preflight(ctx context.Context) (string, int, time.Duration, error)
}

// runPreflight runs a best-effort startup connectivity check, retrying up to
// preflightAttempts times, and logs the outcome (endpoint, status, latency).
// It never blocks startup: a persistent failure is logged at error level so
// misconfiguration is visible immediately, but the controller still starts
// because alerting and annotations are auxiliary to the core resize loop.
func runPreflight(ctx context.Context, logger *slog.Logger, name string, p preflighter) {
	for attempt := 1; attempt <= preflightAttempts; attempt++ {
		pctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		endpoint, status, latency, err := p.Preflight(pctx)
		cancel()
		if err == nil {
			logger.Info(name+" preflight check succeeded",
				"endpoint", endpoint, "status", status,
				"latency", latency.Round(time.Millisecond).String(), "attempt", attempt)
			return
		}
		if attempt < preflightAttempts {
			logger.Warn(name+" preflight check failed, retrying",
				"endpoint", endpoint, "status", status,
				"latency", latency.Round(time.Millisecond).String(),
				"attempt", attempt, "max_attempts", preflightAttempts, "error", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(preflightBackoff):
			}
			continue
		}
		logger.Error(name+" preflight check failed",
			"endpoint", endpoint, "status", status,
			"latency", latency.Round(time.Millisecond).String(),
			"attempts", preflightAttempts, "error", err)
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
