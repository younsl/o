// Package socket receives Slack events over Socket Mode.
//
// Socket Mode is an outbound WebSocket, so the gateway needs no public endpoint,
// no request URL, and no signing secret: apps.connections.open returns a single
// use wss URL, and every event arrives on it as an envelope that has to be
// acknowledged within a few seconds.
//
// The package owns the connection and the envelope loop and knows nothing about
// agents. It hands each event to a Handler, which keeps the routing and the
// agent logic in one place and leaves this transport testable against a local
// WebSocket server.
package socket

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/younsl/o/box/kubernetes/kagent-gateway/internal/observability"
)

const (
	// ackTimeout bounds one acknowledgement write. Slack redelivers an envelope
	// that is not acknowledged within 3 seconds, so a write that blocks longer
	// than that has already lost the race and only holds up the read loop.
	ackTimeout = 2 * time.Second
	// maxBackoff caps the wait between reconnect attempts. Slack recycles a
	// connection roughly every hour, so a reconnect is routine rather than a
	// failure, and the ceiling keeps a real outage from stretching the retry
	// interval past the point of noticing a recovery.
	maxBackoff = 30 * time.Second
	// readLimit bounds one envelope. Slack event payloads are small; anything
	// larger is a protocol surprise rather than a mention.
	readLimit = 1 << 20
)

// Event is one Slack event carried by an envelope, flattened to the fields the
// mention path routes on. Raw keeps the original payload for debug logging,
// which is what pins the real shape of an event during a rollout.
type Event struct {
	EnvelopeID  string
	Type        string
	ChannelID   string
	ChannelType string
	User        string
	BotID       string
	Subtype     string
	Text        string
	// TS is the timestamp of the message carrying the mention, which a reaction
	// goes on. ThreadTS is the thread it lives in, empty at channel level.
	TS       string
	ThreadTS string
	Raw      json.RawMessage
}

// Handler receives an event after its envelope has been acknowledged.
// Implementations must not block the read loop for long: one turn's work
// belongs on a goroutine of its own.
type Handler interface {
	HandleEvent(ctx context.Context, ev Event)
}

// Client opens Socket Mode connections and reads envelopes off them.
type Client struct {
	http     *http.Client
	apiURL   string
	appToken string
	metrics  *observability.Metrics
	logger   *slog.Logger
	backoff  time.Duration
	// dial is the WebSocket dialer, replaced in tests by one that speaks to a
	// local server.
	dial func(ctx context.Context, url string) (conn, error)
}

// conn is the subset of a WebSocket connection the envelope loop uses.
type conn interface {
	Read(ctx context.Context) ([]byte, error)
	Write(ctx context.Context, data []byte) error
	Close() error
}

// New returns a Client for the Web API at apiURL authenticating with an
// app-level token (xapp-...). metrics may be nil, which leaves the connection
// unmeasured.
func New(apiURL, appToken string, metrics *observability.Metrics, logger *slog.Logger) *Client {
	c := &Client{
		// The connection open call is a normal Web API request; the WebSocket
		// itself is not bounded by this timeout.
		http:     &http.Client{Timeout: 30 * time.Second},
		apiURL:   strings.TrimSuffix(apiURL, "/"),
		appToken: appToken,
		metrics:  metrics,
		logger:   logger,
		backoff:  time.Second,
	}
	c.dial = c.dialWebSocket
	return c
}

// Run keeps a Socket Mode connection open until ctx is cancelled, reconnecting
// with backoff after every drop. It returns only when ctx ends: a connection
// that cannot be established is retried rather than reported, because the alert
// path must keep working when Slack is unreachable.
func (c *Client) Run(ctx context.Context, h Handler) error {
	attempt := 0
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		wait, err := c.session(ctx, h)
		switch {
		case ctx.Err() != nil:
			return nil
		case err != nil:
			attempt++
			c.logger.Warn("socket mode session ended", "error", err, "attempt", attempt)
		default:
			// A clean end is a reconnect Slack asked for, so the next attempt
			// starts from the shortest wait rather than inheriting a backoff.
			attempt = 0
		}
		if wait == 0 {
			wait = c.wait(attempt)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
	}
}

// session opens one connection and reads it to its end. The returned duration
// overrides the backoff when Slack asked for a prompt reconnect.
func (c *Client) session(ctx context.Context, h Handler) (time.Duration, error) {
	url, err := c.open(ctx)
	if err != nil {
		c.metrics.ObserveSocketConnection("error")
		return 0, fmt.Errorf("open connection: %w", err)
	}

	ws, err := c.dial(ctx, url)
	if err != nil {
		c.metrics.ObserveSocketConnection("error")
		return 0, fmt.Errorf("dial socket: %w", err)
	}
	defer ws.Close()

	c.metrics.ObserveSocketConnection("ok")
	c.metrics.SetSocketConnected(true)
	defer c.metrics.SetSocketConnected(false)
	c.logger.Info("socket mode connected")

	return c.loop(ctx, ws, h)
}

// envelope is one Socket Mode frame. Only the fields the loop acts on are
// decoded; the event payload is kept raw and flattened separately.
type envelope struct {
	Type       string `json:"type"`
	EnvelopeID string `json:"envelope_id"`
	Reason     string `json:"reason"`
	Payload    struct {
		Event json.RawMessage `json:"event"`
	} `json:"payload"`
}

func (c *Client) loop(ctx context.Context, ws conn, h Handler) (time.Duration, error) {
	for {
		raw, err := ws.Read(ctx)
		if err != nil {
			return 0, err
		}

		var env envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			c.logger.Warn("failed to decode socket envelope", "error", err)
			continue
		}

		switch env.Type {
		case "hello":
			c.logger.Debug("socket mode session confirmed")
			continue
		case "disconnect":
			// Slack recycles connections and warns before it does. Reconnecting
			// at once keeps the gap short instead of paying a backoff for a
			// drop that was scheduled.
			c.logger.Info("socket mode disconnect requested", "reason", env.Reason)
			c.metrics.ObserveSocketConnection("disconnect_requested")
			return time.Second, nil
		}

		// The acknowledgement never waits on the handler: Slack redelivers an
		// envelope that is not acknowledged within 3 seconds, and the work one
		// event triggers outlives that by two orders of magnitude.
		if env.EnvelopeID != "" {
			if err := c.ack(ctx, ws, env.EnvelopeID); err != nil {
				return 0, fmt.Errorf("acknowledge envelope: %w", err)
			}
		}
		if env.Type != "events_api" || len(env.Payload.Event) == 0 {
			continue
		}

		ev, ok := decodeEvent(env, c.logger)
		if !ok {
			continue
		}
		h.HandleEvent(ctx, ev)
	}
}

// decodeEvent flattens the event payload of an envelope.
func decodeEvent(env envelope, logger *slog.Logger) (Event, bool) {
	var body struct {
		Type        string `json:"type"`
		Channel     string `json:"channel"`
		ChannelType string `json:"channel_type"`
		User        string `json:"user"`
		BotID       string `json:"bot_id"`
		Subtype     string `json:"subtype"`
		Text        string `json:"text"`
		TS          string `json:"ts"`
		ThreadTS    string `json:"thread_ts"`
	}
	if err := json.Unmarshal(env.Payload.Event, &body); err != nil {
		logger.Warn("failed to decode socket event", "error", err)
		return Event{}, false
	}
	return Event{
		EnvelopeID:  env.EnvelopeID,
		Type:        body.Type,
		ChannelID:   body.Channel,
		ChannelType: body.ChannelType,
		User:        body.User,
		BotID:       body.BotID,
		Subtype:     body.Subtype,
		Text:        body.Text,
		TS:          body.TS,
		ThreadTS:    body.ThreadTS,
		Raw:         env.Payload.Event,
	}, true
}

func (c *Client) ack(ctx context.Context, ws conn, envelopeID string) error {
	raw, err := json.Marshal(map[string]string{"envelope_id": envelopeID})
	if err != nil {
		return err
	}
	ackCtx, cancel := context.WithTimeout(ctx, ackTimeout)
	defer cancel()
	return ws.Write(ackCtx, raw)
}

// open asks Slack for a single use WebSocket URL.
func (c *Client) open(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL+"/apps.connections.open", nil)
	if err != nil {
		return "", fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Bearer "+c.appToken)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("call slack: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, readLimit))
	if err != nil {
		return "", fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("slack returned HTTP %d", resp.StatusCode)
	}

	var out struct {
		OK    bool   `json:"ok"`
		URL   string `json:"url"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(payload, &out); err != nil {
		return "", fmt.Errorf("decode response: %w", err)
	}
	if !out.OK {
		return "", fmt.Errorf("slack error: %s", out.Error)
	}
	if out.URL == "" {
		return "", fmt.Errorf("slack returned no socket url")
	}
	return out.URL, nil
}

// wait returns the backoff before the next attempt: exponential up to the cap,
// with jitter so a controller restart does not line every replica up on the
// same reconnect instant.
func (c *Client) wait(attempt int) time.Duration {
	if attempt <= 0 {
		return c.backoff
	}
	d := c.backoff << min(attempt-1, 16)
	if d > maxBackoff || d <= 0 {
		d = maxBackoff
	}
	return d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
}

// wsConn adapts a coder/websocket connection to conn, hiding the message type
// the envelope loop never varies.
type wsConn struct{ ws *websocket.Conn }

func (c wsConn) Read(ctx context.Context) ([]byte, error) {
	_, data, err := c.ws.Read(ctx)
	return data, err
}

func (c wsConn) Write(ctx context.Context, data []byte) error {
	return c.ws.Write(ctx, websocket.MessageText, data)
}

func (c wsConn) Close() error {
	return c.ws.Close(websocket.StatusNormalClosure, "")
}

// dialWebSocket opens the wss URL. The dialer is built from the default
// transport so the standard proxy environment variables apply: SLACK_API_URL
// only redirects Web API calls, and a deployment routing egress through a proxy
// needs the socket to honour it too.
func (c *Client) dialWebSocket(ctx context.Context, url string) (conn, error) {
	ws, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPClient: &http.Client{Transport: http.DefaultTransport},
	})
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(readLimit)
	return wsConn{ws: ws}, nil
}
