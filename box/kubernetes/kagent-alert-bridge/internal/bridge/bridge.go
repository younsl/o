// Package bridge turns an Alertmanager webhook into a Slack thread: the alert
// is posted as the parent message, and the agent's analysis is posted as a
// reply under it.
package bridge

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

	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/a2a"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/alert"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/config"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/observability"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/slack"
)

// maxWebhookBody caps the request body. Alertmanager truncates large groups
// itself, so anything past this is a misconfiguration rather than a real alert.
const maxWebhookBody = 4 << 20

// investigatingMessage renders the thread note that tells readers an analysis
// is underway. It names the agent and the analysis deadline, so the on-call
// engineer knows who is investigating and how long to wait before treating
// silence as a bridge failure. It accompanies the investigating reaction, so
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

// AgentClient runs one analysis on the named agent and returns its reply.
type AgentClient interface {
	Send(ctx context.Context, agent, text string) (a2a.Result, error)
}

// SlackClient posts messages, locates an existing one to thread under, and
// manages the investigating reaction on the alert notification.
type SlackClient interface {
	Post(ctx context.Context, msg slack.Message) (string, error)
	FindThreadParent(ctx context.Context, channel, marker string, since time.Time) (string, error)
	AddReaction(ctx context.Context, channel, ts, name string) error
	RemoveReaction(ctx context.Context, channel, ts, name string) error
}

// Bridge holds the wiring shared by every webhook request.
type Bridge struct {
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
}

// New wires a Bridge. The caller owns the lifecycle of slackClient and agent.
func New(cfg config.Config, slackClient SlackClient, agent AgentClient, metrics *observability.Metrics, logger *slog.Logger) *Bridge {
	// Publishing the limit as a series lets a dashboard express saturation as
	// inflight over slots, without the query repeating a value that lives in the
	// deployment's environment.
	metrics.AnalysisSlots.Set(float64(cfg.MaxConcurrent))
	return &Bridge{
		cfg:           cfg,
		slack:         slackClient,
		agent:         agent,
		metrics:       metrics,
		logger:        logger,
		store:         newStore(cfg.DedupeTTL),
		sem:           make(chan struct{}, cfg.MaxConcurrent),
		now:           time.Now,
		lookupBackoff: 2 * time.Second,
	}
}

// Handler returns the mux serving the webhook and the health endpoints.
func (b *Bridge) Handler() http.Handler {
	mux := observability.Health{}.Handler()
	mux.HandleFunc("POST "+b.cfg.WebhookPath, b.handleWebhook)
	return mux
}

// Wait blocks until every in-flight analysis finishes or timeout elapses.
// It reports whether the drain completed, so shutdown can log a truthful
// message instead of claiming a clean stop it did not achieve.
func (b *Bridge) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() {
		b.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (b *Bridge) handleWebhook(w http.ResponseWriter, r *http.Request) {
	// Alertmanager retries a receiver that answers too slowly, so the handler's
	// own latency is worth watching even though the analysis runs detached.
	started := b.now()
	defer func() { b.metrics.WebhookDuration.Observe(b.now().Sub(started).Seconds()) }()

	if !b.authorized(r) {
		b.metrics.WebhooksReceived.WithLabelValues("unauthorized").Inc()
		b.logger.Warn("rejected webhook", "reason", "bad bearer token", "remote_addr", r.RemoteAddr)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var payload alert.Payload
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWebhookBody)).Decode(&payload); err != nil {
		b.metrics.WebhooksReceived.WithLabelValues("bad_request").Inc()
		b.logger.Error("failed to decode webhook payload", "error", err)
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	if len(payload.Alerts) == 0 {
		b.metrics.WebhooksReceived.WithLabelValues("empty").Inc()
		b.logger.Warn("webhook carried no alerts", "group_key", payload.GroupKey, "receiver", payload.Receiver)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	b.countAlerts(payload)

	logger := b.logger.With(
		"alertname", payload.Name(),
		"severity", payload.Severity(),
		"cluster", payload.Cluster(),
		"status", payload.Status,
		"group_key", payload.GroupKey,
		"alert_count", len(payload.Alerts),
	)
	channel := b.resolveChannel(payload)
	agent := b.resolveAgent(payload)
	logger = logger.With("channel", channel, "agent", agent)

	// In lookup mode Alertmanager owns the notification, so an alert nobody
	// analyses costs the bridge nothing at all.
	var threadTS string
	if b.cfg.ParentMode == config.ParentModePost {
		ts, err := b.slack.Post(r.Context(), slack.Message{
			Channel: channel,
			Title:   payload.Title(),
			Color:   payload.Color(),
			Text:    b.truncate("parent", payload.SlackText(b.cfg.MaxAlertsInPrompt)),
		})
		if err != nil {
			b.metrics.SlackMessages.WithLabelValues("parent", "error").Inc()
			b.metrics.WebhooksReceived.WithLabelValues("slack_error").Inc()
			logger.Error("failed to post alert to slack", "error", err)
			// Report the failure so Alertmanager retries the notification
			// instead of dropping an alert nobody ever saw.
			http.Error(w, "slack post failed", http.StatusBadGateway)
			return
		}
		b.metrics.SlackMessages.WithLabelValues("parent", "ok").Inc()
		threadTS = ts
		logger = logger.With("thread_ts", ts)
		logger.Info("posted alert to slack")
	}

	reason, ok := b.shouldAnalyze(payload)
	b.metrics.DedupeEntries.Set(float64(b.store.size()))
	if !ok {
		b.metrics.AnalysesSkipped.WithLabelValues(reason).Inc()
		b.metrics.WebhooksReceived.WithLabelValues("posted").Inc()
		logger.Info("skipped analysis", "reason", reason)
		w.WriteHeader(http.StatusAccepted)
		return
	}

	b.metrics.WebhooksReceived.WithLabelValues("analyzing").Inc()
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		b.analyze(payload, agent, channel, threadTS, logger)
	}()
	w.WriteHeader(http.StatusAccepted)
}

// analyze runs the agent and posts its reply in the alert's thread. It runs
// detached from the webhook request because a blocking agent call outlives
// the Alertmanager HTTP timeout.
func (b *Bridge) analyze(payload alert.Payload, agent, channel, threadTS string, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), b.cfg.KagentTimeout)
	defer cancel()

	queued := b.now()
	b.metrics.AnalysesQueued.Inc()
	select {
	case b.sem <- struct{}{}:
		b.metrics.AnalysesQueued.Dec()
		b.metrics.AnalysisQueueWait.Observe(b.now().Sub(queued).Seconds())
		defer func() { <-b.sem }()
	case <-ctx.Done():
		b.metrics.AnalysesQueued.Dec()
		b.store.forget(payload.DedupeKey())
		b.metrics.DedupeEntries.Set(float64(b.store.size()))
		b.metrics.Analyses.WithLabelValues(agent, "queue_timeout").Inc()
		logger.Error("gave up waiting for an analysis slot", "timeout", b.cfg.KagentTimeout.String())
		b.reply(payload, channel, threadTS, ":warning: Automated analysis was skipped: all analysis slots were busy.", logger)
		return
	}

	b.metrics.AnalysesInflight.Inc()
	defer b.metrics.AnalysesInflight.Dec()

	// The reactions mark the alert notification while the agent works and once
	// it is done, which needs the parent located before the run instead of
	// after. The early lookup result is reused by reply, so nothing is paid
	// twice.
	reactionsWanted := b.cfg.InvestigatingReaction != "" || b.cfg.CompletedReaction != ""
	if threadTS == "" && reactionsWanted {
		if ts, err := b.findParent(ctx, payload, channel, logger); err == nil {
			threadTS = ts
			logger = logger.With("thread_ts", ts)
		} else {
			logger.Warn("alert notification not found before analysis, skipping reactions", "error", err)
		}
	}
	if threadTS != "" && reactionsWanted {
		parentTS := threadTS
		if b.cfg.InvestigatingReaction != "" {
			if err := b.slack.AddReaction(ctx, channel, parentTS, b.cfg.InvestigatingReaction); err != nil {
				logger.Warn("failed to add investigating reaction", "error", err)
			}
		}
		_, err := b.slack.Post(ctx, slack.Message{
			Channel:  channel,
			ThreadTS: parentTS,
			Text:     investigatingMessage(agent, b.cfg.KagentTimeout),
		})
		if err != nil {
			logger.Warn("failed to post investigating message", "error", err)
		}
		// The swap gets its own context: by the time it runs, ctx has often
		// been consumed by the agent call the reaction was covering.
		defer func() {
			rctx, rcancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer rcancel()
			if b.cfg.InvestigatingReaction != "" {
				if err := b.slack.RemoveReaction(rctx, channel, parentTS, b.cfg.InvestigatingReaction); err != nil {
					logger.Warn("failed to remove investigating reaction", "error", err)
				}
			}
			if b.cfg.CompletedReaction != "" {
				if err := b.slack.AddReaction(rctx, channel, parentTS, b.cfg.CompletedReaction); err != nil {
					logger.Warn("failed to add completed reaction", "error", err)
				}
			}
		}()
	}

	started := b.now()
	logger.Info("requesting analysis")
	result, err := b.agent.Send(ctx, agent, payload.Prompt(b.cfg.Instructions, b.cfg.MaxAlertsInPrompt))
	elapsed := b.now().Sub(started)
	b.metrics.AnalysisDuration.Observe(elapsed.Seconds())

	if err != nil {
		// Drop the dedupe entry so the next resend of this group retries
		// instead of inheriting the suppression of a run that produced nothing.
		b.store.forget(payload.DedupeKey())
		b.metrics.DedupeEntries.Set(float64(b.store.size()))
		b.metrics.Analyses.WithLabelValues(agent, "error").Inc()
		logger.Error("analysis failed", "error", err, "duration", elapsed.String())
		b.reply(payload, channel, threadTS, fmt.Sprintf(":warning: Automated analysis failed: %s", err), logger)
		return
	}

	b.metrics.Analyses.WithLabelValues(agent, "ok").Inc()
	logger.Info("analysis completed",
		"duration", elapsed.String(), "task_id", result.TaskID, "chars", len(result.Text))
	b.reply(payload, channel, threadTS, result.Text, logger)
}

// reply posts a thread message under the alert. Failures are logged and
// counted only: there is nowhere left to report them.
func (b *Bridge) reply(payload alert.Payload, channel, threadTS, text string, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	msg := slack.Message{
		Channel:  channel,
		ThreadTS: threadTS,
		Text:     b.truncate("thread", text),
	}
	if msg.ThreadTS == "" {
		// Lookup mode: Alertmanager posted the alert, so the parent has to be
		// found before there is a thread to reply in. Searching after the
		// analysis rather than before means the notification has had the whole
		// agent run to arrive, which is why one attempt usually suffices.
		ts, err := b.findParent(ctx, payload, channel, logger)
		if err != nil {
			// The analysis is already paid for, so it is posted at channel
			// level rather than discarded. It carries the alert title so a
			// reader can still tell which alert it belongs to.
			b.metrics.SlackMessages.WithLabelValues("orphan", "attempted").Inc()
			logger.Error("posting analysis without a thread", "error", err)
			msg.Title = payload.Title()
			msg.Color = payload.Color()
		} else {
			msg.ThreadTS = ts
			logger = logger.With("thread_ts", ts)
		}
	}

	if _, err := b.slack.Post(ctx, msg); err != nil {
		b.metrics.SlackMessages.WithLabelValues("thread", "error").Inc()
		logger.Error("failed to post analysis to slack thread", "error", err)
		return
	}
	b.metrics.SlackMessages.WithLabelValues("thread", "ok").Inc()
	logger.Info("posted analysis to slack thread")
}

// findParent locates the notification Alertmanager posted for this alert
// group. Slack indexes nothing by alert, so the search is a scan of recent
// channel history for the marker the Alertmanager template renders.
func (b *Bridge) findParent(ctx context.Context, payload alert.Payload, channel string, logger *slog.Logger) (string, error) {
	marker := payload.Marker()
	if marker == "" {
		return "", fmt.Errorf("alert carries no fingerprint or group key to match on")
	}

	var lastErr error
	for attempt := 1; attempt <= b.cfg.LookupAttempts; attempt++ {
		ts, err := b.slack.FindThreadParent(ctx, channel, marker, b.now().Add(-b.cfg.LookupWindow))
		if err == nil {
			b.metrics.ParentLookups.WithLabelValues("found").Inc()
			b.metrics.ParentLookupTries.Observe(float64(attempt))
			return ts, nil
		}
		lastErr = err
		if !errors.Is(err, slack.ErrMessageNotFound) {
			b.metrics.ParentLookups.WithLabelValues("error").Inc()
			b.metrics.ParentLookupTries.Observe(float64(attempt))
			return "", err
		}
		// Alertmanager sends the Slack notification and the webhook
		// independently, so a not-found result can simply mean the
		// notification has not landed yet.
		if attempt == b.cfg.LookupAttempts {
			break
		}
		logger.Warn("alert notification not in channel history yet, retrying",
			"attempt", attempt, "marker", marker)
		select {
		case <-ctx.Done():
			b.metrics.ParentLookups.WithLabelValues("error").Inc()
			b.metrics.ParentLookupTries.Observe(float64(attempt))
			return "", ctx.Err()
		case <-time.After(time.Duration(attempt) * b.lookupBackoff):
		}
	}
	b.metrics.ParentLookups.WithLabelValues("not_found").Inc()
	b.metrics.ParentLookupTries.Observe(float64(b.cfg.LookupAttempts))
	return "", lastErr
}

// countAlerts records the individual alerts inside a group. The webhook counter
// only sees groups, which hides an alert storm that Alertmanager batches into a
// handful of notifications.
func (b *Bridge) countAlerts(p alert.Payload) {
	for _, a := range p.Alerts {
		severity := a.Labels["severity"]
		if severity == "" {
			severity = p.Severity()
		}
		status := a.Status
		if status == "" {
			status = p.Status
		}
		b.metrics.AlertsReceived.WithLabelValues(severity, status).Inc()
	}
}

// truncate cuts text to the Slack limit and counts the cut. A truncated thread
// reply is the one case where the bridge silently drops content the reader
// wanted, so it is worth a series of its own.
func (b *Bridge) truncate(kind, text string) string {
	out := slack.Truncate(text, b.cfg.SlackMaxTextRune)
	if out != text {
		b.metrics.SlackTruncations.WithLabelValues(kind).Inc()
	}
	return out
}

// shouldAnalyze decides whether an alert group is worth an agent run and
// returns the skip reason when it is not.
func (b *Bridge) shouldAnalyze(p alert.Payload) (string, bool) {
	if p.Resolved() && !b.cfg.AnalyzeResolved {
		return "resolved", false
	}
	if !b.severityWanted(p) {
		return "severity", false
	}
	if !b.store.allow(p.DedupeKey(), b.now()) {
		return "deduplicated", false
	}
	return "", true
}

// severityWanted applies the severity filter. The opt-in label overrides it in
// both directions so a single rule can request or refuse analysis on its own.
func (b *Bridge) severityWanted(p alert.Payload) bool {
	if v, ok := p.CommonLabels[b.cfg.AnalyzeLabel]; ok {
		return v == "true"
	}
	if len(b.cfg.AnalyzeSeverities) == 0 {
		return true
	}
	return b.cfg.AnalyzeSeverities[p.Severity()]
}

// resolveChannel picks the destination channel from the routing label that
// Alertmanager already uses, falling back to the configured default.
func (b *Bridge) resolveChannel(p alert.Payload) string {
	value := b.routingValue(p, b.cfg.ChannelLabel)
	if value == "" {
		return slack.NormalizeChannel(b.cfg.SlackChannel)
	}
	if mapped, ok := b.cfg.SlackChannelMap[value]; ok {
		return slack.NormalizeChannel(mapped)
	}
	return slack.NormalizeChannel(value)
}

// resolveAgent picks the agent that analyses this alert. Unlike the channel,
// an unmapped label value falls back to the default agent instead of being
// used as a name: an agent that does not exist on the controller would turn
// every alert in that category into a failed analysis.
func (b *Bridge) resolveAgent(p alert.Payload) string {
	value := b.routingValue(p, b.cfg.KagentAgentRoutingLabel)
	if mapped, ok := b.cfg.KagentAgentRoutingMap[value]; ok && value != "" {
		return mapped
	}
	return b.cfg.KagentAgent
}

// routingValue reads a routing label from the group, preferring the labels
// every alert in it shares over the ones it was grouped by.
func (b *Bridge) routingValue(p alert.Payload, label string) string {
	if v := p.CommonLabels[label]; v != "" {
		return v
	}
	return p.GroupLabels[label]
}

func (b *Bridge) authorized(r *http.Request) bool {
	if b.cfg.WebhookToken == "" {
		return true
	}
	got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	return subtle.ConstantTimeCompare([]byte(got), []byte(b.cfg.WebhookToken)) == 1
}
