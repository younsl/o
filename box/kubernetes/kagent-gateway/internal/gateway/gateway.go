// Package gateway turns an Alertmanager webhook into a Slack thread: the alert
// is posted as the parent message, and the agent's analysis is posted as a
// reply under it.
package gateway

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/a2a"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/alert"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/config"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/observability"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/slack"
)

// maxWebhookBody caps the request body. Alertmanager truncates large groups
// itself, so anything past this is a misconfiguration rather than a real alert.
const maxWebhookBody = 4 << 20

// investigatingMessage renders the thread note that tells readers an analysis
// is underway. It names the agent and the analysis deadline, so the on-call
// engineer knows who is investigating and how long to wait before treating
// silence as a gateway failure. It accompanies the investigating reaction, so
// it is only posted when the reactions are enabled.
func investigatingMessage(agent string, timeout time.Duration) string {
	return fmt.Sprintf("kagent의 %s 에이전트가 조사를 시작했습니다. 최대 %s 내 원인 분석 결과 또는 실패 사유가 이 스레드에 게시됩니다.",
		agent, koreanDuration(timeout))
}

// koreanDuration renders a duration the way the message's Korean sentence
// expects, dropping zero components: 300s -> "5분", 90s -> "1분 30초".
func koreanDuration(d time.Duration) string {
	d = d.Round(time.Second)
	minutes := int(d.Minutes())
	seconds := int(d.Seconds()) - minutes*60
	switch {
	case minutes > 0 && seconds > 0:
		return fmt.Sprintf("%d분 %d초", minutes, seconds)
	case minutes > 0:
		return fmt.Sprintf("%d분", minutes)
	default:
		return fmt.Sprintf("%d초", seconds)
	}
}

// AgentClient runs one request on an agent and returns its reply.
type AgentClient interface {
	Send(ctx context.Context, req a2a.Request) (a2a.Result, error)
}

// SlackClient posts messages, locates an existing one to thread under, manages
// the investigating reaction on the alert notification, and rewrites the
// mention path's status message in place.
type SlackClient interface {
	Post(ctx context.Context, msg slack.Message) (string, error)
	Update(ctx context.Context, channel, ts, text string) error
	PostEphemeral(ctx context.Context, channel, threadTS, user, text string) error
	FindThreadParent(ctx context.Context, channel, marker string, since time.Time) (string, error)
	ThreadParent(ctx context.Context, channel, threadTS string) (slack.ThreadMessage, error)
	AddReaction(ctx context.Context, channel, ts, name string) error
	RemoveReaction(ctx context.Context, channel, ts, name string) error
	ResolveChannelID(ctx context.Context, channel string) (string, error)
}

// Gateway holds the wiring shared by every webhook request and every mention.
type Gateway struct {
	cfg     config.Config
	slack   SlackClient
	agent   AgentClient
	metrics *observability.Metrics
	logger  *slog.Logger
	store   *store
	sem     chan struct{}
	wg      sync.WaitGroup
	now     func() time.Time
	// lookupBackoff is the base wait between parent lookups, scaled by the
	// attempt number.
	lookupBackoff time.Duration

	// Mention invocation. chatSem is deliberately separate from sem: sharing
	// one would let a question queue behind an alert analysis, or worse, delay
	// an analysis behind questions.
	chatSem   chan struct{}
	sessions  *sessionStore
	envelopes *store
	// botUserID is the bot's own user id, resolved once at startup. It is the
	// loop guard: the gateway posts into the channels it listens to.
	botUserID string
}

// New wires a Gateway. The caller owns the lifecycle of slackClient and agent.
func New(cfg config.Config, slackClient SlackClient, agent AgentClient, metrics *observability.Metrics, logger *slog.Logger) *Gateway {
	// Publishing the limits as series lets a dashboard express saturation as
	// inflight over slots, without the query repeating a value that lives in the
	// deployment's environment.
	metrics.AnalysisSlots.Set(float64(cfg.MaxConcurrent))
	metrics.ChatSlots.Set(float64(cfg.MaxConcurrentChats))
	return &Gateway{
		cfg:           cfg,
		slack:         slackClient,
		agent:         agent,
		metrics:       metrics,
		logger:        logger,
		store:         newStore(cfg.DedupeTTL),
		sem:           make(chan struct{}, cfg.MaxConcurrent),
		now:           time.Now,
		lookupBackoff: 2 * time.Second,
		chatSem:       make(chan struct{}, max(cfg.MaxConcurrentChats, 1)),
		sessions:      newSessionStore(cfg.ChatSessionTTL),
		envelopes:     newStore(envelopeTTL),
	}
}

// SetBotUserID records the bot's own user id for the mention loop guard.
// Resolution needs a Slack call, so it is done by the caller at startup rather
// than inside New, and a failure there only weakens the guard: a message the
// app posted still carries a bot id.
func (g *Gateway) SetBotUserID(id string) { g.botUserID = id }

// Handler returns the mux serving the webhook and the health endpoints.
func (g *Gateway) Handler() http.Handler {
	mux := observability.Health{}.Handler()
	mux.HandleFunc("POST "+g.cfg.WebhookPath, g.handleWebhook)
	return mux
}

// Wait blocks until every in-flight analysis finishes or timeout elapses.
// It reports whether the drain completed, so shutdown can log a truthful
// message instead of claiming a clean stop it did not achieve.
func (g *Gateway) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		g.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (g *Gateway) handleWebhook(w http.ResponseWriter, r *http.Request) {
	// Alertmanager retries a receiver that answers too slowly, so the handler's
	// own latency is worth watching even though the analysis runs detached.
	started := g.now()
	defer func() { g.metrics.WebhookDuration.Observe(g.now().Sub(started).Seconds()) }()

	if !g.authorized(r) {
		g.metrics.WebhooksReceived.WithLabelValues("unauthorized").Inc()
		g.logger.Warn("rejected webhook", "reason", "bad bearer token", "remote_addr", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var payload alert.Payload
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWebhookBody)).Decode(&payload); err != nil {
		g.metrics.WebhooksReceived.WithLabelValues("bad_request").Inc()
		g.logger.Error("failed to decode webhook payload", "error", err)
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	if len(payload.Alerts) == 0 {
		g.metrics.WebhooksReceived.WithLabelValues("empty").Inc()
		g.logger.Warn("webhook carried no alerts", "group_key", payload.GroupKey, "receiver", payload.Receiver)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	g.countAlerts(payload)

	logger := g.logger.With(
		"alertname", payload.Name(),
		"severity", payload.Severity(),
		"cluster", payload.Cluster(),
		"status", payload.Status,
		"group_key", payload.GroupKey,
		"alert_count", len(payload.Alerts),
	)
	channel := g.resolveChannel(payload)
	agent := g.resolveAgent(payload)
	logger = logger.With("channel", channel, "agent", agent)

	// In lookup mode Alertmanager owns the notification, so an alert nobody
	// analyses costs the gateway nothing at all.
	var threadTS string
	if g.cfg.ParentMode == config.ParentModePost {
		ts, err := g.slack.Post(r.Context(), slack.Message{
			Channel: channel,
			Title:   payload.Title(),
			Color:   payload.Color(),
			Text:    g.truncate("parent", payload.SlackText(g.cfg.MaxAlertsInPrompt)),
		})
		if err != nil {
			g.metrics.SlackMessages.WithLabelValues("parent", "error").Inc()
			g.metrics.WebhooksReceived.WithLabelValues("slack_error").Inc()
			logger.Error("failed to post alert to slack", "error", err)
			// Report the failure so Alertmanager retries the notification
			// instead of dropping an alert nobody ever saw.
			http.Error(w, "slack post failed", http.StatusBadGateway)
			return
		}
		g.metrics.SlackMessages.WithLabelValues("parent", "ok").Inc()
		threadTS = ts
		logger = logger.With("thread_ts", ts)
		logger.Info("posted alert to slack")
	}

	reason, ok := g.shouldAnalyze(payload)
	g.metrics.DedupeEntries.Set(float64(g.store.size()))
	if !ok {
		g.metrics.AnalysesSkipped.WithLabelValues(reason).Inc()
		g.metrics.WebhooksReceived.WithLabelValues("posted").Inc()
		logger.Info("skipped analysis", "reason", reason)
		w.WriteHeader(http.StatusAccepted)
		return
	}

	g.metrics.WebhooksReceived.WithLabelValues("analyzing").Inc()
	g.wg.Go(func() {
		g.analyze(payload, agent, channel, threadTS, logger)
	})
	w.WriteHeader(http.StatusAccepted)
}

// analyze runs the agent and posts its reply in the alert's thread. It runs
// detached from the webhook request because a blocking agent call outlives
// the Alertmanager HTTP timeout.
func (g *Gateway) analyze(payload alert.Payload, agent, channel, threadTS string, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), g.cfg.KagentTimeout)
	defer cancel()

	queued := g.now()
	g.metrics.AnalysesQueued.Inc()
	select {
	case g.sem <- struct{}{}:
		g.metrics.AnalysesQueued.Dec()
		g.metrics.AnalysisQueueWait.Observe(g.now().Sub(queued).Seconds())
		defer func() { <-g.sem }()
	case <-ctx.Done():
		g.metrics.AnalysesQueued.Dec()
		g.store.forget(payload.DedupeKey())
		g.metrics.DedupeEntries.Set(float64(g.store.size()))
		g.metrics.Analyses.WithLabelValues(agent, "queue_timeout").Inc()
		logger.Error("gave up waiting for an analysis slot", "timeout", g.cfg.KagentTimeout.String())
		g.reply(payload, channel, threadTS, ":warning: Automated analysis was skipped: all analysis slots were busy.", logger)
		return
	}

	g.metrics.AnalysesInflight.Inc()
	defer g.metrics.AnalysesInflight.Dec()

	// The reactions mark the alert notification while the agent works and once
	// it is done, which needs the parent located before the run instead of
	// after. The early lookup result is reused by reply, so nothing is paid
	// twice.
	reactionsWanted := g.cfg.InvestigatingReaction != "" || g.cfg.CompletedReaction != ""
	if threadTS == "" && reactionsWanted {
		if ts, err := g.findParent(ctx, payload, channel, logger); err == nil {
			threadTS = ts
			logger = logger.With("thread_ts", ts)
		} else {
			logger.Warn("alert notification not found before analysis, skipping reactions", "error", err)
		}
	}
	if threadTS != "" && reactionsWanted {
		parentTS := threadTS
		if g.cfg.InvestigatingReaction != "" {
			if err := g.slack.AddReaction(ctx, channel, parentTS, g.cfg.InvestigatingReaction); err != nil {
				logger.Warn("failed to add investigating reaction", "error", err)
			}
		}
		_, err := g.slack.Post(ctx, slack.Message{
			Channel:  channel,
			ThreadTS: parentTS,
			Text:     investigatingMessage(agent, g.cfg.KagentTimeout),
		})
		if err != nil {
			logger.Warn("failed to post investigating message", "error", err)
		}
		// The swap gets its own context: by the time it runs, ctx has often
		// been consumed by the agent call the reaction was covering.
		defer func() {
			rctx, rcancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer rcancel()
			if g.cfg.InvestigatingReaction != "" {
				if err := g.slack.RemoveReaction(rctx, channel, parentTS, g.cfg.InvestigatingReaction); err != nil {
					logger.Warn("failed to remove investigating reaction", "error", err)
				}
			}
			if g.cfg.CompletedReaction != "" {
				if err := g.slack.AddReaction(rctx, channel, parentTS, g.cfg.CompletedReaction); err != nil {
					logger.Warn("failed to add completed reaction", "error", err)
				}
			}
		}()
	}

	started := g.now()
	logger.Info("requesting analysis")
	// No ContextID: an alert is not a conversation, so every analysis starts a
	// session of its own, unlike a mention continuing a thread.
	result, err := g.agent.Send(ctx, a2a.Request{
		Agent: agent,
		Text:  payload.Prompt(g.cfg.Instructions, g.cfg.MaxAlertsInPrompt),
	})
	elapsed := g.now().Sub(started)
	g.metrics.AnalysisDuration.Observe(elapsed.Seconds())

	if err != nil {
		// Drop the dedupe entry so the next resend of this group retries
		// instead of inheriting the suppression of a run that produced nothing.
		g.store.forget(payload.DedupeKey())
		g.metrics.DedupeEntries.Set(float64(g.store.size()))
		g.metrics.Analyses.WithLabelValues(agent, "error").Inc()
		logger.Error("analysis failed", "error", err, "duration", elapsed.String())
		g.reply(payload, channel, threadTS, fmt.Sprintf(":warning: Automated analysis failed. %s", userMessage(err)), logger)
		return
	}

	g.metrics.Analyses.WithLabelValues(agent, "ok").Inc()
	logger.Info("analysis completed",
		"duration", elapsed.String(), "task_id", result.TaskID, "chars", len(result.Text))
	g.reply(payload, channel, threadTS, result.Text, logger)
}

// reply posts a thread message under the alert. Failures are logged and
// counted only: there is nowhere left to report them.
func (g *Gateway) reply(payload alert.Payload, channel, threadTS, text string, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	msg := slack.Message{
		Channel:  channel,
		ThreadTS: threadTS,
		Text:     g.truncate("thread", text),
	}
	if msg.ThreadTS == "" {
		// Lookup mode: Alertmanager posted the alert, so the parent has to be
		// found before there is a thread to reply in. Searching after the
		// analysis rather than before means the notification has had the whole
		// agent run to arrive, which is why one attempt usually suffices.
		ts, err := g.findParent(ctx, payload, channel, logger)
		if err != nil {
			// The analysis is already paid for, so it is posted at channel
			// level rather than discarded. It carries the alert title so a
			// reader can still tell which alert it belongs to.
			g.metrics.SlackMessages.WithLabelValues("orphan", "attempted").Inc()
			logger.Error("posting analysis without a thread", "error", err)
			msg.Title = payload.Title()
			msg.Color = payload.Color()
		} else {
			msg.ThreadTS = ts
			logger = logger.With("thread_ts", ts)
		}
	}

	if _, err := g.slack.Post(ctx, msg); err != nil {
		g.metrics.SlackMessages.WithLabelValues("thread", "error").Inc()
		logger.Error("failed to post analysis to slack thread", "error", err)
		return
	}
	g.metrics.SlackMessages.WithLabelValues("thread", "ok").Inc()
	logger.Info("posted analysis to slack thread")
}

// findParent locates the notification Alertmanager posted for this alert
// group. Slack indexes nothing by alert, so the search is a scan of recent
// channel history for the marker the Alertmanager template renders.
func (g *Gateway) findParent(ctx context.Context, payload alert.Payload, channel string, logger *slog.Logger) (string, error) {
	marker := payload.Marker()
	if marker == "" {
		return "", fmt.Errorf("alert carries no fingerprint or group key to match on")
	}

	var lastErr error
	for attempt := 1; attempt <= g.cfg.LookupAttempts; attempt++ {
		ts, err := g.slack.FindThreadParent(ctx, channel, marker, g.now().Add(-g.cfg.LookupWindow))
		if err == nil {
			g.metrics.ParentLookups.WithLabelValues("found").Inc()
			g.metrics.ParentLookupTries.Observe(float64(attempt))
			return ts, nil
		}
		lastErr = err
		if !errors.Is(err, slack.ErrMessageNotFound) {
			g.metrics.ParentLookups.WithLabelValues("error").Inc()
			g.metrics.ParentLookupTries.Observe(float64(attempt))
			return "", err
		}
		// Alertmanager sends the Slack notification and the webhook
		// independently, so a not-found result can simply mean the
		// notification has not landed yet.
		if attempt == g.cfg.LookupAttempts {
			break
		}
		logger.Warn("alert notification not in channel history yet, retrying",
			"attempt", attempt, "marker", marker)
		select {
		case <-ctx.Done():
			g.metrics.ParentLookups.WithLabelValues("error").Inc()
			g.metrics.ParentLookupTries.Observe(float64(attempt))
			return "", ctx.Err()
		case <-time.After(time.Duration(attempt) * g.lookupBackoff):
		}
	}
	g.metrics.ParentLookups.WithLabelValues("not_found").Inc()
	g.metrics.ParentLookupTries.Observe(float64(g.cfg.LookupAttempts))
	return "", lastErr
}

// countAlerts records the individual alerts inside a group. The webhook counter
// only sees groups, which hides an alert storm that Alertmanager batches into a
// handful of notifications.
func (g *Gateway) countAlerts(p alert.Payload) {
	for _, a := range p.Alerts {
		severity := a.Labels["severity"]
		if severity == "" {
			severity = p.Severity()
		}
		status := a.Status
		if status == "" {
			status = p.Status
		}
		g.metrics.AlertsReceived.WithLabelValues(severity, status).Inc()
	}
}

// truncate cuts text to the Slack limit and counts the cut. A truncated thread
// reply is the one case where the gateway silently drops content the reader
// wanted, so it is worth a series of its own.
func (g *Gateway) truncate(kind, text string) string {
	out := slack.Truncate(text, g.cfg.SlackMaxTextRune)
	if out != text {
		g.metrics.SlackTruncations.WithLabelValues(kind).Inc()
	}
	return out
}

// shouldAnalyze decides whether an alert group is worth an agent run and
// returns the skip reason when it is not.
func (g *Gateway) shouldAnalyze(p alert.Payload) (string, bool) {
	if p.Resolved() && !g.cfg.AnalyzeResolved {
		return "resolved", false
	}
	if !g.severityWanted(p) {
		return "severity", false
	}
	if !g.store.allow(p.DedupeKey(), g.now()) {
		return "deduplicated", false
	}
	return "", true
}

// severityWanted applies the severity filter. The opt-in label overrides it in
// both directions so a single rule can request or refuse analysis on its own.
func (g *Gateway) severityWanted(p alert.Payload) bool {
	if v, ok := p.CommonLabels[g.cfg.AnalyzeLabel]; ok {
		return v == "true"
	}
	if len(g.cfg.AnalyzeSeverities) == 0 {
		return true
	}
	return g.cfg.AnalyzeSeverities[p.Severity()]
}

// resolveChannel picks the destination channel from the routing label that
// Alertmanager already uses, falling back to the configured default.
func (g *Gateway) resolveChannel(p alert.Payload) string {
	value := g.routingValue(p, g.cfg.ChannelLabel)
	if value == "" {
		return slack.NormalizeChannel(g.cfg.SlackChannel)
	}
	if mapped, ok := g.cfg.SlackChannelMap[value]; ok {
		return slack.NormalizeChannel(mapped)
	}
	return slack.NormalizeChannel(value)
}

// resolveAgent picks the agent that analyses this alert. Unlike the channel,
// an unmapped label value falls back to the default agent instead of being
// used as a name: an agent that does not exist on the controller would turn
// every alert in that category into a failed analysis.
func (g *Gateway) resolveAgent(p alert.Payload) string {
	value := g.routingValue(p, g.cfg.KagentAgentRoutingLabel)
	if mapped, ok := g.cfg.KagentAgentRoutingMap[value]; ok && value != "" {
		return mapped
	}
	return g.cfg.KagentAgent
}

// routingValue reads a routing label from the group, preferring the labels
// every alert in it shares over the ones it was grouped by.
func (g *Gateway) routingValue(p alert.Payload, label string) string {
	if v := p.CommonLabels[label]; v != "" {
		return v
	}
	return p.GroupLabels[label]
}

func (g *Gateway) authorized(r *http.Request) bool {
	if g.cfg.WebhookToken == "" {
		return true
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(g.cfg.WebhookToken)) == 1
}
