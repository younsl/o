package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/alertmanager"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/events"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/grafana"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/resizer"
)

// This file wires the optional observation sinks (Kubernetes Events,
// Alertmanager alerts, Grafana annotations) from config. Each builder returns
// a nil interface (never a typed nil) when its sink is disabled, so the
// resizer's nil checks work. Adding a sink means adding one builder here and
// one field to sinks.

// sinks bundles the optional per-outcome observation sinks handed to the
// resizer. Any field may be nil when the corresponding sink is disabled.
type sinks struct {
	emitter   resizer.EventEmitter
	notifier  resizer.AlertNotifier
	annotator resizer.Annotator
	shutdown  func()
}

// buildSinks constructs every configured sink and returns them with a single
// shutdown hook that flushes whatever needs flushing.
func buildSinks(ctx context.Context, cfg *config.Config, logger *slog.Logger) sinks {
	s := sinks{shutdown: func() {}}

	// Kubernetes Events about resize attempts attach to this controller's own
	// Pod. Disabled gracefully when not running in-cluster (no downward API).
	if cfg.PodName != "" {
		e, err := events.New(cfg.PodName, cfg.PodNamespace, cfg.PodUID)
		if err != nil {
			logger.Warn("Kubernetes Event publishing disabled", "error", err)
		} else {
			s.emitter = e
			s.shutdown = e.Shutdown
		}
	} else {
		logger.Info("POD_NAME unset; Kubernetes Event publishing disabled")
	}

	// Alertmanager alerting about resize attempts. Disabled unless explicitly
	// enabled.
	if cfg.AlertmanagerEnabled {
		amClient := alertmanager.New(cfg.AlertmanagerURL, cfg.AlertmanagerTimeout, cfg.AlertmanagerLabels, cfg.AlertmanagerDashboardURL, logger)
		logger.Info("Alertmanager alerting enabled", "url", cfg.AlertmanagerURL, "notify_on", cfg.AlertmanagerNotifyOn)
		runPreflight(ctx, logger, "alertmanager", amClient)
		s.notifier = amClient
	} else {
		logger.Info("Alertmanager alerting disabled")
	}

	// Grafana annotations about resize attempts. Disabled unless explicitly
	// enabled. The API token is never logged.
	if cfg.GrafanaAnnotationEnabled {
		gfClient := grafana.New(cfg.GrafanaURL, cfg.GrafanaAPIToken, cfg.GrafanaTimeout, cfg.GrafanaAnnotationTags, logger)
		logger.Info("Grafana annotations enabled", "url", cfg.GrafanaURL, "annotate_on", cfg.GrafanaAnnotateOn, "tags", cfg.GrafanaAnnotationTags)
		runPreflight(ctx, logger, "grafana", gfClient)
		s.annotator = gfClient
	} else {
		logger.Info("Grafana annotations disabled")
	}

	return s
}

// preflightAttempts is how many times a startup connectivity check is tried
// before it is reported as failed.
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
