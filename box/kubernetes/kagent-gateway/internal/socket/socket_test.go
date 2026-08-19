package socket

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// server is a stand-in for Slack: it answers apps.connections.open with the URL
// of its own WebSocket endpoint and plays a scripted list of frames to every
// connection that arrives.
type server struct {
	*httptest.Server

	mu sync.Mutex
	// frames is what the next connection receives, one JSON frame per entry.
	frames []string
	// acks collects every envelope id the client acknowledged.
	acks []string
	// connections counts how many times the client dialled.
	connections int
	// openErr makes apps.connections.open fail, which must never be fatal.
	openErr bool
	// acked fires once per acknowledgement so a test never sleeps.
	acked chan struct{}
	// closed fires when a connection's read loop ends.
	closed chan struct{}
}

func newServer(t *testing.T, frames ...string) *server {
	t.Helper()
	s := &server{
		frames: frames,
		acked:  make(chan struct{}, 16),
		closed: make(chan struct{}, 16),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /apps.connections.open", func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer xapp-test" {
			t.Errorf("app token not sent, got Authorization %q", got)
		}
		s.mu.Lock()
		failing := s.openErr
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if failing {
			_, _ = io.WriteString(w, `{"ok":false,"error":"invalid_auth"}`)
			return
		}
		url := "ws" + strings.TrimPrefix(s.Server.URL, "http") + "/link"
		_, _ = fmt.Fprintf(w, `{"ok":true,"url":%q}`, url)
	})
	mux.HandleFunc("/link", s.serveSocket)

	s.Server = httptest.NewServer(mux)
	t.Cleanup(s.Server.Close)
	return s
}

func (s *server) serveSocket(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.CloseNow()

	s.mu.Lock()
	s.connections++
	frames := append([]string(nil), s.frames...)
	s.mu.Unlock()

	ctx := r.Context()
	for _, frame := range frames {
		if err := ws.Write(ctx, websocket.MessageText, []byte(frame)); err != nil {
			return
		}
	}
	for {
		_, data, err := ws.Read(ctx)
		if err != nil {
			select {
			case s.closed <- struct{}{}:
			default:
			}
			return
		}
		var ack struct {
			EnvelopeID string `json:"envelope_id"`
		}
		if err := json.Unmarshal(data, &ack); err != nil || ack.EnvelopeID == "" {
			continue
		}
		s.mu.Lock()
		s.acks = append(s.acks, ack.EnvelopeID)
		s.mu.Unlock()
		select {
		case s.acked <- struct{}{}:
		default:
		}
	}
}

func (s *server) allAcks() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.acks...)
}

func (s *server) dials() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connections
}

func (s *server) failOpen(fail bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.openErr = fail
}

// collector records the events the loop hands over.
type collector struct {
	mu     sync.Mutex
	events []Event
	got    chan struct{}
}

func newCollector() *collector {
	return &collector{got: make(chan struct{}, 16)}
}

func (c *collector) HandleEvent(_ context.Context, ev Event) {
	c.mu.Lock()
	c.events = append(c.events, ev)
	c.mu.Unlock()
	select {
	case c.got <- struct{}{}:
	default:
	}
}

func (c *collector) all() []Event {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Event(nil), c.events...)
}

func (c *collector) wait(t *testing.T, n int) []Event {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for len(c.all()) < n {
		select {
		case <-c.got:
		case <-deadline:
			t.Fatalf("timed out waiting for %d events, got %d", n, len(c.all()))
		}
	}
	return c.all()
}

func newTestClient(s *server) *Client {
	c := New(s.Server.URL, "xapp-test", nil, testLogger())
	c.backoff = time.Millisecond
	return c
}

const mentionEnvelope = `{
  "type": "events_api",
  "envelope_id": "env-1",
  "payload": {"event": {
    "type": "app_mention",
    "channel": "C123",
    "channel_type": "channel",
    "user": "U777",
    "text": "<@U000BOT> why is the pod restarting?",
    "ts": "1700000001.000100",
    "thread_ts": "1700000000.000100"
  }}
}`

func waitFor(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func TestRunAcknowledgesAndDispatchesMention(t *testing.T) {
	s := newServer(t, `{"type":"hello"}`, mentionEnvelope)
	c, h := newTestClient(s), newCollector()

	ctx := t.Context()
	go func() { _ = c.Run(ctx, h) }()

	events := h.wait(t, 1)
	waitFor(t, s.acked, "the envelope acknowledgement")

	ev := events[0]
	if ev.Type != "app_mention" || ev.ChannelID != "C123" || ev.User != "U777" {
		t.Fatalf("event not flattened: %+v", ev)
	}
	if ev.ThreadTS != "1700000000.000100" || ev.TS != "1700000001.000100" {
		t.Fatalf("timestamps not carried: thread_ts %q ts %q", ev.ThreadTS, ev.TS)
	}
	if ev.EnvelopeID != "env-1" {
		t.Fatalf("envelope id not carried, got %q", ev.EnvelopeID)
	}
	if len(ev.Raw) == 0 {
		t.Fatal("raw payload not kept, so a rollout cannot log the real event shape")
	}
	if acks := s.allAcks(); len(acks) != 1 || acks[0] != "env-1" {
		t.Fatalf("envelope not acknowledged, got %v", acks)
	}
}

// The acknowledgement must not wait on the handler: Slack redelivers an
// envelope that is not acknowledged within 3 seconds, and one turn outlives
// that by two orders of magnitude.
func TestRunAcknowledgesBeforeHandlerReturns(t *testing.T) {
	s := newServer(t, mentionEnvelope)
	c := newTestClient(s)

	entered := make(chan struct{})
	release := make(chan struct{})
	defer close(release)

	ctx := t.Context()
	go func() { _ = c.Run(ctx, handlerFunc(func(context.Context, Event) { close(entered); <-release })) }()

	waitFor(t, entered, "the handler to start")
	waitFor(t, s.acked, "the acknowledgement while the handler is still running")
}

type handlerFunc func(context.Context, Event)

func (f handlerFunc) HandleEvent(ctx context.Context, ev Event) { f(ctx, ev) }

func TestRunReconnectsAfterDisconnect(t *testing.T) {
	s := newServer(t, `{"type":"hello"}`, `{"type":"disconnect","reason":"refresh_requested"}`)
	c, h := newTestClient(s), newCollector()

	ctx := t.Context()
	go func() { _ = c.Run(ctx, h) }()

	deadline := time.After(5 * time.Second)
	for s.dials() < 2 {
		select {
		case <-deadline:
			t.Fatalf("client did not reconnect after a disconnect, dials %d", s.dials())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestRunRetriesWhenConnectionCannotBeOpened(t *testing.T) {
	s := newServer(t, `{"type":"hello"}`, mentionEnvelope)
	s.failOpen(true)
	c, h := newTestClient(s), newCollector()

	ctx := t.Context()
	done := make(chan struct{})
	go func() { _ = c.Run(ctx, h); close(done) }()

	// A failed open must not end Run: the alert path keeps working while the
	// mention path retries in the background.
	time.Sleep(50 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("Run returned on a failed connection open instead of retrying")
	default:
	}

	s.failOpen(false)
	h.wait(t, 1)
}

func TestRunStopsOnContextCancel(t *testing.T) {
	s := newServer(t, `{"type":"hello"}`)
	c := newTestClient(s)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- c.Run(ctx, newCollector()) }()

	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v on a cancelled context, want nil", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return after the context was cancelled")
	}
}

// A frame that is not valid JSON, or an envelope whose payload carries no
// event, must not take the connection down with it.
func TestLoopSkipsUnusableFrames(t *testing.T) {
	s := newServer(t,
		`not json`,
		`{"type":"events_api","envelope_id":"env-empty","payload":{}}`,
		`{"type":"events_api","envelope_id":"env-broken","payload":{"event":"not-an-object"}}`,
		mentionEnvelope,
	)
	c, h := newTestClient(s), newCollector()

	ctx := t.Context()
	go func() { _ = c.Run(ctx, h) }()

	events := h.wait(t, 1)
	if events[0].EnvelopeID != "env-1" {
		t.Fatalf("unusable frames were not skipped, first event %+v", events[0])
	}
	// Every envelope carrying an id is still acknowledged, including the ones
	// that turn out to hold nothing dispatchable.
	deadline := time.After(3 * time.Second)
	for len(s.allAcks()) < 3 {
		select {
		case <-s.acked:
		case <-deadline:
			t.Fatalf("unusable envelopes were not acknowledged, got %v", s.allAcks())
		}
	}
}

func TestWaitBackoffGrowsAndStaysCapped(t *testing.T) {
	c := New("http://example.invalid", "xapp-test", nil, testLogger())
	c.backoff = time.Second

	if got := c.wait(0); got != time.Second {
		t.Fatalf("first wait is %s, want the base backoff", got)
	}
	// Jitter keeps a wait inside [d/2, d], which is what stops every replica
	// reconnecting on the same instant.
	for attempt := 1; attempt <= 20; attempt++ {
		got := c.wait(attempt)
		if got < 0 || got > maxBackoff {
			t.Fatalf("attempt %d waits %s, outside [0, %s]", attempt, got, maxBackoff)
		}
	}
	if got := c.wait(20); got < maxBackoff/2 {
		t.Fatalf("a late attempt waits %s, want at least half the cap", got)
	}
}

func TestOpenReportsSlackErrors(t *testing.T) {
	tests := []struct {
		name string
		body string
		code int
		want string
	}{
		{name: "payload error", body: `{"ok":false,"error":"invalid_auth"}`, code: 200, want: "invalid_auth"},
		{name: "no url", body: `{"ok":true}`, code: 200, want: "no socket url"},
		{name: "http error", body: `nope`, code: 500, want: "HTTP 500"},
		{name: "undecodable", body: `{`, code: 200, want: "decode response"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.code)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer srv.Close()

			c := New(srv.URL, "xapp-test", nil, testLogger())
			_, err := c.open(context.Background())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("open returned %v, want an error containing %q", err, tc.want)
			}
		})
	}
}
