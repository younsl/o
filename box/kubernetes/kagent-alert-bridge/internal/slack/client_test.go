package slack

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
	"sync/atomic"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/observability"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	c := New(srv.URL+"/", "xoxb-test", 5*time.Second, observability.NewMetrics(), testLogger())
	c.backoff = time.Millisecond // keep retry tests fast
	return c
}

func TestPostParentMessage(t *testing.T) {
	var got postRequest
	var authorization, path string

	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		authorization = r.Header.Get("Authorization")
		path = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		io.WriteString(w, `{"ok":true,"ts":"1700000000.000100","channel":"C123"}`)
	})

	ts, err := client.Post(context.Background(), Message{
		Channel: "#alerts",
		Title:   "🚨 [FIRING] KubePodCrashLooping",
		Color:   "danger",
		Text:    "*Severity:* critical",
	})
	if err != nil {
		t.Fatalf("Post() error = %v", err)
	}
	if ts != "1700000000.000100" {
		t.Errorf("ts = %q", ts)
	}
	if authorization != "Bearer xoxb-test" {
		t.Errorf("Authorization = %q", authorization)
	}
	if path != "/chat.postMessage" {
		t.Errorf("path = %q", path)
	}
	if got.Channel != "#alerts" || got.ThreadTS != "" {
		t.Errorf("request = %+v", got)
	}
	// The top-level text drives the notification preview, so it must repeat
	// the title rather than stay empty when an attachment is used.
	if got.Text != "🚨 [FIRING] KubePodCrashLooping" {
		t.Errorf("text = %q", got.Text)
	}
	if len(got.Attachments) != 1 {
		t.Fatalf("attachments = %+v", got.Attachments)
	}
	if got.Attachments[0].Color != "danger" || got.Attachments[0].Text != "*Severity:* critical" {
		t.Errorf("attachment = %+v", got.Attachments[0])
	}
	if len(got.Attachments[0].MrkdwnIn) != 1 || got.Attachments[0].MrkdwnIn[0] != "text" {
		t.Errorf("mrkdwn_in = %v", got.Attachments[0].MrkdwnIn)
	}
}

func TestPostThreadReplyHasNoAttachment(t *testing.T) {
	var got postRequest
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		json.NewDecoder(r.Body).Decode(&got)
		io.WriteString(w, `{"ok":true,"ts":"1700000000.000200"}`)
	})

	if _, err := client.Post(context.Background(), Message{
		Channel:  "#alerts",
		ThreadTS: "1700000000.000100",
		Text:     "*Summary* looks like an OOM kill",
	}); err != nil {
		t.Fatalf("Post() error = %v", err)
	}
	if got.ThreadTS != "1700000000.000100" {
		t.Errorf("thread_ts = %q", got.ThreadTS)
	}
	if len(got.Attachments) != 0 {
		t.Errorf("attachments = %+v, want none", got.Attachments)
	}
	if got.Text != "*Summary* looks like an OOM kill" {
		t.Errorf("text = %q", got.Text)
	}
}

func TestPostRetriesRateLimit(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		io.WriteString(w, `{"ok":true,"ts":"1.1"}`)
	})

	ts, err := client.Post(context.Background(), Message{Channel: "#c", Text: "hi"})
	if err != nil {
		t.Fatalf("Post() error = %v", err)
	}
	if ts != "1.1" {
		t.Errorf("ts = %q", ts)
	}
	if calls.Load() != 2 {
		t.Errorf("calls = %d, want 2", calls.Load())
	}
}

func TestPostRetriesServerError(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) < 3 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		io.WriteString(w, `{"ok":true,"ts":"1.1"}`)
	})

	if _, err := client.Post(context.Background(), Message{Channel: "#c", Text: "hi"}); err != nil {
		t.Fatalf("Post() error = %v", err)
	}
	if calls.Load() != 3 {
		t.Errorf("calls = %d, want 3", calls.Load())
	}
}

// A bad token or a channel the bot is not in will never succeed, so retrying
// only delays the failure and burns the Slack rate budget.
func TestPostDoesNotRetryPermanentError(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"ok":false,"error":"channel_not_found"}`)
	})

	_, err := client.Post(context.Background(), Message{Channel: "#nope", Text: "hi"})
	if err == nil || !strings.Contains(err.Error(), "channel_not_found") {
		t.Fatalf("error = %v", err)
	}
	if calls.Load() != 1 {
		t.Errorf("calls = %d, want 1", calls.Load())
	}
}

func TestPostGivesUpAfterMaxAttempts(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"ok":false,"error":"ratelimited"}`)
	})

	if _, err := client.Post(context.Background(), Message{Channel: "#c", Text: "hi"}); err == nil {
		t.Fatal("expected an error")
	}
	if calls.Load() != maxAttempts {
		t.Errorf("calls = %d, want %d", calls.Load(), maxAttempts)
	}
}

func TestPostRespectsContextDuringBackoff(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := client.Post(ctx, Message{Channel: "#c", Text: "hi"}); err == nil {
		t.Fatal("expected an error when the context expires mid-backoff")
	}
}

func TestRetryAfter(t *testing.T) {
	tests := []struct {
		header string
		want   time.Duration
	}{
		{"", 0},
		{"not a number", 0},
		{"0", 0},
		{"3", 3 * time.Second},
		{" 5 ", 5 * time.Second},
		{"600", maxRetryWait},
	}
	for _, tt := range tests {
		if got := retryAfter(tt.header); got != tt.want {
			t.Errorf("retryAfter(%q) = %s, want %s", tt.header, got, tt.want)
		}
	}
}

const historyBody = `{"ok":true,"messages":[
  {"ts":"1700000003.000000","text":"unrelated chatter"},
  {"ts":"1700000002.000000","text":"🚨 [FIRING] KubePodCrashLooping",
   "attachments":[{"title":"🚨 [FIRING] KubePodCrashLooping","text":"*Severity:* critical","footer":"alert-id fp-1"}]},
  {"ts":"1700000001.000000","text":"older alert","attachments":[{"footer":"alert-id fp-0"}]}
]}`

// The marker lands in the attachment footer because that is the least
// intrusive field an Alertmanager slack_configs template can carry it in.
func TestFindThreadParentMatchesFooter(t *testing.T) {
	var gotPath, gotQuery, gotAuth string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery, gotAuth = r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization")
		io.WriteString(w, historyBody)
	})

	since := time.Unix(1699999000, 0)
	ts, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", since)
	if err != nil {
		t.Fatalf("FindThreadParent() error = %v", err)
	}
	if ts != "1700000002.000000" {
		t.Errorf("ts = %q", ts)
	}
	if gotPath != "/conversations.history" {
		t.Errorf("path = %q", gotPath)
	}
	if gotAuth != "Bearer xoxb-test" {
		t.Errorf("Authorization = %q", gotAuth)
	}
	for _, want := range []string{"channel=C01ABCDEF12", "oldest=1699999000", "limit=50"} {
		if !strings.Contains(gotQuery, want) {
			t.Errorf("query %q missing %q", gotQuery, want)
		}
	}
}

func TestFindThreadParentMatchesOtherFields(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{"message text", `{"ok":true,"messages":[{"ts":"1.1","text":"alert fp-1 fired"}]}`},
		{"attachment text", `{"ok":true,"messages":[{"ts":"1.1","attachments":[{"text":"id fp-1"}]}]}`},
		{"attachment title", `{"ok":true,"messages":[{"ts":"1.1","attachments":[{"title":"fp-1"}]}]}`},
		{"attachment fallback", `{"ok":true,"messages":[{"ts":"1.1","attachments":[{"fallback":"fp-1"}]}]}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				io.WriteString(w, tt.body)
			})
			ts, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{})
			if err != nil {
				t.Fatalf("FindThreadParent() error = %v", err)
			}
			if ts != "1.1" {
				t.Errorf("ts = %q", ts)
			}
		})
	}
}

// An alert storm can bury the notification past the first page, so the scan
// must follow the cursor instead of giving up at one page.
func TestFindThreadParentFollowsPagination(t *testing.T) {
	var gotCursors []string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		cursor := r.URL.Query().Get("cursor")
		gotCursors = append(gotCursors, cursor)
		if cursor == "" {
			io.WriteString(w, `{"ok":true,"messages":[{"ts":"2.2","text":"storm noise"}],
				"has_more":true,"response_metadata":{"next_cursor":"page2"}}`)
			return
		}
		io.WriteString(w, `{"ok":true,"messages":[{"ts":"1.1","text":"alert-id fp-1"}]}`)
	})

	ts, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{})
	if err != nil {
		t.Fatalf("FindThreadParent() error = %v", err)
	}
	if ts != "1.1" {
		t.Errorf("ts = %q", ts)
	}
	if !reflect.DeepEqual(gotCursors, []string{"", "page2"}) {
		t.Errorf("cursors = %v", gotCursors)
	}
}

// A channel that keeps paging forever must not spin the search past the cap.
func TestFindThreadParentStopsAtPageCap(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"ok":true,"messages":[{"ts":"2.2","text":"noise"}],
			"has_more":true,"response_metadata":{"next_cursor":"again"}}`)
	})

	_, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{})
	if !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("error = %v, want ErrMessageNotFound", err)
	}
	if calls.Load() != maxHistoryPages {
		t.Errorf("calls = %d, want %d", calls.Load(), maxHistoryPages)
	}
}

func TestFindThreadParentNotFound(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"ok":true,"messages":[{"ts":"1.1","text":"nothing to see"}]}`)
	})

	_, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{})
	if !errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("error = %v, want ErrMessageNotFound", err)
	}
}

// A missing scope must be distinguishable from a missing message, because only
// the latter is worth retrying.
func TestFindThreadParentReportsAPIError(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"ok":false,"error":"missing_scope"}`)
	})

	_, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{})
	if err == nil || errors.Is(err, ErrMessageNotFound) {
		t.Fatalf("error = %v, want a permanent failure", err)
	}
	if !strings.Contains(err.Error(), "missing_scope") {
		t.Errorf("error = %v", err)
	}
}

func TestFindThreadParentRejectsEmptyMarker(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		t.Error("no API call should be made without a marker")
	})

	if _, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "", time.Time{}); err == nil {
		t.Fatal("expected an error")
	}
}

// conversations.history only accepts an ID, so a channel name has to be
// resolved first, and the result is cached to keep that off the hot path.
func TestFindThreadParentResolvesAndCachesChannelName(t *testing.T) {
	var listCalls, historyCalls int
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/conversations.list":
			listCalls++
			if r.URL.Query().Get("cursor") == "" {
				io.WriteString(w, `{"ok":true,"channels":[{"id":"C000","name":"other"}],
					"response_metadata":{"next_cursor":"page2"}}`)
				return
			}
			io.WriteString(w, `{"ok":true,"channels":[{"id":"C123","name":"alerts-test"}],
				"response_metadata":{"next_cursor":""}}`)
		case "/conversations.history":
			historyCalls++
			if got := r.URL.Query().Get("channel"); got != "C123" {
				t.Errorf("history channel = %q, want the resolved ID", got)
			}
			io.WriteString(w, `{"ok":true,"messages":[{"ts":"1.1","text":"fp-1"}]}`)
		}
	})

	for range 2 {
		if _, err := client.FindThreadParent(context.Background(), "#alerts-test", "fp-1", time.Time{}); err != nil {
			t.Fatalf("FindThreadParent() error = %v", err)
		}
	}
	if listCalls != 2 {
		t.Errorf("conversations.list called %d times, want 2 pages resolved once", listCalls)
	}
	if historyCalls != 2 {
		t.Errorf("conversations.history called %d times, want 2", historyCalls)
	}
}

func TestFindThreadParentCacheExpires(t *testing.T) {
	var listCalls int
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/conversations.list" {
			listCalls++
			io.WriteString(w, `{"ok":true,"channels":[{"id":"C123","name":"alerts-test"}]}`)
			return
		}
		io.WriteString(w, `{"ok":true,"messages":[{"ts":"1.1","text":"fp-1"}]}`)
	})

	now := time.Now()
	client.now = func() time.Time { return now }
	if _, err := client.FindThreadParent(context.Background(), "alerts-test", "fp-1", time.Time{}); err != nil {
		t.Fatalf("FindThreadParent() error = %v", err)
	}
	now = now.Add(channelCacheTTL + time.Minute)
	if _, err := client.FindThreadParent(context.Background(), "alerts-test", "fp-1", time.Time{}); err != nil {
		t.Fatalf("FindThreadParent() error = %v", err)
	}
	if listCalls != 2 {
		t.Errorf("conversations.list called %d times, want the expired entry re-resolved", listCalls)
	}
}

// A private channel is invisible to the public sweep, so resolution must fall
// back to a private_channel listing instead of giving up.
func TestFindThreadParentResolvesPrivateChannel(t *testing.T) {
	var gotTypes []string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/conversations.list" {
			types := r.URL.Query().Get("types")
			gotTypes = append(gotTypes, types)
			if types == "private_channel" {
				io.WriteString(w, `{"ok":true,"channels":[{"id":"G123","name":"secret-ops"}]}`)
				return
			}
			io.WriteString(w, `{"ok":true,"channels":[{"id":"C000","name":"other"}]}`)
			return
		}
		if got := r.URL.Query().Get("channel"); got != "G123" {
			t.Errorf("history channel = %q, want the private ID", got)
		}
		io.WriteString(w, `{"ok":true,"messages":[{"ts":"1.1","text":"fp-1"}]}`)
	})

	if _, err := client.FindThreadParent(context.Background(), "#secret-ops", "fp-1", time.Time{}); err != nil {
		t.Fatalf("FindThreadParent() error = %v", err)
	}
	want := []string{"public_channel", "private_channel"}
	if !reflect.DeepEqual(gotTypes, want) {
		t.Errorf("types = %v, want %v", gotTypes, want)
	}
}

// Without groups:read the private sweep fails with missing_scope; the error
// must say which scope unblocks it instead of parroting the API string.
func TestFindThreadParentPrivateSweepMissingScope(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("types") == "private_channel" {
			io.WriteString(w, `{"ok":false,"error":"missing_scope"}`)
			return
		}
		io.WriteString(w, `{"ok":true,"channels":[{"id":"C000","name":"other"}]}`)
	})

	_, err := client.FindThreadParent(context.Background(), "#secret-ops", "fp-1", time.Time{})
	if err == nil || !strings.Contains(err.Error(), "groups:read") {
		t.Fatalf("error = %v, want a groups:read hint", err)
	}
}

func TestFindThreadParentUnknownChannel(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/conversations.list" {
			io.WriteString(w, `{"ok":true,"channels":[{"id":"C000","name":"other"}]}`)
			return
		}
		t.Error("history must not be called for an unresolved channel")
	})

	_, err := client.FindThreadParent(context.Background(), "#missing", "fp-1", time.Time{})
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("error = %v", err)
	}
}

// A rate-limited read on the parent-lookup path must be retried, not turned
// into an orphan channel post, so get honours Retry-After the way Post does.
func TestGetRetriesRateLimit(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		io.WriteString(w, `{"ok":true,"messages":[{"ts":"1.1","text":"fp-1"}]}`)
	})

	ts, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{})
	if err != nil {
		t.Fatalf("FindThreadParent() error = %v", err)
	}
	if ts != "1.1" {
		t.Errorf("ts = %q", ts)
	}
	if calls.Load() != 2 {
		t.Errorf("calls = %d, want 2", calls.Load())
	}
}

func TestGetRetriesServerErrorAndTransientSlackError(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		switch calls.Add(1) {
		case 1:
			w.WriteHeader(http.StatusBadGateway)
		case 2:
			io.WriteString(w, `{"ok":false,"error":"ratelimited"}`)
		default:
			io.WriteString(w, `{"ok":true,"messages":[{"ts":"1.1","text":"fp-1"}]}`)
		}
	})

	if _, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{}); err != nil {
		t.Fatalf("FindThreadParent() error = %v", err)
	}
	if calls.Load() != 3 {
		t.Errorf("calls = %d, want 3", calls.Load())
	}
}

// missing_scope or invalid_auth never heals on its own; retrying only burns
// the rate budget while the analysis waits.
func TestGetDoesNotRetryPermanentError(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"ok":false,"error":"missing_scope"}`)
	})

	_, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{})
	if err == nil || !strings.Contains(err.Error(), "missing_scope") {
		t.Fatalf("error = %v", err)
	}
	if calls.Load() != 1 {
		t.Errorf("calls = %d, want 1", calls.Load())
	}
}

func TestGetGivesUpAfterMaxAttempts(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	})

	_, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{})
	if err == nil || !strings.Contains(err.Error(), "HTTP 503") {
		t.Fatalf("error = %v", err)
	}
	if calls.Load() != maxAttempts {
		t.Errorf("calls = %d, want %d", calls.Load(), maxAttempts)
	}
}

func TestGetRespectsContextDuringBackoff(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusTooManyRequests)
	})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := client.FindThreadParent(ctx, "C01ABCDEF12", "fp-1", time.Time{}); err == nil {
		t.Fatal("expected an error when the context expires mid-backoff")
	}
}

func TestGetHandlesTransportFailures(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		wantErr string
	}{
		{
			"http error",
			func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusForbidden) },
			"HTTP 403",
		},
		{
			"malformed json",
			func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "{nope") },
			"decode response",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, tt.handler)
			_, err := client.FindThreadParent(context.Background(), "C01ABCDEF12", "fp-1", time.Time{})
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

func TestNormalizeChannel(t *testing.T) {
	tests := []struct{ in, want string }{
		{"", ""},
		{"ops", "#ops"},
		{" ops ", "#ops"},
		{"#ops", "#ops"},
		{"C01ABCDEF12", "C01ABCDEF12"},
		{"G01ABCDEF12", "G01ABCDEF12"},
		{"Cshort", "#Cshort"},
	}
	for _, tt := range tests {
		if got := NormalizeChannel(tt.in); got != tt.want {
			t.Errorf("NormalizeChannel(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestTruncate(t *testing.T) {
	if got := Truncate("short", 100); got != "short" {
		t.Errorf("Truncate() = %q", got)
	}
	if got := Truncate("keep", 0); got != "keep" {
		t.Errorf("Truncate() with no limit = %q", got)
	}

	// Counting runes rather than bytes keeps multi-byte text from being cut
	// mid-character, which Slack renders as a replacement glyph.
	got := Truncate(strings.Repeat("가", 100), 20)
	if runes := []rune(got); len(runes) != 20 {
		t.Errorf("Truncate() produced %d runes, want 20", len(runes))
	}
	if !strings.HasSuffix(got, "_(truncated)_") {
		t.Errorf("Truncate() = %q, want a truncation marker", got)
	}
}

// Slack throttling is the failure mode that turns an analysis into an orphan
// channel post, so a retried attempt has to be visible as its own outcome
// rather than hidden behind the eventually successful call.
func TestPostRecordsEveryAttempt(t *testing.T) {
	metrics := observability.NewMetrics()
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		io.WriteString(w, `{"ok":true,"ts":"1.1"}`)
	}))
	t.Cleanup(srv.Close)

	client := New(srv.URL, "xoxb-test", 5*time.Second, metrics, testLogger())
	client.backoff = time.Millisecond
	if _, err := client.Post(context.Background(), Message{Channel: "#c", Text: "hi"}); err != nil {
		t.Fatalf("Post() error = %v", err)
	}

	for _, tc := range []struct {
		result string
		want   float64
	}{{"rate_limited", 1}, {"ok", 1}, {"error", 0}} {
		got := counterValue(t, metrics, "kagent_alert_bridge_slack_api_requests_total",
			map[string]string{"method": "chat.postMessage", "result": tc.result})
		if got != tc.want {
			t.Errorf("slack_api_requests_total{result=%q} = %v, want %v", tc.result, got, tc.want)
		}
	}
}

// The lookup path calls conversations.list and conversations.history, and each
// needs its own latency series: they fail for different reasons.
func TestFindThreadParentRecordsBothReadMethods(t *testing.T) {
	metrics := observability.NewMetrics()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "conversations.list"):
			io.WriteString(w, `{"ok":true,"channels":[{"id":"C123456","name":"alerts"}]}`)
		case strings.Contains(r.URL.Path, "conversations.history"):
			io.WriteString(w, `{"ok":true,"messages":[{"ts":"9.9","text":"fp-1"}]}`)
		default:
			t.Errorf("unexpected path %q", r.URL.Path)
		}
	}))
	t.Cleanup(srv.Close)

	client := New(srv.URL, "xoxb-test", 5*time.Second, metrics, testLogger())
	if _, err := client.FindThreadParent(context.Background(), "#alerts", "fp-1", time.Time{}); err != nil {
		t.Fatalf("FindThreadParent() error = %v", err)
	}

	for _, method := range []string{"conversations.list", "conversations.history"} {
		got := counterValue(t, metrics, "kagent_alert_bridge_slack_api_requests_total",
			map[string]string{"method": method, "result": "ok"})
		if got != 1 {
			t.Errorf("slack_api_requests_total{method=%q,result=\"ok\"} = %v, want 1", method, got)
		}
	}
}

// counterValue reads one counter series off the registry, which is what a scrape
// would show. A counter that was never touched has no series, and reads as zero.
func counterValue(t *testing.T, m *observability.Metrics, name string, labels map[string]string) float64 {
	t.Helper()
	families, err := m.Registry().Gather()
	if err != nil {
		t.Fatalf("Gather() error = %v", err)
	}
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, metric := range family.GetMetric() {
			got := map[string]string{}
			for _, pair := range metric.GetLabel() {
				got[pair.GetName()] = pair.GetValue()
			}
			match := true
			for k, v := range labels {
				if got[k] != v {
					match = false
				}
			}
			if match {
				return metric.GetCounter().GetValue()
			}
		}
	}
	return 0
}

func TestUpdateRewritesAMessageInPlace(t *testing.T) {
	var got map[string]string
	var path string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		io.WriteString(w, `{"ok":true,"ts":"1700000000.000100","channel":"C123"}`)
	})

	if err := client.Update(context.Background(), "C123", "1700000000.000100", "the pod is OOMKilled"); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if path != "/chat.update" {
		t.Errorf("path = %q, want /chat.update", path)
	}
	want := map[string]string{"channel": "C123", "ts": "1700000000.000100", "text": "the pod is OOMKilled"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("body = %v, want %v", got, want)
	}
}

func TestUpdateReportsSlackErrors(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"ok":false,"error":"message_not_found"}`)
	})
	err := client.Update(context.Background(), "C123", "1700000000.000100", "text")
	if err == nil || !strings.Contains(err.Error(), "message_not_found") {
		t.Fatalf("Update() error = %v, want message_not_found", err)
	}
}

func TestPostEphemeralTargetsOneReaderInTheThread(t *testing.T) {
	var got map[string]string
	var path string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		io.WriteString(w, `{"ok":true}`)
	})

	if err := client.PostEphemeral(context.Background(), "C123", "1700000000.000100", "U777", "threads only"); err != nil {
		t.Fatalf("PostEphemeral() error = %v", err)
	}
	if path != "/chat.postEphemeral" {
		t.Errorf("path = %q, want /chat.postEphemeral", path)
	}
	want := map[string]string{
		"channel": "C123", "user": "U777",
		"thread_ts": "1700000000.000100", "text": "threads only",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("body = %v, want %v", got, want)
	}
}

// A mention at channel level has no thread to answer in, so the hint must go
// out without a thread_ts rather than carrying an empty one.
func TestPostEphemeralOmitsAnEmptyThread(t *testing.T) {
	var got map[string]string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("decode request: %v", err)
		}
		io.WriteString(w, `{"ok":true}`)
	})

	if err := client.PostEphemeral(context.Background(), "C123", "", "U777", "threads only"); err != nil {
		t.Fatalf("PostEphemeral() error = %v", err)
	}
	if _, ok := got["thread_ts"]; ok {
		t.Errorf("body = %v, want no thread_ts", got)
	}
}

func TestAuthTestResolvesTheBotUserID(t *testing.T) {
	var path string
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		io.WriteString(w, `{"ok":true,"user_id":"U000BOT","bot_id":"B000"}`)
	})

	id, err := client.AuthTest(context.Background())
	if err != nil {
		t.Fatalf("AuthTest() error = %v", err)
	}
	if id != "U000BOT" {
		t.Errorf("user id = %q, want U000BOT", id)
	}
	if path != "/auth.test" {
		t.Errorf("path = %q, want /auth.test", path)
	}
}

func TestAuthTestRejectsAnEmptyIdentity(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"ok":true}`)
	})
	if _, err := client.AuthTest(context.Background()); err == nil {
		t.Fatal("AuthTest() accepted a response carrying no user id")
	}
}

func TestResolveChannelIDPassesAnIDThrough(t *testing.T) {
	var calls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"ok":true,"channels":[{"id":"C01234567","name":"alerts"}]}`)
	})

	id, err := client.ResolveChannelID(context.Background(), "C01234567")
	if err != nil {
		t.Fatalf("ResolveChannelID() error = %v", err)
	}
	if id != "C01234567" || calls.Load() != 0 {
		t.Fatalf("id = %q after %d calls, want the ID passed through without a lookup", id, calls.Load())
	}

	if id, err = client.ResolveChannelID(context.Background(), "alerts"); err != nil {
		t.Fatalf("ResolveChannelID() error = %v", err)
	}
	if id != "C01234567" {
		t.Fatalf("id = %q, want the resolved conversation ID", id)
	}
}
