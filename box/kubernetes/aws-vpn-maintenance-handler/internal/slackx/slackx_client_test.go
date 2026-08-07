package slackx

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/slack-go/slack"
)

// slackStub stands in for the Slack Web API, recording the form each call posted so a
// test can assert on what was actually sent rather than only on the return value.
type slackStub struct {
	mu    sync.Mutex
	calls map[string][]map[string]string
	// respond maps an API method to its JSON response body.
	respond map[string]string
	server  *httptest.Server
}

func newSlackStub(t *testing.T, respond map[string]string) *slackStub {
	t.Helper()
	s := &slackStub{calls: map[string][]map[string]string{}, respond: respond}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := strings.TrimPrefix(r.URL.Path, "/")
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form for %s: %v", method, err)
		}
		form := map[string]string{}
		for k := range r.Form {
			form[k] = r.Form.Get(k)
		}

		s.mu.Lock()
		s.calls[method] = append(s.calls[method], form)
		body, ok := s.respond[method]
		s.mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		if !ok {
			_, _ = w.Write([]byte(`{"ok":false,"error":"unexpected_method"}`))
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(s.server.Close)
	return s
}

func (s *slackStub) client() *Client {
	return New("xoxb-test", "xapp-test", discardLogger(), slack.OptionAPIURL(s.server.URL+"/"))
}

func (s *slackStub) countOf(method string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.calls[method])
}

func (s *slackStub) formsFor(method string) []map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]string{}, s.calls[method]...)
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func okDM(channelID string) string {
	return `{"ok":true,"channel":{"id":"` + channelID + `"}}`
}

// An approver list is reviewed as a list of opaque IDs, so the names have to reach
// the startup log.
func TestResolveApproversNamesEachUser(t *testing.T) {
	stub := newSlackStub(t, map[string]string{
		"users.info": `{"ok":true,"user":{"id":"U1","name":"handle","real_name":"Real Name","profile":{"display_name":"chosen"}}}`,
	})

	approvers := stub.client().ResolveApprovers(context.Background(), []string{"U1"})
	if len(approvers) != 1 {
		t.Fatalf("got %d approvers, want 1", len(approvers))
	}
	if approvers[0].Name != "chosen" {
		t.Fatalf("Name = %q, want the display name", approvers[0].Name)
	}
	if approvers[0].ID != "U1" {
		t.Fatalf("ID = %q", approvers[0].ID)
	}
}

// Without a display name the real name is the next best label, and the handle after
// that. An approver never renders as an empty string.
func TestResolveApproversFallsBackThroughTheNames(t *testing.T) {
	stub := newSlackStub(t, map[string]string{
		"users.info": `{"ok":true,"user":{"id":"U1","name":"handle","real_name":"Real Name","profile":{}}}`,
	})
	if got := stub.client().ResolveApprovers(context.Background(), []string{"U1"})[0].Name; got != "Real Name" {
		t.Fatalf("Name = %q, want the real name", got)
	}

	stub = newSlackStub(t, map[string]string{
		"users.info": `{"ok":true,"user":{"id":"U1","name":"handle","profile":{}}}`,
	})
	if got := stub.client().ResolveApprovers(context.Background(), []string{"U1"})[0].Name; got != "handle" {
		t.Fatalf("Name = %q, want the handle", got)
	}
}

// The name is a label, not an authorization input. A workspace that has not granted
// users:read must degrade to the ID rather than stop the controller.
func TestResolveApproversDegradesToTheIDWithoutTheScope(t *testing.T) {
	stub := newSlackStub(t, map[string]string{
		"users.info": `{"ok":false,"error":"missing_scope"}`,
	})

	approvers := stub.client().ResolveApprovers(context.Background(), []string{"U1", "U2"})
	if len(approvers) != 2 {
		t.Fatalf("got %d approvers, want 2", len(approvers))
	}
	for _, a := range approvers {
		if a.Name != a.ID {
			t.Fatalf("approver %q resolved to %q, want the bare ID", a.ID, a.Name)
		}
	}
}

func TestOpenDMsResolvesEveryApprover(t *testing.T) {
	stub := newSlackStub(t, map[string]string{"conversations.open": okDM("D111")})

	channels, err := stub.client().OpenDMs(context.Background(), []string{"U1", "U2"})
	if err != nil {
		t.Fatalf("OpenDMs returned error: %v", err)
	}
	if len(channels) != 2 {
		t.Fatalf("expected a channel per approver, got %v", channels)
	}
	// The user ID has to reach Slack, or every approver would resolve to the same DM.
	forms := stub.formsFor("conversations.open")
	if len(forms) != 2 || forms[0]["users"] != "U1" || forms[1]["users"] != "U2" {
		t.Fatalf("conversations.open forms = %v", forms)
	}
}

// One unreachable approver must not stop the others: a single reachable approver is
// enough to authorize maintenance.
func TestOpenDMsToleratesAPartialFailure(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			_, _ = w.Write([]byte(`{"ok":false,"error":"user_not_found"}`))
			return
		}
		_, _ = w.Write([]byte(okDM("D222")))
	}))
	defer server.Close()

	c := New("xoxb-test", "xapp-test", discardLogger(), slack.OptionAPIURL(server.URL+"/"))
	channels, err := c.OpenDMs(context.Background(), []string{"U-missing", "U-ok"})
	if err != nil {
		t.Fatalf("OpenDMs returned error: %v", err)
	}
	if len(channels) != 1 || channels[0] != "D222" {
		t.Fatalf("channels = %v, want just D222", channels)
	}
}

// No reachable approver at all is fatal: there would be no authorization path.
func TestOpenDMsFailsWhenNobodyIsReachable(t *testing.T) {
	stub := newSlackStub(t, map[string]string{"conversations.open": `{"ok":false,"error":"user_not_found"}`})

	_, err := stub.client().OpenDMs(context.Background(), []string{"U1", "U2"})
	if err == nil {
		t.Fatal("OpenDMs must fail when no approver could be reached")
	}
	if !strings.Contains(err.Error(), "2 configured approvers") {
		t.Fatalf("error = %v, want it to name how many were tried", err)
	}
}

func TestAuthTestReportsTheBotUser(t *testing.T) {
	stub := newSlackStub(t, map[string]string{
		"auth.test": `{"ok":true,"user":"vpn-bot","user_id":"U0BOT","team":"t"}`,
	})

	user, err := stub.client().AuthTest(context.Background())
	if err != nil {
		t.Fatalf("AuthTest returned error: %v", err)
	}
	if user != "vpn-bot" {
		t.Fatalf("AuthTest = %q, want vpn-bot", user)
	}
}

// A revoked token has to fail at startup rather than when maintenance is first queued.
func TestAuthTestSurfacesARejectedToken(t *testing.T) {
	stub := newSlackStub(t, map[string]string{"auth.test": `{"ok":false,"error":"invalid_auth"}`})

	if _, err := stub.client().AuthTest(context.Background()); err == nil {
		t.Fatal("a rejected token must be reported")
	}
}

func TestPostSendsBlocksAndReturnsTheReference(t *testing.T) {
	stub := newSlackStub(t, map[string]string{
		"chat.postMessage": `{"ok":true,"channel":"D111","ts":"1750000000.000100"}`,
	})
	_, blocks := ApprovalBlocks(proposal())

	ref, err := stub.client().Post(context.Background(), "D111", "fallback text", blocks)
	if err != nil {
		t.Fatalf("Post returned error: %v", err)
	}
	if ref.ChannelID != "D111" || ref.TS != "1750000000.000100" {
		t.Fatalf("ref = %+v", ref)
	}

	form := stub.formsFor("chat.postMessage")[0]
	if form["channel"] != "D111" {
		t.Fatalf("channel = %q", form["channel"])
	}
	// The fallback is the whole content of a phone push notification.
	if form["text"] != "fallback text" {
		t.Fatalf("text = %q, want the fallback", form["text"])
	}
	// Buttons only exist inside blocks, so a dropped blocks field would post an
	// unclickable card.
	if !strings.Contains(form["blocks"], ActionApprove) {
		t.Fatalf("blocks did not carry the approve action: %s", form["blocks"])
	}
}

func TestPostReportsAnAPIError(t *testing.T) {
	stub := newSlackStub(t, map[string]string{"chat.postMessage": `{"ok":false,"error":"channel_not_found"}`})

	if _, err := stub.client().Post(context.Background(), "D404", "x", nil); err == nil {
		t.Fatal("a failed post must be reported")
	}
}

func TestBroadcastReturnsOnlyTheDeliveredReferences(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 2 {
			_, _ = w.Write([]byte(`{"ok":false,"error":"channel_not_found"}`))
			return
		}
		_, _ = w.Write([]byte(`{"ok":true,"channel":"D111","ts":"1750000000.000100"}`))
	}))
	defer server.Close()

	c := New("xoxb-test", "xapp-test", discardLogger(), slack.OptionAPIURL(server.URL+"/"))
	refs := c.Broadcast(context.Background(), []string{"D111", "D222", "D333"}, "fallback", nil)

	if len(refs) != 2 {
		t.Fatalf("expected the two delivered references, got %v", refs)
	}
}

// Replies must carry thread_ts, or progress updates would land as separate messages
// instead of under the card that authorized the work.
func TestReplyThreadsUnderEachReference(t *testing.T) {
	stub := newSlackStub(t, map[string]string{
		"chat.postMessage": `{"ok":true,"channel":"D111","ts":"1750000000.000200"}`,
	})
	refs := []MessageRef{
		{ChannelID: "D111", TS: "1750000000.000100"},
		{ChannelID: "D222", TS: "1750000000.000101"},
	}

	stub.client().Reply(context.Background(), refs, Notice{Level: LevelSuccess, Target: Label("prod-dc", "vpn-a"), Text: "Tunnel is back UP."})

	forms := stub.formsFor("chat.postMessage")
	if len(forms) != 2 {
		t.Fatalf("expected a reply per reference, got %d", len(forms))
	}
	for i, form := range forms {
		if form["thread_ts"] != refs[i].TS {
			t.Fatalf("reply %d thread_ts = %q, want %q", i, form["thread_ts"], refs[i].TS)
		}
		if form["text"] != "[SUCCESS] VPN connection prod-dc (vpn-a). Tunnel is back UP." {
			t.Fatalf("reply %d text = %q", i, form["text"])
		}
	}
}

// A failed reply is logged, not fatal: losing a progress line must not abort a
// replacement that is already under way.
func TestReplySurvivesAFailure(t *testing.T) {
	stub := newSlackStub(t, map[string]string{"chat.postMessage": `{"ok":false,"error":"rate_limited"}`})

	stub.client().Reply(context.Background(), []MessageRef{{ChannelID: "D111", TS: "1"}}, Notice{Level: LevelInfo, Target: "vpn-a", Text: "progress"})

	if stub.countOf("chat.postMessage") != 1 {
		t.Fatal("Reply should still have attempted the post")
	}
}

func TestUpdateRewritesEachCard(t *testing.T) {
	stub := newSlackStub(t, map[string]string{
		"chat.update": `{"ok":true,"channel":"D111","ts":"1750000000.000100"}`,
	})
	_, blocks := ResolvedBlocks(proposal(), LevelSuccess, "*Replaced.*")

	stub.client().Update(context.Background(),
		[]MessageRef{{ChannelID: "D111", TS: "1750000000.000100"}}, "Replaced", blocks)

	forms := stub.formsFor("chat.update")
	if len(forms) != 1 {
		t.Fatalf("expected one update, got %d", len(forms))
	}
	if forms[0]["ts"] != "1750000000.000100" {
		t.Fatalf("ts = %q, want the original message timestamp", forms[0]["ts"])
	}
	// The resolved card must no longer be clickable.
	if strings.Contains(forms[0]["blocks"], ActionApprove) {
		t.Fatal("the update still carries the approve button")
	}
}

func TestUpdateSurvivesAFailure(t *testing.T) {
	stub := newSlackStub(t, map[string]string{"chat.update": `{"ok":false,"error":"message_not_found"}`})

	stub.client().Update(context.Background(), []MessageRef{{ChannelID: "D111", TS: "1"}}, "x", nil)

	if stub.countOf("chat.update") != 1 {
		t.Fatal("Update should still have attempted the call")
	}
}

// Blocks are serialized as JSON in the form, so a malformed builder would show up
// here rather than as a silent rendering failure in Slack.
func TestPostedBlocksAreValidJSON(t *testing.T) {
	stub := newSlackStub(t, map[string]string{
		"chat.postMessage": `{"ok":true,"channel":"D111","ts":"1"}`,
	})
	_, blocks := ApprovalBlocks(proposal())

	if _, err := stub.client().Post(context.Background(), "D111", "x", blocks); err != nil {
		t.Fatalf("Post returned error: %v", err)
	}

	var decoded []map[string]any
	raw := stub.formsFor("chat.postMessage")[0]["blocks"]
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		t.Fatalf("posted blocks are not valid JSON: %v", err)
	}
	if len(decoded) == 0 {
		t.Fatal("no blocks were posted")
	}
}
