package bridge

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/a2a"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/alert"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/config"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/observability"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/slack"
)

const criticalAlert = `{
  "groupKey": "gk-1",
  "status": "firing",
  "receiver": "kagent-alert-bridge",
  "commonLabels": {"alertname": "KubePodCrashLooping", "severity": "critical", "cluster": "prd"},
  "alerts": [{"status": "firing", "fingerprint": "fp-1",
    "labels": {"alertname": "KubePodCrashLooping", "severity": "critical"},
    "annotations": {"summary": "pod restarting"}}]
}`

// fakeSlack records every posted message and hands out incrementing
// timestamps so a test can assert which message threaded under which parent.
type fakeSlack struct {
	mu       sync.Mutex
	messages []slack.Message
	err      error
	posted   chan struct{}

	// lookup behaviour
	found       string
	lookupErr   error
	lookupCalls int
	markers     []string
	sinceValues []time.Time

	// reaction behaviour
	reactionErr error
	reactions   []string

	// mention path behaviour
	updates    []slackUpdate
	updateErr  error
	updated    chan struct{}
	ephemerals []slackEphemeral
	ephemErr   error
	// resolved maps a configured channel name to the ID an event carries. A
	// name the map does not hold resolves to itself, which covers the tests
	// that configure IDs directly.
	resolved   map[string]string
	resolveErr error
}

// slackUpdate is one chat.update call, which the mention path uses to keep its
// status line current.
type slackUpdate struct {
	channel string
	ts      string
	text    string
}

// slackEphemeral is one chat.postEphemeral call, which carries a hint.
type slackEphemeral struct {
	channel  string
	threadTS string
	user     string
	text     string
}

func newFakeSlack() *fakeSlack {
	return &fakeSlack{
		posted:  make(chan struct{}, 8),
		updated: make(chan struct{}, 32),
		found:   "ts-parent",
	}
}

func (f *fakeSlack) Update(_ context.Context, channel, ts, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.updateErr != nil {
		return f.updateErr
	}
	f.updates = append(f.updates, slackUpdate{channel: channel, ts: ts, text: text})
	select {
	case f.updated <- struct{}{}:
	default:
	}
	return nil
}

func (f *fakeSlack) PostEphemeral(_ context.Context, channel, threadTS, user, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ephemErr != nil {
		return f.ephemErr
	}
	f.ephemerals = append(f.ephemerals, slackEphemeral{channel: channel, threadTS: threadTS, user: user, text: text})
	return nil
}

func (f *fakeSlack) ResolveChannelID(_ context.Context, channel string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.resolveErr != nil {
		return "", f.resolveErr
	}
	if id, ok := f.resolved[channel]; ok {
		return id, nil
	}
	return channel, nil
}

func (f *fakeSlack) allUpdates() []slackUpdate {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]slackUpdate(nil), f.updates...)
}

// lastUpdate returns the text the status message currently shows.
func (f *fakeSlack) lastUpdate() string {
	updates := f.allUpdates()
	if len(updates) == 0 {
		return ""
	}
	return updates[len(updates)-1].text
}

func (f *fakeSlack) allEphemerals() []slackEphemeral {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]slackEphemeral(nil), f.ephemerals...)
}

// waitForUpdate blocks until n status rewrites have landed, so a test never
// sleeps on the status ticker.
func (f *fakeSlack) waitForUpdate(t *testing.T, n int) []slackUpdate {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for len(f.allUpdates()) < n {
		select {
		case <-f.updated:
		case <-deadline:
			t.Fatalf("timed out waiting for %d slack updates, got %d", n, len(f.allUpdates()))
		}
	}
	return f.allUpdates()
}

func (f *fakeSlack) Post(_ context.Context, msg slack.Message) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return "", f.err
	}
	f.messages = append(f.messages, msg)
	f.posted <- struct{}{}
	return "ts-parent", nil
}

func (f *fakeSlack) FindThreadParent(_ context.Context, _, marker string, since time.Time) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lookupCalls++
	f.markers = append(f.markers, marker)
	f.sinceValues = append(f.sinceValues, since)
	if f.lookupErr != nil {
		return "", f.lookupErr
	}
	return f.found, nil
}

func (f *fakeSlack) AddReaction(_ context.Context, _, ts, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reactionErr != nil {
		return f.reactionErr
	}
	f.reactions = append(f.reactions, "add "+name+" "+ts)
	return nil
}

func (f *fakeSlack) RemoveReaction(_ context.Context, _, ts, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reactionErr != nil {
		return f.reactionErr
	}
	f.reactions = append(f.reactions, "remove "+name+" "+ts)
	return nil
}

func (f *fakeSlack) allReactions() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.reactions...)
}

func (f *fakeSlack) lookups() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lookupCalls
}

func (f *fakeSlack) all() []slack.Message {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]slack.Message(nil), f.messages...)
}

// waitFor blocks until n messages have been posted, so tests never sleep on
// the detached analysis goroutine.
func (f *fakeSlack) waitFor(t *testing.T, n int) []slack.Message {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for len(f.all()) < n {
		select {
		case <-f.posted:
		case <-deadline:
			t.Fatalf("timed out waiting for %d slack messages, got %d", n, len(f.all()))
		}
	}
	return f.all()
}

type fakeAgent struct {
	mu         sync.Mutex
	prompts    []string
	agents     []string
	contextIDs []string
	reply      string
	replyCtxID string
	err        error
	delay      time.Duration
	release    chan struct{}
	// holdPastDeadline makes Send ignore the context while waiting on release,
	// so a test can pin an analysis slot for a known duration instead of
	// racing the caller's timeout.
	holdPastDeadline bool
	// progress is reported through the request's hook before the reply, which
	// is what drives the mention path's status line.
	progress []a2a.Progress
}

func (f *fakeAgent) Send(ctx context.Context, req a2a.Request) (a2a.Result, error) {
	f.mu.Lock()
	f.agents = append(f.agents, req.Agent)
	f.prompts = append(f.prompts, req.Text)
	f.contextIDs = append(f.contextIDs, req.ContextID)
	release, delay, reply, err := f.release, f.delay, f.reply, f.err
	hold := f.holdPastDeadline
	progress, ctxID := f.progress, f.replyCtxID
	f.mu.Unlock()

	for _, p := range progress {
		if req.OnProgress != nil {
			req.OnProgress(p)
		}
	}

	if release != nil {
		if hold {
			<-release
		} else {
			select {
			case <-release:
			case <-ctx.Done():
				return a2a.Result{}, ctx.Err()
			}
		}
	}
	if delay > 0 {
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return a2a.Result{}, ctx.Err()
		}
	}
	if err != nil {
		return a2a.Result{}, err
	}
	return a2a.Result{Text: reply, TaskID: "task-1", ContextID: ctxID}, nil
}

// lastContextID reports the session the most recent call continued, empty when
// it started a fresh one.
func (f *fakeAgent) lastContextID() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.contextIDs) == 0 {
		return ""
	}
	return f.contextIDs[len(f.contextIDs)-1]
}

func (f *fakeAgent) promptCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.prompts)
}

// lastAgent reports which agent the most recent analysis was routed to.
func (f *fakeAgent) lastAgent() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.agents) == 0 {
		return ""
	}
	return f.agents[len(f.agents)-1]
}

func testConfig() config.Config {
	return config.Config{
		SlackChannel:      "alerts",
		ChannelLabel:      "slack_channel",
		SlackChannelMap:   map[string]string{"test-route": "alerts-test"},
		SlackMaxTextRune:  3500,
		ParentMode:        config.ParentModePost,
		LookupWindow:      15 * time.Minute,
		LookupAttempts:    2,
		KagentAgent:       "alert-triage-agent",
		KagentTimeout:     2 * time.Second,
		AnalyzeSeverities: map[string]bool{"critical": true},
		AnalyzeLabel:      "analyze",
		DedupeTTL:         time.Hour,
		MaxAlertsInPrompt: 5,
		MaxConcurrent:     1,
		Instructions:      "investigate",
		WebhookPath:       "/alert",
	}
}

func newTestBridge(t *testing.T, cfg config.Config, sc SlackClient, agent AgentClient) *Bridge {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	b := New(cfg, sc, agent, observability.NewMetrics(), logger)
	b.lookupBackoff = time.Millisecond // keep retry tests fast
	t.Cleanup(func() { b.Wait(3 * time.Second) })
	return b
}

func post(t *testing.T, b *Bridge, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/alert", strings.NewReader(body))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	b.Handler().ServeHTTP(rec, req)
	return rec
}

func TestWebhookPostsAlertThenAnalysis(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{reply: "*Summary* OOMKilled"}
	b := newTestBridge(t, testConfig(), sc, agent)

	if rec := post(t, b, criticalAlert, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}

	msgs := sc.waitFor(t, 2)
	parent, reply := msgs[0], msgs[1]
	if parent.Channel != "#alerts" || parent.ThreadTS != "" {
		t.Errorf("parent = %+v", parent)
	}
	if parent.Title != "🚨 [FIRING] KubePodCrashLooping" || parent.Color != "danger" {
		t.Errorf("parent title/color = %q/%q", parent.Title, parent.Color)
	}
	if reply.ThreadTS != "ts-parent" {
		t.Errorf("reply thread_ts = %q, want the parent timestamp", reply.ThreadTS)
	}
	if reply.Channel != "#alerts" || reply.Text != "*Summary* OOMKilled" {
		t.Errorf("reply = %+v", reply)
	}
	if reply.Title != "" {
		t.Errorf("reply should be a plain message, got title %q", reply.Title)
	}
	if agent.promptCount() != 1 {
		t.Errorf("agent called %d times, want 1", agent.promptCount())
	}
	if !strings.Contains(agent.prompts[0], "investigate") {
		t.Errorf("prompt missing the instructions:\n%s", agent.prompts[0])
	}
}

// The investigating reaction must appear on the parent before the agent runs
// and be swapped for the completed reaction once the analysis is posted, and
// the early lookup it forces must be reused by the reply instead of searching
// twice.
func TestInvestigatingReactionWrapsAnalysis(t *testing.T) {
	cfg := testConfig()
	cfg.ParentMode = config.ParentModeLookup
	cfg.InvestigatingReaction = "telescope"
	cfg.CompletedReaction = "white_check_mark"
	sc, agent := newFakeSlack(), &fakeAgent{reply: "*Summary* OOMKilled"}
	b := newTestBridge(t, cfg, sc, agent)

	if rec := post(t, b, criticalAlert, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	msgs := sc.waitFor(t, 2)
	if !b.Wait(3 * time.Second) {
		t.Fatal("analysis did not drain")
	}

	if msgs[0].ThreadTS != "ts-parent" || msgs[0].Text != investigatingMessage(cfg.KagentAgent, cfg.KagentTimeout) {
		t.Errorf("investigating note = %+v, want a thread reply before the analysis", msgs[0])
	}
	if msgs[1].ThreadTS != "ts-parent" || msgs[1].Text != "*Summary* OOMKilled" {
		t.Errorf("reply = %+v, want the analysis under the looked-up parent", msgs[1])
	}
	want := []string{"add telescope ts-parent", "remove telescope ts-parent", "add white_check_mark ts-parent"}
	if got := sc.allReactions(); !reflect.DeepEqual(got, want) {
		t.Errorf("reactions = %v, want %v", got, want)
	}
	if sc.lookups() != 1 {
		t.Errorf("parent looked up %d times, want the early result reused", sc.lookups())
	}
}

// The investigating note names the agent and the deadline so the on-call
// engineer knows who is working and how long to wait.
func TestInvestigatingMessage(t *testing.T) {
	got := investigatingMessage("alert-triage-agent", 300*time.Second)
	want := "kagent의 alert-triage-agent 에이전트가 조사를 시작했습니다. 최대 5분 내 원인 분석 결과 또는 실패 사유가 이 스레드에 게시됩니다."
	if got != want {
		t.Errorf("investigatingMessage() = %q, want %q", got, want)
	}

	durations := []struct {
		in   time.Duration
		want string
	}{
		{300 * time.Second, "5분"},
		{90 * time.Second, "1분 30초"},
		{45 * time.Second, "45초"},
	}
	for _, tt := range durations {
		if got := koreanDuration(tt.in); got != tt.want {
			t.Errorf("koreanDuration(%s) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

// A reaction failure is cosmetic, so it must not stop the analysis or the
// thread reply.
func TestReactionFailureDoesNotBlockAnalysis(t *testing.T) {
	cfg := testConfig()
	cfg.ParentMode = config.ParentModeLookup
	cfg.InvestigatingReaction = "telescope"
	sc, agent := newFakeSlack(), &fakeAgent{reply: "*Summary* fine"}
	sc.reactionErr = errors.New("missing_scope")
	b := newTestBridge(t, cfg, sc, agent)

	if rec := post(t, b, criticalAlert, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}
	msgs := sc.waitFor(t, 2)
	if msgs[1].ThreadTS != "ts-parent" || msgs[1].Text != "*Summary* fine" {
		t.Errorf("reply = %+v", msgs[1])
	}
}

// The alert has to reach Slack even when the analysis never will, so an agent
// failure is reported in the thread instead of silently dropped.
func TestWebhookReportsAgentFailureInThread(t *testing.T) {
	sc := newFakeSlack()
	b := newTestBridge(t, testConfig(), sc, &fakeAgent{err: errors.New("bedrock throttled")})

	post(t, b, criticalAlert, nil)

	msgs := sc.waitFor(t, 2)
	if !strings.Contains(msgs[1].Text, "bedrock throttled") {
		t.Errorf("thread reply = %q", msgs[1].Text)
	}
	if msgs[1].ThreadTS != "ts-parent" {
		t.Errorf("failure notice was not threaded: %+v", msgs[1])
	}
}

// A failed run must not leave the group suppressed, or the next resend would
// inherit a dedupe entry for an analysis that produced nothing.
func TestFailedAnalysisIsRetriedOnResend(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{err: errors.New("boom")}
	b := newTestBridge(t, testConfig(), sc, agent)

	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 2)
	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 4)

	if agent.promptCount() != 2 {
		t.Errorf("agent called %d times, want 2", agent.promptCount())
	}
}

func TestWebhookDeduplicatesRepeatedGroups(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
	b := newTestBridge(t, testConfig(), sc, agent)

	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 2)
	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 3)

	if agent.promptCount() != 1 {
		t.Errorf("agent called %d times, want 1", agent.promptCount())
	}
	// The alert itself is still posted every time; only the analysis is skipped.
	if got := len(sc.all()); got != 3 {
		t.Errorf("slack messages = %d, want 3", got)
	}
}

func TestWebhookSkipsUnwantedAlerts(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{
			"resolved",
			`{"groupKey":"g","status":"resolved","commonLabels":{"alertname":"A","severity":"critical"},
			  "alerts":[{"status":"resolved","labels":{"severity":"critical"}}]}`,
		},
		{
			"severity below threshold",
			`{"groupKey":"g","status":"firing","commonLabels":{"alertname":"A","severity":"warning"},
			  "alerts":[{"status":"firing","labels":{"severity":"warning"}}]}`,
		},
		{
			"opt-out label",
			`{"groupKey":"g","status":"firing","commonLabels":{"alertname":"A","severity":"critical","analyze":"false"},
			  "alerts":[{"status":"firing","labels":{"severity":"critical"}}]}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
			b := newTestBridge(t, testConfig(), sc, agent)

			if rec := post(t, b, tt.body, nil); rec.Code != http.StatusAccepted {
				t.Fatalf("status = %d, want 202", rec.Code)
			}
			sc.waitFor(t, 1)
			b.Wait(time.Second)

			if agent.promptCount() != 0 {
				t.Errorf("agent was called for a skipped alert")
			}
			if got := len(sc.all()); got != 1 {
				t.Errorf("slack messages = %d, want only the alert itself", got)
			}
		})
	}
}

// A rule can request analysis for a severity the global filter excludes.
func TestOptInLabelOverridesSeverityFilter(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
	b := newTestBridge(t, testConfig(), sc, agent)

	post(t, b, `{"groupKey":"g","status":"firing",
		"commonLabels":{"alertname":"A","severity":"warning","analyze":"true"},
		"alerts":[{"status":"firing","labels":{"severity":"warning"}}]}`, nil)

	sc.waitFor(t, 2)
	if agent.promptCount() != 1 {
		t.Errorf("agent called %d times, want 1", agent.promptCount())
	}
}

func TestAnalyzeResolvedWhenEnabled(t *testing.T) {
	cfg := testConfig()
	cfg.AnalyzeResolved = true
	sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
	b := newTestBridge(t, cfg, sc, agent)

	post(t, b, `{"groupKey":"g","status":"resolved","commonLabels":{"alertname":"A","severity":"critical"},
		"alerts":[{"status":"resolved","labels":{"severity":"critical"}}]}`, nil)

	sc.waitFor(t, 2)
	if agent.promptCount() != 1 {
		t.Errorf("agent called %d times, want 1", agent.promptCount())
	}
}

func TestEmptySeverityFilterAnalysesEverything(t *testing.T) {
	cfg := testConfig()
	cfg.AnalyzeSeverities = map[string]bool{}
	sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
	b := newTestBridge(t, cfg, sc, agent)

	post(t, b, `{"groupKey":"g","status":"firing","commonLabels":{"alertname":"A","severity":"info"},
		"alerts":[{"status":"firing","labels":{"severity":"info"}}]}`, nil)

	sc.waitFor(t, 2)
	if agent.promptCount() != 1 {
		t.Errorf("agent called %d times, want 1", agent.promptCount())
	}
}

// Alertmanager must retry a notification the bridge failed to deliver, which
// only happens if the webhook answers with an error status.
func TestWebhookReturns502WhenSlackFails(t *testing.T) {
	sc := newFakeSlack()
	sc.err = errors.New("channel_not_found")
	agent := &fakeAgent{reply: "ok"}
	b := newTestBridge(t, testConfig(), sc, agent)

	if rec := post(t, b, criticalAlert, nil); rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", rec.Code)
	}
	if agent.promptCount() != 0 {
		t.Error("agent must not run when the alert never reached Slack")
	}
}

func TestWebhookRejectsBadInput(t *testing.T) {
	tests := []struct {
		name string
		body string
		want int
	}{
		{"malformed json", "{not json", http.StatusBadRequest},
		{"no alerts", `{"groupKey":"g","status":"firing","alerts":[]}`, http.StatusNoContent},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sc := newFakeSlack()
			b := newTestBridge(t, testConfig(), sc, &fakeAgent{})

			if rec := post(t, b, tt.body, nil); rec.Code != tt.want {
				t.Fatalf("status = %d, want %d", rec.Code, tt.want)
			}
			if got := len(sc.all()); got != 0 {
				t.Errorf("posted %d messages for a rejected request", got)
			}
		})
	}
}

func TestWebhookBearerToken(t *testing.T) {
	cfg := testConfig()
	cfg.WebhookToken = "s3cret"

	tests := []struct {
		name   string
		header map[string]string
		want   int
	}{
		{"valid", map[string]string{"Authorization": "Bearer s3cret"}, http.StatusAccepted},
		{"wrong", map[string]string{"Authorization": "Bearer nope"}, http.StatusUnauthorized},
		{"missing", nil, http.StatusUnauthorized},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sc := newFakeSlack()
			b := newTestBridge(t, cfg, sc, &fakeAgent{reply: "ok"})

			if rec := post(t, b, criticalAlert, tt.header); rec.Code != tt.want {
				t.Fatalf("status = %d, want %d", rec.Code, tt.want)
			}
		})
	}
}

func TestHandlerServesHealthEndpoints(t *testing.T) {
	b := newTestBridge(t, testConfig(), newFakeSlack(), &fakeAgent{})

	for _, path := range []string{"/healthz", "/readyz"} {
		rec := httptest.NewRecorder()
		b.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, rec.Code)
		}
	}
}

func TestResolveChannel(t *testing.T) {
	b := newTestBridge(t, testConfig(), newFakeSlack(), &fakeAgent{})

	tests := []struct {
		name string
		body string
		want string
	}{
		{"default", `{"commonLabels":{}}`, "#alerts"},
		{"mapped label", `{"commonLabels":{"slack_channel":"test-route"}}`, "#alerts-test"},
		{"unmapped label", `{"commonLabels":{"slack_channel":"infra-alerts"}}`, "#infra-alerts"},
		{"group label", `{"groupLabels":{"slack_channel":"ops"}}`, "#ops"},
		{"already prefixed", `{"commonLabels":{"slack_channel":"#ops"}}`, "#ops"},
		{"channel id", `{"commonLabels":{"slack_channel":"C01ABCDEF12"}}`, "C01ABCDEF12"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var p = decodePayload(t, tt.body)
			if got := b.resolveChannel(p); got != tt.want {
				t.Errorf("resolveChannel() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestResolveAgent(t *testing.T) {
	cfg := testConfig()
	cfg.KagentAgentRoutingLabel = "slack_channel"
	cfg.KagentAgentRoutingMap = map[string]string{
		"infra-alerts":    "aws-alert-triage-agent",
		"security-alerts": "security-alert-triage-agent",
	}
	b := newTestBridge(t, cfg, newFakeSlack(), &fakeAgent{})

	tests := []struct {
		name string
		body string
		want string
	}{
		{"no label", `{"commonLabels":{}}`, "alert-triage-agent"},
		{"mapped label", `{"commonLabels":{"slack_channel":"security-alerts"}}`, "security-alert-triage-agent"},
		{"group label", `{"groupLabels":{"slack_channel":"infra-alerts"}}`, "aws-alert-triage-agent"},
		// An unmapped value must not be used as an agent name: no such Agent
		// exists on the controller, so every alert in that category would fail.
		{"unmapped label", `{"commonLabels":{"slack_channel":"alerts-test"}}`, "alert-triage-agent"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := b.resolveAgent(decodePayload(t, tt.body)); got != tt.want {
				t.Errorf("resolveAgent() = %q, want %q", got, tt.want)
			}
		})
	}
}

// The routing label decides both the channel and the agent, so an alert in a
// mapped category has to reach the specialised agent rather than the default.
func TestWebhookRoutesAlertToTheMappedAgent(t *testing.T) {
	cfg := testConfig()
	cfg.KagentAgentRoutingLabel = "slack_channel"
	cfg.KagentAgentRoutingMap = map[string]string{"security-alerts": "security-alert-triage-agent"}
	sc, agent := newFakeSlack(), &fakeAgent{reply: "*Summary* falco fired"}
	b := newTestBridge(t, cfg, sc, agent)

	body := strings.Replace(criticalAlert,
		`"commonLabels": {"alertname"`,
		`"commonLabels": {"slack_channel": "security-alerts", "alertname"`, 1)
	post(t, b, body, nil)

	sc.waitFor(t, 2)
	if got := agent.lastAgent(); got != "security-alert-triage-agent" {
		t.Errorf("analysis went to agent %q, want the security agent", got)
	}
}

// The bridge caps concurrent agent runs so a burst of alerts cannot open an
// unbounded number of Bedrock calls at once.
func TestConcurrencyIsCapped(t *testing.T) {
	cfg := testConfig()
	cfg.KagentTimeout = 300 * time.Millisecond
	sc := newFakeSlack()
	agent := &fakeAgent{reply: "ok", release: make(chan struct{}), holdPastDeadline: true}
	b := newTestBridge(t, cfg, sc, agent)

	post(t, b, criticalAlert, nil)
	post(t, b, strings.Replace(criticalAlert, "gk-1", "gk-2", 1), nil)

	// Both alerts are posted and the first analysis pins the only slot, so the
	// second cannot start. It reports the wait in its own thread rather than
	// disappearing.
	msgs := sc.waitFor(t, 3)
	if !strings.Contains(msgs[2].Text, "analysis slots were busy") {
		t.Errorf("queued analysis did not report the timeout: %q", msgs[2].Text)
	}
	close(agent.release)
}

func TestWaitReportsTimeout(t *testing.T) {
	cfg := testConfig()
	cfg.KagentTimeout = 5 * time.Second
	sc := newFakeSlack()
	agent := &fakeAgent{reply: "ok", release: make(chan struct{})}
	b := New(cfg, sc, agent, observability.NewMetrics(), slog.New(slog.NewTextHandler(io.Discard, nil)))

	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 1)

	if b.Wait(50 * time.Millisecond) {
		t.Error("Wait() reported a clean drain while an analysis was still running")
	}
	close(agent.release)
	if !b.Wait(3 * time.Second) {
		t.Error("Wait() did not observe the finished analysis")
	}
}

func lookupConfig() config.Config {
	cfg := testConfig()
	cfg.ParentMode = config.ParentModeLookup
	return cfg
}

// In lookup mode Alertmanager posts the alert, so the bridge must publish
// exactly one message: the thread reply under the notification it found.
func TestLookupModeOnlyPostsThreadReply(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{reply: "*Summary* OOMKilled"}
	sc.found = "ts-from-history"
	b := newTestBridge(t, lookupConfig(), sc, agent)

	if rec := post(t, b, criticalAlert, nil); rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202", rec.Code)
	}

	msgs := sc.waitFor(t, 1)
	if len(msgs) != 1 {
		t.Fatalf("posted %d messages, want only the thread reply", len(msgs))
	}
	reply := msgs[0]
	if reply.ThreadTS != "ts-from-history" {
		t.Errorf("thread_ts = %q, want the timestamp found in history", reply.ThreadTS)
	}
	if reply.Title != "" || reply.Color != "" {
		t.Errorf("reply should be plain, got title %q color %q", reply.Title, reply.Color)
	}
	if reply.Text != "*Summary* OOMKilled" {
		t.Errorf("text = %q", reply.Text)
	}
	if sc.lookups() != 1 {
		t.Errorf("lookups = %d, want 1", sc.lookups())
	}
	// The marker must be the alert fingerprint, which is what the Alertmanager
	// template renders into the notification.
	if sc.markers[0] != "fp-1" {
		t.Errorf("marker = %q, want the alert fingerprint", sc.markers[0])
	}
	if window := time.Since(sc.sinceValues[0]); window < 14*time.Minute || window > 16*time.Minute {
		t.Errorf("history window = %s, want about 15m", window)
	}
}

// An alert nobody analyses must cost nothing: Alertmanager already told Slack
// about it, so the bridge has no reason to call the API at all.
func TestLookupModeSkipsSlackEntirelyWhenNotAnalysing(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
	b := newTestBridge(t, lookupConfig(), sc, agent)

	post(t, b, `{"groupKey":"g","status":"firing","commonLabels":{"alertname":"A","severity":"warning"},
		"alerts":[{"status":"firing","labels":{"severity":"warning"}}]}`, nil)
	b.Wait(time.Second)

	if got := len(sc.all()); got != 0 {
		t.Errorf("posted %d messages, want none", got)
	}
	if sc.lookups() != 0 {
		t.Errorf("lookups = %d, want none", sc.lookups())
	}
	if agent.promptCount() != 0 {
		t.Error("agent ran for a filtered alert")
	}
}

// Alertmanager delivers the Slack notification and the webhook independently,
// so a miss can just mean the notification has not arrived yet.
func TestLookupModeRetriesWhenNotificationIsLate(t *testing.T) {
	cfg := lookupConfig()
	cfg.LookupAttempts = 3
	sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
	sc.lookupErr = slack.ErrMessageNotFound
	b := newTestBridge(t, cfg, sc, agent)

	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 1)

	if sc.lookups() != 3 {
		t.Errorf("lookups = %d, want %d", sc.lookups(), cfg.LookupAttempts)
	}
}

// The analysis is already paid for when the lookup fails, so it is posted at
// channel level with the alert title rather than thrown away.
func TestLookupModeFallsBackToChannelLevelPost(t *testing.T) {
	cfg := lookupConfig()
	cfg.LookupAttempts = 1
	sc, agent := newFakeSlack(), &fakeAgent{reply: "*Summary* OOMKilled"}
	sc.lookupErr = slack.ErrMessageNotFound
	b := newTestBridge(t, cfg, sc, agent)

	post(t, b, criticalAlert, nil)

	msgs := sc.waitFor(t, 1)
	if msgs[0].ThreadTS != "" {
		t.Errorf("thread_ts = %q, want an unthreaded message", msgs[0].ThreadTS)
	}
	if msgs[0].Title != "🚨 [FIRING] KubePodCrashLooping" {
		t.Errorf("fallback lost the alert title: %q", msgs[0].Title)
	}
	if msgs[0].Text != "*Summary* OOMKilled" {
		t.Errorf("fallback lost the analysis: %q", msgs[0].Text)
	}
}

// A permission or transport failure will not fix itself between attempts.
func TestLookupModeDoesNotRetryPermanentError(t *testing.T) {
	cfg := lookupConfig()
	cfg.LookupAttempts = 3
	sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
	sc.lookupErr = errors.New("missing_scope")
	b := newTestBridge(t, cfg, sc, agent)

	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 1)

	if sc.lookups() != 1 {
		t.Errorf("lookups = %d, want 1", sc.lookups())
	}
}

// A failed analysis still deserves a note in the alert's thread.
func TestLookupModeThreadsFailureNotices(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{err: errors.New("bedrock throttled")}
	sc.found = "ts-from-history"
	b := newTestBridge(t, lookupConfig(), sc, agent)

	post(t, b, criticalAlert, nil)

	msgs := sc.waitFor(t, 1)
	if msgs[0].ThreadTS != "ts-from-history" {
		t.Errorf("failure notice was not threaded: %+v", msgs[0])
	}
	if !strings.Contains(msgs[0].Text, "bedrock throttled") {
		t.Errorf("text = %q", msgs[0].Text)
	}
}

func TestMarkerFallsBackToGroupKey(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
	b := newTestBridge(t, lookupConfig(), sc, agent)

	post(t, b, `{"groupKey":"gk-only","status":"firing","commonLabels":{"alertname":"A","severity":"critical"},
		"alerts":[{"status":"firing","labels":{"severity":"critical"}}]}`, nil)
	sc.waitFor(t, 1)

	if sc.markers[0] != "gk-only" {
		t.Errorf("marker = %q, want the group key", sc.markers[0])
	}
}

// The webhook counter only sees alert groups, so the per-alert counter is what
// tells an operator how much alert volume a group actually carried.
func TestWebhookCountsIndividualAlerts(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{reply: "ok"}
	b := newTestBridge(t, testConfig(), sc, agent)

	post(t, b, `{"groupKey":"gk-multi","status":"firing",
		"commonLabels":{"alertname":"A","severity":"critical"},
		"alerts":[
			{"status":"firing","fingerprint":"fp-1","labels":{"severity":"critical"}},
			{"status":"firing","fingerprint":"fp-2","labels":{"severity":"warning"}},
			{"status":"resolved","fingerprint":"fp-3","labels":{}}]}`, nil)

	for _, tc := range []struct {
		severity, status string
		want             float64
	}{
		{"critical", "firing", 1},
		{"warning", "firing", 1},
		// The third alert carries no severity of its own, so it inherits the
		// group's common label rather than counting as unknown.
		{"critical", "resolved", 1},
	} {
		got := metricValue(t, b, "kagent_alert_bridge_alerts_received_total", map[string]string{"severity": tc.severity, "status": tc.status})
		if got != tc.want {
			t.Errorf("alerts_received_total{severity=%q,status=%q} = %v, want %v", tc.severity, tc.status, got, tc.want)
		}
	}
}

// A truncated thread reply is content the reader never sees, which is only
// visible if the cut is counted.
func TestTruncatedAnalysisIsCounted(t *testing.T) {
	cfg := testConfig()
	cfg.SlackMaxTextRune = 500
	sc, agent := newFakeSlack(), &fakeAgent{reply: strings.Repeat("한", 600)}
	b := newTestBridge(t, cfg, sc, agent)

	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 2)

	if got := metricValue(t, b, "kagent_alert_bridge_slack_messages_truncated_total", map[string]string{"kind": "thread"}); got != 1 {
		t.Errorf("slack_messages_truncated_total{kind=\"thread\"} = %v, want 1", got)
	}
	if got := metricValue(t, b, "kagent_alert_bridge_slack_messages_truncated_total", map[string]string{"kind": "parent"}); got != 0 {
		t.Errorf("the short alert body was counted as truncated: %v", got)
	}
}

// The dedupe store is the bridge's only unbounded state, and the gauge is the
// only way to see it from outside the process.
func TestDedupeGaugeTracksStore(t *testing.T) {
	sc, agent := newFakeSlack(), &fakeAgent{err: errors.New("agent down")}
	b := newTestBridge(t, testConfig(), sc, agent)

	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 2)

	// The failed run forgets its key so the next resend retries, which has to
	// leave the gauge at zero rather than at its pre-failure value.
	if got := metricValue(t, b, "kagent_alert_bridge_dedupe_entries", nil); got != 0 {
		t.Errorf("dedupe_entries = %v, want 0 after the failed analysis dropped its key", got)
	}

	agent.mu.Lock()
	agent.err = nil
	agent.reply = "ok"
	agent.mu.Unlock()

	post(t, b, criticalAlert, nil)
	sc.waitFor(t, 4)
	if got := metricValue(t, b, "kagent_alert_bridge_dedupe_entries", nil); got != 1 {
		t.Errorf("dedupe_entries = %v, want 1 after a successful analysis", got)
	}
}

// The slot limit is published as a series so a dashboard can express saturation
// as a ratio instead of hardcoding MAX_CONCURRENT_ANALYSES.
func TestAnalysisSlotsGaugePublishesTheLimit(t *testing.T) {
	cfg := testConfig()
	cfg.MaxConcurrent = 5
	b := newTestBridge(t, cfg, newFakeSlack(), &fakeAgent{reply: "ok"})

	if got := metricValue(t, b, "kagent_alert_bridge_analysis_slots", nil); got != 5 {
		t.Errorf("analysis_slots = %v, want 5", got)
	}
}

// metricValue reads one series off the bridge's own registry. Gathering rather
// than reading the collector keeps the assertion honest about what a scrape
// would show, and it needs no extra test dependency.
func metricValue(t *testing.T, b *Bridge, name string, labels map[string]string) float64 {
	t.Helper()
	families, err := b.metrics.Registry().Gather()
	if err != nil {
		t.Fatalf("Gather() error = %v", err)
	}
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, metric := range family.GetMetric() {
			if !hasLabels(metric.GetLabel(), labels) {
				continue
			}
			if metric.Counter != nil {
				return metric.GetCounter().GetValue()
			}
			return metric.GetGauge().GetValue()
		}
	}
	// An untouched counter has no series yet, which reads as zero.
	return 0
}

func hasLabels(pairs []*dto.LabelPair, want map[string]string) bool {
	got := map[string]string{}
	for _, pair := range pairs {
		got[pair.GetName()] = pair.GetValue()
	}
	for k, v := range want {
		if got[k] != v {
			return false
		}
	}
	return true
}

func decodePayload(t *testing.T, body string) alert.Payload {
	t.Helper()
	var p alert.Payload
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	return p
}
