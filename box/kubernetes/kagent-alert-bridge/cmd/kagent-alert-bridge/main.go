// Command kagent-alert-bridge receives Alertmanager webhooks, posts each
// alert to Slack, asks a kagent agent to investigate it over A2A, and replies
// with the analysis in the alert's thread.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/a2a"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/bridge"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/config"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/observability"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/slack"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/version"
)

// drainMargin is added to the analysis deadline to form the shutdown drain
// timeout, so a run that already cost Bedrock tokens still gets its Slack
// reply posted. The margin covers the reply's own Slack calls.
const drainMargin = 30 * time.Second

func main() {
	cfg, err := config.Load()
	if err != nil {
		// Config failed to load, so log the error with the default
		// level and format to keep the output structured.
		newLogger("info", "json").Error("configuration error", "error", err)
		os.Exit(1)
	}
	logger := newLogger(cfg.LogLevel, cfg.LogFormat)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg, logger); err != nil {
		logger.Error("bridge failed", "error", err)
		os.Exit(1)
	}
}

// run wires the bridge and HTTP servers and blocks until ctx is cancelled.
func run(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	logger.Info("starting kagent-alert-bridge",
		"version", version.Version, "commit", version.Commit,
		"go_version", strings.TrimPrefix(runtime.Version(), "go"),
		"kagent_url", cfg.KagentURL, "kagent_namespace", cfg.KagentNamespace,
		"agents", strings.Join(cfg.Agents(), ","), "default_agent", cfg.KagentAgent,
		"agent_routing_label", cfg.KagentAgentRoutingLabel, "agent_timeout", cfg.KagentTimeout.String(),
		"default_channel", cfg.SlackChannel, "parent_mode", cfg.ParentMode,
		"webhook_path", cfg.WebhookPath,
		"listen_port", cfg.ListenPort, "metrics_port", cfg.MetricsPort)
	if cfg.ParentMode == config.ParentModeLookup {
		logger.Info("alertmanager owns the alert notification; the bridge only threads under it",
			"lookup_window", cfg.LookupWindow.String(), "lookup_attempts", cfg.LookupAttempts,
			"required_scopes", "chat:write, channels:history, channels:read (groups:* for private channels, reactions:write for reactions)")
	}
	logger.Info("analysis policy",
		"severities", severityList(cfg), "analyze_label", cfg.AnalyzeLabel,
		"analyze_resolved", cfg.AnalyzeResolved, "dedupe_ttl", cfg.DedupeTTL.String(),
		"max_concurrent", cfg.MaxConcurrent)
	if cfg.WebhookToken == "" {
		logger.Warn("webhook authentication disabled", "hint", "set WEBHOOK_BEARER_TOKEN to require a bearer token")
	}

	metrics := observability.NewMetrics()
	metrics.RegisterBuildInfo(version.Version, version.Commit)

	slackClient := slack.New(cfg.SlackAPIURL, cfg.SlackToken, 30*time.Second, metrics, logger)
	agent := a2a.New(cfg.KagentURL, cfg.KagentNamespace, cfg.KagentUserID, cfg.KagentRequestTimeout, cfg.KagentPollInterval, metrics, logger)
	b := bridge.New(cfg, slackClient, agent, metrics, logger)

	go func() {
		if err := observability.ServeMetrics(ctx, cfg.MetricsPort, metrics.Registry(), logger); err != nil {
			logger.Error("metrics server failed", "error", err)
		}
	}()

	if err := observability.Serve(ctx, cfg.ListenPort, b.Handler(), logger); err != nil {
		return err
	}

	// The listener is closed, so no new analysis can start. Anything already
	// running still owes a Slack reply, so wait for it before exiting. The
	// pod's terminationGracePeriodSeconds must exceed this drain window.
	drainTimeout := cfg.KagentTimeout + drainMargin
	logger.Info("draining in-flight analyses", "timeout", drainTimeout.String())
	if !b.Wait(drainTimeout) {
		logger.Warn("shutdown timed out with analyses still running", "timeout", drainTimeout.String())
		return nil
	}
	logger.Info("shutdown complete")
	return nil
}

func severityList(cfg config.Config) string {
	if len(cfg.AnalyzeSeverities) == 0 {
		return "all"
	}
	items := make([]string, 0, len(cfg.AnalyzeSeverities))
	for severity := range cfg.AnalyzeSeverities {
		items = append(items, severity)
	}
	return strings.Join(items, ",")
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
