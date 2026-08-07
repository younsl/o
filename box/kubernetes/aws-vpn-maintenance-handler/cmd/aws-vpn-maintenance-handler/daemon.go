package main

import (
	"context"
	"fmt"
	"log/slog"
	"os/signal"
	"runtime"
	"strings"
	"syscall"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/klog/v2"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/approval"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/config"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/controller"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/events"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/executor"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/leader"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/observability"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/promx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/state"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/version"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/window"
)

// buildTrafficGate compiles the traffic gate. A disabled gate needs no client, so
// nothing is dialed and no endpoint is required.
func buildTrafficGate(cfg *config.Config, logger *slog.Logger) (*promx.Gate, error) {
	t := cfg.TrafficGate
	onError, err := promx.ParseOnError(t.OnError)
	if err != nil {
		return nil, err
	}

	var client *promx.Client
	if t.Enabled {
		client, err = promx.New(promx.Config{
			Endpoint: t.Endpoint,
			Headers:  t.Headers,
			Timeout:  t.Timeout.D(),
		})
		if err != nil {
			return nil, err
		}
		logger.Info("traffic gate enabled",
			"endpoint", t.Endpoint, "quiet_percentile", t.QuietPercentile, "on_error", string(onError))
	} else {
		logger.Info("traffic gate disabled; replacements are gated only by the window and the peer checks")
	}

	return promx.NewGate(client, promx.GateConfig{
		Enabled:    t.Enabled,
		Percentile: t.QuietPercentile,
		OnError:    onError,
	}, logger)
}

// runDaemon loads the config and runs the controller until signalled.
func runDaemon(configFile string) error {
	cfg, err := config.Load(configFile)
	if err != nil {
		slog.Error("configuration error", "file", configFile, "error", err)
		return err
	}

	logger := newLogger(cfg.LogLevel, cfg.LogFormat)
	// Standardize every log line on this handler, including client-go's klog
	// output. Without the klog routing, lease renewal failures would bypass the
	// JSON format and land unstructured on stderr.
	slog.SetDefault(logger)
	klog.SetSlogLogger(logger)

	win, err := window.New(window.Config{
		Timezone:     cfg.MaintenanceWindow.Timezone,
		CronSchedule: cfg.MaintenanceWindow.CronSchedule,
		Duration:     cfg.MaintenanceWindow.Duration.D(),
		MinRemaining: cfg.MaintenanceWindow.MinRemaining.D(),
	})
	if err != nil {
		logger.Error("invalid maintenance window", "error", err)
		return err
	}

	logger.Info("starting aws-vpn-maintenance-handler",
		"version", version.Version, "commit", version.Commit,
		"go_version", strings.TrimPrefix(runtime.Version(), "go"),
		"region", cfg.Region, "reconcile_interval", cfg.ReconcileInterval.String(),
		"dry_run", cfg.DryRun, "maintenance_window", win.String(),
		"approvers", len(cfg.Approval.SlackUserIDs))
	if cfg.DryRun {
		logger.Warn("dry run is enabled: approvals will validate ReplaceVpnTunnel through the AWS DryRun flag " +
			"and no tunnel will actually be replaced")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	vpn, err := awsx.New(ctx, cfg.Region)
	if err != nil {
		logger.Error("failed to initialize the AWS client", "error", err)
		return err
	}

	restCfg, err := rest.InClusterConfig()
	if err != nil {
		return fmt.Errorf("in-cluster config: %w", err)
	}
	kube, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return fmt.Errorf("kubernetes client: %w", err)
	}

	gate, err := buildTrafficGate(cfg, logger)
	if err != nil {
		logger.Error("invalid traffic gate configuration", "error", err)
		return err
	}

	if err := verifyDependencies(ctx, cfg, vpn, gate, logger); err != nil {
		return err
	}

	metrics := observability.NewMetrics()
	health := observability.NewHealth()
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

	slackClient := slackx.New(cfg.SlackBotToken, cfg.SlackAppToken, logger)
	// Checked at startup so a revoked token fails visibly rather than when
	// maintenance is first queued.
	botUser, err := slackClient.AuthTest(ctx)
	if err != nil {
		logger.Error("Slack bot token rejected", "error", err)
		return err
	}
	dmChannels, err := slackClient.OpenDMs(ctx, cfg.Approval.SlackUserIDs)
	if err != nil {
		logger.Error("could not open a DM channel with any approver", "error", err)
		return err
	}
	// Names, not just IDs: a change to the approver list is reviewed as a list of
	// opaque IDs, and this log line is where that gets checked against people.
	logger.Info("Slack ready", "bot_user", botUser, "dm_channels", len(dmChannels),
		"approvers", formatApprovers(slackClient.ResolveApprovers(ctx, cfg.Approval.SlackUserIDs)))

	broker := approval.New(cfg.Approval.SlackUserIDs, logger)
	go func() {
		if err := slackClient.RunSocket(ctx, broker.Handle, health.SetSlackConnected); err != nil {
			logger.Error("Slack Socket Mode loop failed", "error", err)
		}
	}()

	emitter, err := events.New(kube, cfg.PodName, cfg.PodNamespace, cfg.PodUID)
	if err != nil {
		logger.Error("failed to initialize the Kubernetes event emitter", "error", err)
		return err
	}
	defer emitter.Shutdown()

	ctrl := controller.New(controller.Options{
		Config: cfg,
		AWS:    vpn,
		Exec: executor.New(vpn, executor.Options{
			VerifyTimeout:     cfg.Safety.VerifyTimeout.D(),
			PollInterval:      cfg.Safety.VerifyPollInterval.D(),
			MinAcceptedRoutes: cfg.Safety.PeerMinAcceptedRoutes,
			Heartbeat:         cfg.Approval.ProgressHeartbeat.D(),
		}, logger),
		Store:      state.NewStore(kube, cfg.PodNamespace, cfg.StateConfigMapName),
		Slack:      slackClient,
		Broker:     broker,
		Window:     win,
		Traffic:    gate,
		Metrics:    metrics,
		Events:     emitter,
		Logger:     logger,
		DMChannels: dmChannels,
	})

	// Printed before leader election so every replica states what it would act on.
	// A wrong tag filter and a tunnel without lifecycle control both otherwise look
	// like a controller with nothing to do.
	ctrl.LogScope(ctx)

	health.SetReady(true)

	// A safety requirement, not an availability feature: two active replicas could
	// each replace a different tunnel of the same connection.
	if cfg.LeaderElect {
		if err := leader.Run(ctx, kube, leader.Config{
			Identity:  cfg.PodName,
			Namespace: cfg.PodNamespace,
			LeaseName: cfg.LeaseName,
		}, logger, ctrl.Run); err != nil {
			logger.Error("leader election failed", "error", err)
			return err
		}
	} else {
		logger.Warn("leader election is disabled; run exactly one replica or two replicas " +
			"could replace both tunnels of one connection at once")
		ctrl.Run(ctx)
	}

	health.SetReady(false)
	logger.Info("shutdown complete")
	return nil
}
