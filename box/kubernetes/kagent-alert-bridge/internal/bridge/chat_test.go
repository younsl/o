package bridge

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/a2a"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/config"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/socket"
)

const (
	testChannel = "C123"
	testThread  = "1700000000.000100"
	testUser    = "U777"
	botUser     = "U000BOT"
)

func chatConfig() config.Config {
	cfg := testConfig()
	cfg.SlackAppToken = "xapp-test"
	cfg.ChatAgent = "alert-triage-agent"
	cfg.ChatTimeout = 2 * time.Second
	cfg.ChatSessionTTL = time.Hour
	cfg.ChatStatusInterval = 10 * time.Millisecond
	cfg.ChatWorkingReaction = "eyes"
	cfg.ChatThreadHint = config.DefaultThreadHint
	cfg.ChatDeniedHint = config.DefaultDeniedHint
	cfg.ChatInstructions = "answer directly"
	cfg.MaxConcurrentChats = 1
	return cfg
}

func mention(mutate func(*socket.Event)) socket.Event {
	ev := socket.Event{
		EnvelopeID:  "env-1",
		Type:        "app_mention",
		ChannelID:   testChannel,
		ChannelType: "channel",
		User:        testUser,
		Text:        "<@" + botUser + "> why is the pod restarting?",
		TS:          "1700000001.000100",
		ThreadTS:    testThread,
	}
	if mutate != nil {
		mutate(&ev)
	}
	return ev
}

// newChatBridge wires a bridge with the mention path enabled and the loop guard
// pointed at the bot's own user id.
func newChatBridge(t *testing.T, cfg config.Config, sc SlackClient, agent AgentClient) *Bridge {
	t.Helper()
	b := newTestBridge(t, cfg, sc, agent)
	b.SetBotUserID(botUser)
	return b
}

func TestMentionAnswersInThread(t *testing.T) {
	sc := newFakeSlack()
	agent := &fakeAgent{reply: "the pod is OOMKilled", replyCtxID: "ctx-1"}
	b := newChatBridge(t, chatConfig(), sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)

	// One message goes up: the status line, rewritten in place until it holds
	// the answer. A thread of progress notes would be the failure here.
	messages := sc.all()
	if len(messages) != 1 {
		t.Fatalf("posted %d messages, want exactly the status message: %+v", len(messages), messages)
	}
	if messages[0].ThreadTS != testThread {
		t.Fatalf("status posted in thread %q, want %q", messages[0].ThreadTS, testThread)
	}
	if !strings.Contains(messages[0].Text, "질문을 받았습니다") {
		t.Fatalf("first status is %q, want the accepted note", messages[0].Text)
	}
	if got := sc.lastUpdate(); got != "the pod is OOMKilled" {
		t.Fatalf("status message ends as %q, want the agent's answer", got)
	}
	if got := agent.lastAgent(); got != "alert-triage-agent" {
		t.Fatalf("routed to agent %q, want the default chat agent", got)
	}
	if got := agent.lastContextID(); got != "" {
		t.Fatalf("first turn continued session %q, want a fresh one", got)
	}
	// The mention carries the question with the leading handle stripped, and
	// the chat instructions rather than the analysis ones.
	prompt := agent.prompts[0]
	if strings.Contains(prompt, "<@") || !strings.HasPrefix(prompt, "why is the pod restarting?") {
		t.Fatalf("prompt is %q, want the question without the leading mention", prompt)
	}
	if !strings.Contains(prompt, "answer directly") {
		t.Fatalf("prompt is %q, want the chat instructions appended", prompt)
	}
	if reactions := sc.allReactions(); len(reactions) != 2 ||
		reactions[0] != "add eyes 1700000001.000100" || reactions[1] != "remove eyes 1700000001.000100" {
		t.Fatalf("working reaction not placed on the mention: %v", reactions)
	}
}

// The status line is what tells an asker the turn is alive, so it has to be
// rewritten while the agent works, carrying the state the controller reports.
func TestMentionReportsProgressWhileTheAgentWorks(t *testing.T) {
	sc := newFakeSlack()
	release := make(chan struct{})
	agent := &fakeAgent{
		reply:   "done",
		release: release,
		progress: []a2a.Progress{
			{TaskID: "task-1", State: "submitted"},
			{TaskID: "task-1", State: "working", Polls: 2},
		},
	}
	b := newChatBridge(t, chatConfig(), sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	updates := sc.waitForUpdate(t, 1)
	if !strings.Contains(updates[0].text, "확인 중입니다") {
		t.Fatalf("status while working is %q, want the working note", updates[0].text)
	}
	if !strings.Contains(updates[0].text, "경과") || !strings.Contains(updates[0].text, "alert-triage-agent") {
		t.Fatalf("status %q is missing the agent or the elapsed time", updates[0].text)
	}
	// The raw A2A state is a protocol token, not something a reader can act on.
	if strings.Contains(updates[0].text, "working") || strings.Contains(updates[0].text, "조회") {
		t.Fatalf("status %q leaks polling internals into the thread", updates[0].text)
	}
	if updates[0].ts != "ts-parent" || updates[0].channel != testChannel {
		t.Fatalf("status rewritten on %s/%s, want the status message itself", updates[0].channel, updates[0].ts)
	}

	close(release)
	b.Wait(3 * time.Second)
	if got := sc.lastUpdate(); got != "done" {
		t.Fatalf("final status is %q, want the answer", got)
	}
}

func TestMentionContinuesTheThreadSession(t *testing.T) {
	sc := newFakeSlack()
	agent := &fakeAgent{reply: "first", replyCtxID: "ctx-1"}
	b := newChatBridge(t, chatConfig(), sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)

	b.HandleEvent(context.Background(), mention(func(ev *socket.Event) { ev.EnvelopeID = "env-2" }))
	b.Wait(3 * time.Second)

	if got := agent.lastContextID(); got != "ctx-1" {
		t.Fatalf("follow-up continued session %q, want ctx-1", got)
	}
	if got := b.sessions.size(); got != 1 {
		t.Fatalf("session store holds %d threads, want 1", got)
	}
}

// A thread idle past the TTL starts cold, which costs one turn rather than
// correctness.
func TestMentionStartsFreshAfterTheSessionExpires(t *testing.T) {
	sc := newFakeSlack()
	agent := &fakeAgent{reply: "first", replyCtxID: "ctx-1"}
	cfg := chatConfig()
	cfg.ChatSessionTTL = 50 * time.Millisecond
	b := newChatBridge(t, cfg, sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)

	time.Sleep(60 * time.Millisecond)
	b.HandleEvent(context.Background(), mention(func(ev *socket.Event) { ev.EnvelopeID = "env-2" }))
	b.Wait(3 * time.Second)

	if got := agent.lastContextID(); got != "" {
		t.Fatalf("expired thread continued session %q, want a fresh one", got)
	}
}

func TestMentionDropRules(t *testing.T) {
	tests := []struct {
		name    string
		event   socket.Event
		channel []string
		users   map[string]bool
		want    string
	}{
		{
			name:  "own message",
			event: mention(func(ev *socket.Event) { ev.User = botUser }),
			want:  "bot",
		},
		{
			name:  "another bot",
			event: mention(func(ev *socket.Event) { ev.BotID = "B123" }),
			want:  "bot",
		},
		{
			name:  "edited message",
			event: mention(func(ev *socket.Event) { ev.Subtype = "message_changed" }),
			want:  "subtype",
		},
		{
			name:  "other event type",
			event: mention(func(ev *socket.Event) { ev.Type = "message" }),
			want:  "subtype",
		},
		{
			name:  "direct message",
			event: mention(func(ev *socket.Event) { ev.ChannelID = "D123"; ev.ChannelType = "im" }),
			want:  "dm",
		},
		{
			name:  "channel level",
			event: mention(func(ev *socket.Event) { ev.ThreadTS = "" }),
			want:  "not_in_thread",
		},
		{
			name:    "channel outside the allow list",
			event:   mention(nil),
			channel: []string{"C999"},
			want:    "channel_denied",
		},
		{
			name:  "user outside the allow list",
			event: mention(nil),
			users: map[string]bool{"U111": true},
			want:  "user_denied",
		},
		{
			name:  "mention with no question",
			event: mention(func(ev *socket.Event) { ev.Text = "<@" + botUser + ">   " }),
			want:  "empty",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := chatConfig()
			cfg.ChatChannels = tc.channel
			cfg.ChatAllowedUsers = tc.users
			sc, agent := newFakeSlack(), &fakeAgent{reply: "unused"}
			b := newChatBridge(t, cfg, sc, agent)

			b.HandleEvent(context.Background(), tc.event)
			b.Wait(time.Second)

			if got := agent.promptCount(); got != 0 {
				t.Fatalf("a dropped mention started %d agent runs, want none", got)
			}
			if got := counterValue(t, b, "chat_events_total", tc.want); got != 1 {
				t.Fatalf("chat_events_total{result=%q} is %v, want 1", tc.want, got)
			}
		})
	}
}

// A thread reply sent with "also send to channel" is a real mention somebody
// just typed, so the exempted subtype must be answered rather than dropped.
func TestMentionAcceptsThreadBroadcast(t *testing.T) {
	sc := newFakeSlack()
	agent := &fakeAgent{reply: "answered"}
	b := newChatBridge(t, chatConfig(), sc, agent)

	b.HandleEvent(context.Background(), mention(func(ev *socket.Event) { ev.Subtype = "thread_broadcast" }))
	b.Wait(3 * time.Second)

	if got := agent.promptCount(); got != 1 {
		t.Fatalf("a thread broadcast started %d agent runs, want 1", got)
	}
	// The bridge answers in the thread and never broadcasts its own reply.
	if messages := sc.all(); len(messages) != 1 || messages[0].ThreadTS != testThread {
		t.Fatalf("broadcast answered outside the thread: %+v", messages)
	}
}

// Slack redelivers an envelope whose acknowledgement was lost, which must not
// cost a second agent run.
func TestMentionIgnoresRedeliveredEnvelope(t *testing.T) {
	sc := newFakeSlack()
	agent := &fakeAgent{reply: "answered"}
	b := newChatBridge(t, chatConfig(), sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)
	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)

	if got := agent.promptCount(); got != 1 {
		t.Fatalf("a redelivered envelope started %d agent runs, want 1", got)
	}
	if got := counterValue(t, b, "chat_events_total", "duplicate"); got != 1 {
		t.Fatalf("chat_events_total{result=duplicate} is %v, want 1", got)
	}
}

func TestMentionHints(t *testing.T) {
	tests := []struct {
		name  string
		event socket.Event
		allow []string
		want  string
	}{
		{name: "channel level", event: mention(func(ev *socket.Event) { ev.ThreadTS = "" }), want: config.DefaultThreadHint},
		{name: "denied channel", event: mention(nil), allow: []string{"C999"}, want: config.DefaultDeniedHint},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := chatConfig()
			cfg.ChatChannels = tc.allow
			sc := newFakeSlack()
			b := newChatBridge(t, cfg, sc, &fakeAgent{})

			b.HandleEvent(context.Background(), tc.event)
			b.Wait(time.Second)

			hints := sc.allEphemerals()
			if len(hints) != 1 {
				t.Fatalf("sent %d hints, want exactly one: %+v", len(hints), hints)
			}
			if hints[0].text != tc.want || hints[0].user != testUser {
				t.Fatalf("hint %+v does not match the configured text for %s", hints[0], tc.name)
			}
			if len(sc.all()) != 0 {
				t.Fatalf("a hint left something in channel history: %+v", sc.all())
			}
		})
	}
}

// An empty hint restores the silent drop for that case alone.
func TestMentionHintsCanBeDisabled(t *testing.T) {
	cfg := chatConfig()
	cfg.ChatThreadHint = ""
	sc := newFakeSlack()
	b := newChatBridge(t, cfg, sc, &fakeAgent{})

	b.HandleEvent(context.Background(), mention(func(ev *socket.Event) { ev.ThreadTS = "" }))
	b.Wait(time.Second)

	if hints := sc.allEphemerals(); len(hints) != 0 {
		t.Fatalf("an empty hint still sent %+v", hints)
	}
}

// Every other drop stays silent: nobody is waiting on an answer.
func TestMentionDropsStaySilentWithoutAHint(t *testing.T) {
	sc := newFakeSlack()
	b := newChatBridge(t, chatConfig(), sc, &fakeAgent{})

	b.HandleEvent(context.Background(), mention(func(ev *socket.Event) { ev.User = botUser }))
	b.Wait(time.Second)

	if hints := sc.allEphemerals(); len(hints) != 0 {
		t.Fatalf("a self mention answered with %+v", hints)
	}
}

func TestMentionRoutesChannelToItsOwnAgent(t *testing.T) {
	cfg := chatConfig()
	cfg.ChatAgentMap = map[string]string{"security-alerts": "security-agent"}
	sc := newFakeSlack()
	sc.resolved = map[string]string{"security-alerts": testChannel}
	agent := &fakeAgent{reply: "answered"}
	b := newChatBridge(t, cfg, sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)

	if got := agent.lastAgent(); got != "security-agent" {
		t.Fatalf("routed to %q, want the channel's own agent", got)
	}
}

func TestMentionAllowsChannelByName(t *testing.T) {
	cfg := chatConfig()
	cfg.ChatChannels = []string{"alerts-test"}
	sc := newFakeSlack()
	sc.resolved = map[string]string{"alerts-test": testChannel}
	agent := &fakeAgent{reply: "answered"}
	b := newChatBridge(t, cfg, sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)

	if got := agent.promptCount(); got != 1 {
		t.Fatalf("a channel allowed by name started %d agent runs, want 1", got)
	}
}

func TestMentionReportsAgentFailureInThread(t *testing.T) {
	sc := newFakeSlack()
	agent := &fakeAgent{err: errors.New("controller unreachable")}
	b := newChatBridge(t, chatConfig(), sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)

	got := sc.lastUpdate()
	if !strings.Contains(got, "controller unreachable") {
		t.Fatalf("failure reported as %q, want the agent error in the thread", got)
	}
	if v := counterValue(t, b, "chat_turns_total", "error"); v != 1 {
		t.Fatalf("chat_turns_total{result=error} is %v, want 1", v)
	}
}

// A turn that never gets a slot reports it in the thread rather than leaving
// the asker on a status line that stops moving.
func TestMentionReportsQueueTimeout(t *testing.T) {
	cfg := chatConfig()
	cfg.ChatTimeout = 150 * time.Millisecond
	sc := newFakeSlack()
	release := make(chan struct{})
	agent := &fakeAgent{reply: "answered", release: release, holdPastDeadline: true}
	b := newChatBridge(t, cfg, sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.HandleEvent(context.Background(), mention(func(ev *socket.Event) { ev.EnvelopeID = "env-2" }))

	deadline := time.After(3 * time.Second)
	for !strings.Contains(strings.Join(updateTexts(sc.allUpdates()), "|"), "대화 슬롯") {
		select {
		case <-sc.updated:
		case <-deadline:
			t.Fatalf("queue timeout never reported: %v", updateTexts(sc.allUpdates()))
		}
	}
	close(release)
	b.Wait(3 * time.Second)

	if v := counterValue(t, b, "chat_turns_total", "queue_timeout"); v != 1 {
		t.Fatalf("chat_turns_total{result=queue_timeout} is %v, want 1", v)
	}
}

// The status message is the only place an answer can land, so a failed status
// post must not swallow the reply the turn already paid for.
func TestMentionPostsTheAnswerWhenTheStatusMessageCannotBeUpdated(t *testing.T) {
	sc := newFakeSlack()
	sc.updateErr = errors.New("message_not_found")
	agent := &fakeAgent{reply: "the pod is OOMKilled"}
	b := newChatBridge(t, chatConfig(), sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)

	messages := sc.all()
	if len(messages) != 2 {
		t.Fatalf("posted %d messages, want the status plus the answer: %+v", len(messages), messages)
	}
	last := messages[len(messages)-1]
	if last.Text != "the pod is OOMKilled" || last.ThreadTS != testThread {
		t.Fatalf("answer not posted in the thread: %+v", last)
	}
}

func TestMentionTruncatesLongReplies(t *testing.T) {
	cfg := chatConfig()
	cfg.SlackMaxTextRune = 40
	sc := newFakeSlack()
	agent := &fakeAgent{reply: strings.Repeat("가", 200)}
	b := newChatBridge(t, cfg, sc, agent)

	b.HandleEvent(context.Background(), mention(nil))
	b.Wait(3 * time.Second)

	got := sc.lastUpdate()
	if len([]rune(got)) > cfg.SlackMaxTextRune {
		t.Fatalf("answer is %d runes, want at most %d", len([]rune(got)), cfg.SlackMaxTextRune)
	}
	if !strings.Contains(got, "truncated") {
		t.Fatalf("truncated answer %q does not say it was cut", got)
	}
	if v := counterValue(t, b, "slack_messages_truncated_total", "chat"); v != 1 {
		t.Fatalf("slack_messages_truncated_total{kind=chat} is %v, want 1", v)
	}
}

func TestWorkingStatusReadsAsASentence(t *testing.T) {
	got := workingStatus("alert-triage-agent", 90*time.Second, "working")
	for _, want := range []string{"alert-triage-agent", "확인 중입니다", "1분 30초"} {
		if !strings.Contains(got, want) {
			t.Fatalf("status %q is missing %q", got, want)
		}
	}

	// A task that has been accepted but not started yet says so, rather than
	// claiming work that is not happening.
	if got := workingStatus("agent", time.Second, "submitted"); !strings.Contains(got, "시작했습니다") {
		t.Fatalf("submitted status is %q", got)
	}
	// An unrecognised state is worth showing verbatim: there it is a debugging
	// aid rather than noise.
	if got := workingStatus("agent", time.Second, "auth-required"); !strings.Contains(got, "auth-required") {
		t.Fatalf("unknown state dropped from %q", got)
	}
}

// counterValue reads a chat counter by its result label, which is the label
// every one of them carries.
func counterValue(t *testing.T, b *Bridge, name, result string) float64 {
	t.Helper()
	label := "result"
	if strings.HasSuffix(name, "truncated_total") {
		label = "kind"
	}
	return metricValue(t, b, "kagent_alert_bridge_"+name, map[string]string{label: result})
}

func updateTexts(updates []slackUpdate) []string {
	texts := make([]string, 0, len(updates))
	for _, u := range updates {
		texts = append(texts, u.text)
	}
	return texts
}
