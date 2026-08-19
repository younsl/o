// Command kagent-gateway receives Alertmanager webhooks, posts each
// alert to Slack, asks a kagent agent to investigate it over A2A, and replies
// with the analysis in the alert's thread.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/a2a"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/config"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/gateway"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/observability"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/slack"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/socket"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/version"
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
		logger.Error("gateway failed", "error", err)
		os.Exit(1)
	}
}

// run wires the gateway and HTTP servers and blocks until ctx is cancelled.
func run(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	logger.Info("starting kagent-gateway",
		"version", version.Version, "commit", version.Commit,
		"go_version", strings.TrimPrefix(runtime.Version(), "go"),
		"kagent_url", cfg.KagentURL, "kagent_namespace", cfg.KagentNamespace,
		"agents", strings.Join(cfg.Agents(), ","), "default_agent", cfg.KagentAgent,
		"agent_routing_label", cfg.KagentAgentRoutingLabel, "agent_timeout", cfg.KagentTimeout.String(),
		"default_channel", cfg.SlackChannel, "parent_mode", cfg.ParentMode,
		"webhook_path", cfg.WebhookPath,
		"listen_port", cfg.ListenPort, "metrics_port", cfg.MetricsPort)
	if cfg.ParentMode == config.ParentModeLookup {
		logger.Info("alertmanager owns the alert notification; the gateway only threads under it",
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
	b := gateway.New(cfg, slackClient, agent, metrics, logger)

	if cfg.ChatEnabled() {
		startChat(ctx, cfg, slackClient, b, metrics, logger)
	}

	go func() {
		if err := observability.ServeMetrics(ctx, cfg.MetricsPort, metrics.Registry(), logger); err != nil {
			logger.Error("metrics server failed", "error", err)
		}
	}()

	if err := observability.Serve(ctx, cfg.ListenPort, b.Handler(), logger); err != nil {
		return err
	}

	// The listener is closed, so no new analysis can start. Anything already
	// running still owes a Slack reply, so wait for it before exiting. A
	// mention turn has its own deadline, so the drain covers whichever is
	// longer. The pod's terminationGracePeriodSeconds must exceed this window.
	drainTimeout := cfg.KagentTimeout + drainMargin
	if cfg.ChatEnabled() {
		drainTimeout = max(cfg.KagentTimeout, cfg.ChatTimeout) + drainMargin
	}
	logger.Info("draining in-flight runs", "timeout", drainTimeout.String())
	if !b.Wait(drainTimeout) {
		logger.Warn("shutdown timed out with runs still in flight", "timeout", drainTimeout.String())
		return nil
	}
	logger.Info("shutdown complete")
	return nil
}

// startChat resolves the bot identity and opens the Socket Mode connection that
// carries mentions. Neither failure is fatal: the alert path must keep working
// when Slack cannot be reached, so the connection retries in the background and
// an unresolved bot id only leaves the loop guard resting on bot_id alone.
func startChat(ctx context.Context, cfg config.Config, slackClient *slack.Client, b *gateway.Gateway, metrics *observability.Metrics, logger *slog.Logger) {
	logger.Info("mention invocation enabled",
		"chat_agent", cfg.ChatAgent, "chat_timeout", cfg.ChatTimeout.String(),
		"session_ttl", cfg.ChatSessionTTL.String(), "status_interval", cfg.ChatStatusInterval.String(),
		"max_concurrent_chats", cfg.MaxConcurrentChats,
		"channels", channelList(cfg), "required_scopes", "app_mentions:read, chat:write, reactions:write")
	// The two allow list states differ in who can spend agent tokens, so each
	// gets its own line rather than a value a reader has to interpret.
	if len(cfg.ChatAllowedUsers) == 0 {
		logger.Warn("mention user allow list disabled; every member of the allowed channels can invoke the agent",
			"allowed_user_count", 0,
			"hint", "set CHAT_ALLOWED_USERS to a comma-separated list of Slack member IDs")
	} else {
		// Unlike a channel drop, a denied user gets no ephemeral hint, so a
		// mention that never comes back looks the same as an outage. Saying so
		// here is what turns such a report into a config answer.
		logger.Info("mention user allow list enforced; a Slack user outside the list gets no reply and no hint",
			"allowed_user_count", len(cfg.ChatAllowedUsers), "allowed_users", allowedUserList(cfg))
	}

	authCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if id, err := slackClient.AuthTest(authCtx); err != nil {
		logger.Warn("failed to resolve the bot user id; the mention loop guard falls back to bot_id alone", "error", err)
	} else {
		b.SetBotUserID(id)
		logger.Info("resolved bot identity", "bot_user_id", id)
	}

	sock := socket.New(cfg.SlackAPIURL, cfg.SlackAppToken, metrics, logger)
	go func() {
		if err := sock.Run(ctx, b); err != nil {
			logger.Error("socket mode listener failed", "error", err)
		}
	}()
}

// channelList renders the chat channel allow list for the startup log, where an
// empty list is worth spelling out: it means every channel the bot is in.
func channelList(cfg config.Config) string {
	if len(cfg.ChatChannels) == 0 {
		return "all"
	}
	return strings.Join(cfg.ChatChannels, ",")
}

// allowedUserList renders the chat member ID allow list for the startup log.
// The IDs are sorted so the line is stable across restarts. An empty list has
// no rendering because its caller logs a different message entirely.
func allowedUserList(cfg config.Config) string {
	items := make([]string, 0, len(cfg.ChatAllowedUsers))
	for user := range cfg.ChatAllowedUsers {
		items = append(items, user)
	}
	sort.Strings(items)
	return strings.Join(items, ",")
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
