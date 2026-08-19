package gateway

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/a2a"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/observability"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/slack"
	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/socket"
)

// envelopeTTL is how long a handled envelope id is remembered. Slack redelivers
// an envelope whose acknowledgement did not arrive in time, and the
// acknowledgement can be lost after the turn has already started, so the window
// only has to outlive Slack's own retry.
const envelopeTTL = 5 * time.Minute

// workingReaction marks the mention while the agent works and is removed when
// the answer lands. Unlike the alert reactions it is not configurable: the
// status message already carries the state in words, so the emoji is only
// there to mark the message somebody has scrolled past, and one fixed choice
// is one less thing to keep consistent across deployments. It makes
// reactions:write a requirement wherever mentions are enabled.
const workingReaction = "eyes"

// mentionPattern matches the leading user mention, which Slack renders as a
// link rather than as the handle people typed. The anchor is what keeps this
// to the leading one: a mention further in the text names somebody the question
// is about, and stripping it would turn "did @younsl deploy this?" into a
// question about nobody.
//
// It matches on the link form rather than on a handle, so the bot's display
// name is Slack's business alone and renaming the app changes nothing here.
var mentionPattern = regexp.MustCompile(`^\s*<@[A-Z0-9]+(\|[^>]*)?>`)

// HandleEvent routes one Socket Mode event. It runs on the read loop, so
// everything past the gating happens on a goroutine of its own.
func (g *Gateway) HandleEvent(ctx context.Context, ev socket.Event) {
	g.logger.Debug("socket event received", "type", ev.Type, "channel", ev.ChannelID, "envelope_id", ev.EnvelopeID, "raw", string(ev.Raw))

	text, reason := g.mentionText(ev)
	if reason != "" {
		g.metrics.ChatEvents.WithLabelValues(reason).Inc()
		g.hint(ctx, ev, reason)
		g.logger.Debug("dropped mention", "reason", reason, "channel", ev.ChannelID, "user", ev.User)
		return
	}

	agent := g.resolveChatAgent(ctx, ev.ChannelID)
	g.metrics.ChatEvents.WithLabelValues("accepted").Inc()
	logger := g.logger.With(
		"channel", ev.ChannelID, "thread_ts", ev.ThreadTS,
		"user", ev.User, "agent", agent,
	)
	g.wg.Go(func() {
		g.handleMention(ev, text, agent, logger)
	})
}

// mentionText applies the drop rules and returns the question with the leading
// mention stripped. A non-empty reason means the event is dropped, and doubles
// as the metric label so every drop is visible without a log line.
func (g *Gateway) mentionText(ev socket.Event) (string, string) {
	switch {
	case ev.Type != "app_mention":
		return "", "subtype"
	// The gateway posts into the same channels it listens to, so its own
	// messages must never start a turn. A post by the app carries bot_id even
	// when the mention path never sent it.
	case ev.BotID != "" || (g.botUserID != "" && ev.User == g.botUserID):
		return "", "bot"
	// thread_broadcast is a thread reply somebody chose to also send to the
	// channel, which is a real mention. Every other subtype is an edit, a
	// deletion, or a join.
	case ev.Subtype != "" && ev.Subtype != "thread_broadcast":
		return "", "subtype"
	// No DM scope is requested and a DM arrives as message.im rather than
	// app_mention, so this is unreachable today. It guards against a later
	// scope change opening DMs by omission, since an empty channel allow list
	// means every channel.
	case ev.ChannelType == "im" || ev.ChannelType == "mpim" || strings.HasPrefix(ev.ChannelID, "D"):
		return "", "dm"
	case len(g.cfg.ChatAllowedUsers) > 0 && !g.cfg.ChatAllowedUsers[ev.User]:
		return "", "user_denied"
	case ev.ThreadTS == "":
		return "", "not_in_thread"
	case !g.envelopes.allow(ev.EnvelopeID, g.now()):
		return "", "duplicate"
	}

	if !g.chatChannelAllowed(context.Background(), ev.ChannelID) {
		return "", "channel_denied"
	}
	text := g.question(ev.Text)
	if text == "" {
		return "", "empty"
	}
	return text, ""
}

// question turns the mention text into the prompt: the handle that addressed
// the bot is dropped, and every other mention is kept because it names
// somebody the question is about.
//
// A trailing "look at this @bot" is stripped too, which the leading pattern
// alone cannot do. That one needs the bot's own id, so it only applies when
// auth.test resolved it.
func (g *Gateway) question(text string) string {
	text = mentionPattern.ReplaceAllString(text, " ")
	if g.botUserID != "" {
		text = strings.ReplaceAll(text, "<@"+g.botUserID+">", " ")
	}
	return strings.TrimSpace(text)
}

// hint answers the two drops a person has no way to tell from an outage. The
// note is ephemeral, so the rule is discoverable without leaving anything in
// channel history, and it costs no agent run.
func (g *Gateway) hint(ctx context.Context, ev socket.Event, reason string) {
	var text string
	switch reason {
	case "not_in_thread":
		text = g.cfg.ChatThreadHint
	case "channel_denied":
		// The hint says only that this channel is not served. Naming the
		// channels that are would turn the bot into a directory of where it
		// may be used.
		text = g.cfg.ChatDeniedHint
	}
	if text == "" || ev.User == "" {
		return
	}
	// The event's own thread is used when there is one, so a denied mention
	// inside a thread is answered where it was asked.
	if err := g.slack.PostEphemeral(ctx, ev.ChannelID, ev.ThreadTS, ev.User, text); err != nil {
		g.metrics.SlackMessages.WithLabelValues("hint", "error").Inc()
		g.logger.Warn("failed to post mention hint", "reason", reason, "error", err)
		return
	}
	g.metrics.SlackMessages.WithLabelValues("hint", "ok").Inc()
}

// handleMention runs one turn: a status message goes up straight away, the
// agent runs against the thread's session, and the status message is rewritten
// with the answer.
func (g *Gateway) handleMention(ev socket.Event, text, agent string, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), g.cfg.ChatTimeout)
	defer cancel()

	started := g.now()
	defer func() { g.metrics.ChatTurnDuration.Observe(g.now().Sub(started).Seconds()) }()

	// The status message is posted before the slot is taken, so a mention is
	// acknowledged in the thread even while every slot is busy. It is rewritten
	// in place from here on, which keeps one message per turn instead of one
	// per state change.
	status := g.newStatus(ev.ChannelID, ev.ThreadTS, started, logger)
	status.post(ctx, queuedStatus())

	select {
	case g.chatSem <- struct{}{}:
		defer func() { <-g.chatSem }()
	case <-ctx.Done():
		g.metrics.ChatTurns.WithLabelValues(agent, "queue_timeout").Inc()
		logger.Error("gave up waiting for a chat slot", "timeout", g.cfg.ChatTimeout.String())
		status.finish(":warning: 답변을 시작하지 못했습니다: 대화 슬롯이 모두 사용 중입니다.")
		return
	}

	g.metrics.ChatInflight.Inc()
	defer g.metrics.ChatInflight.Dec()

	if err := g.slack.AddReaction(ctx, ev.ChannelID, ev.TS, workingReaction); err != nil {
		logger.Warn("failed to add working reaction", "error", err)
	}
	// The removal gets its own context: by the time it runs, ctx has often
	// been consumed by the agent call the reaction was covering.
	defer func() {
		rctx, rcancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer rcancel()
		if err := g.slack.RemoveReaction(rctx, ev.ChannelID, ev.TS, workingReaction); err != nil {
			logger.Warn("failed to remove working reaction", "error", err)
		}
	}()

	sessionKey := ev.ChannelID + "/" + ev.ThreadTS
	sess := g.sessions.get(sessionKey, g.now())
	if sess.contextID != "" {
		logger = logger.With("context_id", sess.contextID)
	}

	// The alert is sent on every turn, not just the first: it is a few hundred
	// characters, and a session that has it already loses nothing by seeing it
	// again, while a session that lost it would answer about nothing.
	prompt, withAlert := g.chatPrompt(text), false
	if block, ok := g.alertContext(ctx, ev, logger); ok {
		prompt, withAlert = g.chatPrompt(block+"\n\n"+questionHeading+"\n"+text), true
	}

	// The agent's own state drives the status line, and a ticker does the Slack
	// call: the progress hook runs on the polling goroutine, where a blocking
	// write would stall the poll it is reporting on.
	var state progressState
	stop := status.track(&state, agent, withAlert)

	logger.Info("requesting chat turn", "chars", len(text))
	result, err := g.agent.Send(ctx, a2a.Request{
		Agent:      agent,
		Text:       prompt,
		ContextID:  sess.contextID,
		OnProgress: state.record,
	})
	stop()
	elapsed := g.now().Sub(started)

	if err != nil {
		g.metrics.ChatTurns.WithLabelValues(agent, "error").Inc()
		logger.Error("chat turn failed", "error", err, "duration", elapsed.String())
		status.finish(fmt.Sprintf(":warning: 답변을 만들지 못했습니다. %s", userMessage(err)))
		return
	}

	g.sessions.put(sessionKey, session{contextID: result.ContextID}, g.now())
	g.metrics.ChatSessions.Set(float64(g.sessions.size()))
	g.metrics.ChatTurns.WithLabelValues(agent, "ok").Inc()
	logger.Info("chat turn completed",
		"duration", elapsed.String(), "task_id", result.TaskID,
		"context_id", result.ContextID, "chars", len(result.Text))
	status.finish(g.truncate("chat", result.Text))
}

// Headings that shape a mention prompt. They are deliberately plain: the alert
// is quoted material somebody else wrote, not an instruction, and the heading
// is what tells the agent so.
const (
	alertHeading    = "[Alert this question was asked under]"
	contextHeading  = "[Slack context]"
	questionHeading = "[Question]"
)

// parentMax caps the quoted alert. An Alertmanager notification is a few
// hundred characters; anything past this is a template that got away, and
// truncating it is better than letting it crowd out the question. It is not
// configurable because there is nothing an operator would tune it to.
const parentMax = 2000

// alertContext renders what a mention carries besides the question: the alert
// the thread hangs from, and the identifiers an agent needs to read the rest of
// the thread through its own Slack tools.
//
// Only the parent is sent. Everything else in the thread is the agent's to
// fetch, which keeps the gateway out of the business of guessing how much of a
// conversation a question needs. The parent is the one exception because a
// question about an alert is unanswerable without it, and an agent that has to
// discover it through a tool call may simply not make one.
//
// A failure is not fatal: the turn continues with the question alone.
func (g *Gateway) alertContext(ctx context.Context, ev socket.Event, logger *slog.Logger) (string, bool) {
	parent, err := g.slack.ThreadParent(ctx, ev.ChannelID, ev.ThreadTS)
	if err != nil {
		logger.Warn("failed to read the thread parent, answering the question alone", "error", err)
		return "", false
	}
	if parent.Text == "" {
		return "", false
	}

	block := alertHeading + "\n" + slack.Truncate(parent.Text, parentMax) +
		"\n\n" + contextHeading +
		"\nchannel_id: " + ev.ChannelID +
		"\nthread_ts: " + ev.ThreadTS
	logger.Info("read the thread parent", "chars", len(parent.Text))
	return block, true
}

// chatPrompt appends the chat instructions to the question. They are separate
// from the analysis instructions because a question has no alert sections to
// fill.
func (g *Gateway) chatPrompt(text string) string {
	if g.cfg.ChatInstructions == "" {
		return text
	}
	return text + "\n\n" + g.cfg.ChatInstructions
}

// chatChannelAllowed reports whether the channel may invoke the bot. An empty
// allow list allows every channel the bot is a member of, which Slack already
// bounds: an app_mention only arrives from a channel the bot was invited to.
//
// The allow list holds names or IDs while the event only carries an ID, so a
// name is resolved through the Slack client, whose channel cache makes the
// repeat lookups free.
func (g *Gateway) chatChannelAllowed(ctx context.Context, channelID string) bool {
	if len(g.cfg.ChatChannels) == 0 {
		return true
	}
	for _, entry := range g.cfg.ChatChannels {
		if g.chatChannelID(ctx, entry) == channelID {
			return true
		}
	}
	return false
}

// resolveChatAgent picks the agent that answers in a channel. Unlike the alert
// path's routing there is no label to read, so the table is keyed by channel.
func (g *Gateway) resolveChatAgent(ctx context.Context, channelID string) string {
	for entry, agent := range g.cfg.ChatAgentMap {
		if g.chatChannelID(ctx, entry) == channelID {
			return agent
		}
	}
	return g.cfg.ChatAgent
}

// chatChannelID maps a configured channel name or ID to its conversation ID,
// returning an empty string when it cannot be resolved. A misspelt entry must
// not match anything, so a failure is a non-match rather than an error.
func (g *Gateway) chatChannelID(ctx context.Context, entry string) string {
	id, err := g.slack.ResolveChannelID(ctx, entry)
	if err != nil {
		g.logger.Warn("failed to resolve configured chat channel", "channel", entry, "error", err)
		return ""
	}
	return id
}

// progressState is the last task state the agent reported. It is written from
// the polling goroutine and read by the status ticker.
type progressState struct {
	mu    sync.Mutex
	state string
}

func (p *progressState) record(pr a2a.Progress) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.state = pr.State
}

func (p *progressState) read() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.state
}

// statusMessage is the single thread reply a turn owns. It starts as a "queued"
// note, is rewritten while the agent works, and ends as the answer itself, so
// the asker watches one message rather than a thread of progress notes.
type statusMessage struct {
	slack   SlackClient
	metrics *observability.Metrics
	logger  *slog.Logger
	now     func() time.Time
	channel string
	thread  string
	started time.Time
	// interval is how often the line is rewritten while the agent works. Zero
	// leaves the first status standing until the answer replaces it.
	interval time.Duration

	mu sync.Mutex
	// ts is the message being rewritten, empty when the initial post failed.
	ts string
}

func (g *Gateway) newStatus(channel, thread string, started time.Time, logger *slog.Logger) *statusMessage {
	return &statusMessage{
		slack:    g.slack,
		metrics:  g.metrics,
		logger:   logger,
		now:      g.now,
		channel:  channel,
		thread:   thread,
		started:  started,
		interval: g.cfg.ChatStatusInterval,
	}
}

// post publishes the first status line. A failure is not fatal: the turn still
// runs, and its answer is posted as a new message at the end.
func (s *statusMessage) post(ctx context.Context, text string) {
	ts, err := s.slack.Post(ctx, slack.Message{Channel: s.channel, ThreadTS: s.thread, Text: text})
	if err != nil {
		s.metrics.SlackMessages.WithLabelValues("status", "error").Inc()
		s.logger.Warn("failed to post chat status", "error", err)
		return
	}
	s.metrics.SlackMessages.WithLabelValues("status", "ok").Inc()
	s.mu.Lock()
	s.ts = ts
	s.mu.Unlock()
}

// timestamp reports the status message's own ts, empty when the post failed.
// The thread reader uses it to skip the placeholder this turn just posted.
func (s *statusMessage) timestamp() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ts
}

// set rewrites the status line in place. Nothing is posted when the initial
// status message never landed, because a status without a message to replace
// would turn every refresh into a new thread reply.
func (s *statusMessage) set(ctx context.Context, text string) {
	s.mu.Lock()
	ts := s.ts
	s.mu.Unlock()
	if ts == "" {
		return
	}
	if err := s.slack.Update(ctx, s.channel, ts, text); err != nil {
		s.logger.Warn("failed to update chat status", "error", err)
	}
}

// finish replaces the status line with the final text, which is the answer or
// the reason there is none. It runs on its own context: the turn's deadline is
// usually what brought it here.
func (s *statusMessage) finish(text string) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	s.mu.Lock()
	ts := s.ts
	s.mu.Unlock()

	if ts != "" {
		err := s.slack.Update(ctx, s.channel, ts, text)
		if err == nil {
			s.metrics.SlackMessages.WithLabelValues("chat", "ok").Inc()
			return
		}
		s.logger.Warn("failed to rewrite chat status with the answer, posting it instead", "error", err)
	}
	// The turn is already paid for, so the answer is posted as a new message
	// rather than discarded when the status message cannot carry it.
	if _, err := s.slack.Post(ctx, slack.Message{Channel: s.channel, ThreadTS: s.thread, Text: text}); err != nil {
		s.metrics.SlackMessages.WithLabelValues("chat", "error").Inc()
		s.logger.Error("failed to post chat reply", "error", err)
		return
	}
	s.metrics.SlackMessages.WithLabelValues("chat", "ok").Inc()
}

// track refreshes the status line on a ticker until the returned function is
// called. The ticker owns the Slack call so the agent's polling goroutine never
// waits on one.
func (s *statusMessage) track(state *progressState, agent string, withAlert bool) func() {
	interval := s.interval
	if interval <= 0 {
		return func() {}
	}
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				s.set(ctx, workingStatus(agent, s.now().Sub(s.started), state.read(), withAlert))
				cancel()
			}
		}
	}()
	return func() {
		close(done)
		<-stopped
	}
}

// queuedStatus is the note posted the moment a mention is accepted, before a
// slot is even held, so the asker sees the bot took the question.
func queuedStatus() string {
	return ":hourglass_flowing_sand: 질문을 받았습니다. 실행 슬롯이 비는 대로 확인을 시작합니다."
}

// workingStatus renders the live status line: what the agent is doing and how
// long it has been at it, so a turn that takes minutes never looks like a bot
// that stopped answering.
//
// The poll count the progress hook also carries is deliberately absent. It is
// the elapsed time divided by KAGENT_POLL_INTERVAL, so it repeats a number the
// line already shows, and the one case where it diverges, a controller that
// stopped answering, is what agent_requests_total reports.
// withAlert says whether the alert the thread hangs from went along with the
// question. It changes the sentence rather than adding one, because a second
// sentence would read as something the agent did, and reading the alert is the
// gateway's own doing.
func workingStatus(agent string, elapsed time.Duration, state string, withAlert bool) string {
	return fmt.Sprintf(":mag: kagent의 %s 에이전트가 %s (경과 %s)",
		agent, statePhrase(state, withAlert), koreanDuration(elapsed))
}

// statePhrase turns an A2A task state into the sentence it belongs in. The raw
// state is a protocol token, not something a reader in Slack can act on, so
// only an unrecognised one is shown verbatim, where it is a debugging aid
// rather than noise.
//
// withAlert changes the sentence rather than adding one after it. A second
// sentence would read as something the agent did, and reading the alert is the
// gateway's own doing.
func statePhrase(state string, withAlert bool) string {
	switch state {
	case "", "submitted":
		if withAlert {
			return "이 스레드의 알람으로 작업을 시작했습니다."
		}
		return "작업을 시작했습니다."
	case "working":
		if withAlert {
			return "이 스레드의 알람을 확인 중입니다."
		}
		return "확인 중입니다."
	default:
		return fmt.Sprintf("확인 중입니다. (상태 %s)", state)
	}
}
