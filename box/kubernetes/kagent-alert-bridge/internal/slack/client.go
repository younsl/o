// Package slack talks to the Web API with a bot token.
//
// Three calls are implemented: chat.postMessage to publish, and
// conversations.list plus conversations.history to locate a message somebody
// else posted. The lookup exists because an Alertmanager incoming webhook does
// not return the message timestamp that thread_ts requires, so the only way to
// reply under an alert Alertmanager posted is to find it again.
package slack

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/observability"
)

const (
	maxAttempts    = 3
	maxRetryWait   = 30 * time.Second
	defaultBackoff = time.Second
	// historyLimit is the page size for conversations.history. Most lookups
	// hit in the first page, so it stays small; an alert storm that buries the
	// notification deeper is followed through cursor pagination instead of a
	// bigger page.
	historyLimit = 50
	// maxHistoryPages bounds the pagination so a runaway channel cannot spin
	// the search forever. The oldest parameter usually ends the scan much
	// earlier by cutting at the lookup window.
	maxHistoryPages = 20
	// channelCacheTTL bounds how long a resolved name to ID mapping is reused.
	// Channel renames are rare, and a stale entry only costs one failed lookup.
	channelCacheTTL = time.Hour
)

// ErrMessageNotFound reports that no message in the searched window carried
// the marker.
var ErrMessageNotFound = errors.New("no matching message found")

// errChannelNotFound reports that a conversations.list sweep finished without
// seeing the requested channel name.
var errChannelNotFound = errors.New("channel not found")

// errRateLimited marks a throttled attempt, so the metrics can separate Slack
// pushing back from a call that actually failed.
var errRateLimited = errors.New("slack rate limited")

// attemptResult labels one API attempt for the metrics.
func attemptResult(err error) string {
	switch {
	case err == nil:
		return "ok"
	case errors.Is(err, errRateLimited):
		return "rate_limited"
	default:
		return "error"
	}
}

// Client calls the Slack Web API.
type Client struct {
	http    *http.Client
	apiURL  string
	token   string
	metrics *observability.Metrics
	logger  *slog.Logger
	backoff time.Duration

	mu       sync.Mutex
	channels map[string]channelEntry
	now      func() time.Time
}

type channelEntry struct {
	id       string
	resolved time.Time
}

// New returns a Client for the given API base URL (no trailing slash needed).
// metrics may be nil, which leaves the API calls unmeasured.
func New(apiURL, token string, timeout time.Duration, metrics *observability.Metrics, logger *slog.Logger) *Client {
	return &Client{
		http:     &http.Client{Timeout: timeout},
		apiURL:   strings.TrimSuffix(apiURL, "/"),
		token:    token,
		metrics:  metrics,
		logger:   logger,
		backoff:  defaultBackoff,
		channels: map[string]channelEntry{},
		now:      time.Now,
	}
}

// channelID matches the Slack conversation ID format, which the API accepts
// as-is and which must never be prefixed with a hash.
var channelID = regexp.MustCompile(`^[CGD][A-Z0-9]{6,}$`)

// NormalizeChannel prefixes a bare channel name with #, leaving an ID or an
// already-prefixed name untouched.
func NormalizeChannel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.HasPrefix(value, "#") || channelID.MatchString(value) {
		return value
	}
	return "#" + value
}

// Message describes one chat.postMessage call.
type Message struct {
	Channel string
	// Title and Color render an attachment; leave both empty to post Text
	// as a plain message, which is what thread replies do.
	Title string
	Color string
	Text  string
	// ThreadTS threads the message under an existing parent when set.
	ThreadTS string
}

type postRequest struct {
	Channel     string       `json:"channel"`
	Text        string       `json:"text"`
	ThreadTS    string       `json:"thread_ts,omitempty"`
	Attachments []attachment `json:"attachments,omitempty"`
}

type attachment struct {
	Color    string   `json:"color,omitempty"`
	Title    string   `json:"title,omitempty"`
	Text     string   `json:"text,omitempty"`
	MrkdwnIn []string `json:"mrkdwn_in,omitempty"`
}

type postResponse struct {
	OK      bool   `json:"ok"`
	TS      string `json:"ts"`
	Channel string `json:"channel"`
	Error   string `json:"error"`
}

// Post sends the message and returns its timestamp, which is the thread_ts
// for any reply that should hang under it.
func (c *Client) Post(ctx context.Context, msg Message) (string, error) {
	body := postRequest{Channel: msg.Channel, ThreadTS: msg.ThreadTS}
	if msg.Title != "" || msg.Color != "" {
		// The title doubles as the notification text: Slack shows the top-level
		// text field in the sidebar and in push notifications, and attachment
		// content alone would leave both blank.
		body.Text = msg.Title
		body.Attachments = []attachment{{
			Color:    msg.Color,
			Title:    msg.Title,
			Text:     msg.Text,
			MrkdwnIn: []string{"text"},
		}}
	} else {
		body.Text = msg.Text
	}

	raw, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("encode message: %w", err)
	}

	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		ts, retryAfter, err := c.post(ctx, raw)
		if err == nil {
			return ts, nil
		}
		lastErr = err
		if retryAfter < 0 || attempt == maxAttempts {
			break
		}
		if retryAfter == 0 {
			retryAfter = c.backoff * time.Duration(attempt)
		}
		c.logger.Warn("retrying slack post", "attempt", attempt, "wait", retryAfter.String(), "error", err)
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(retryAfter):
		}
	}
	return "", lastErr
}

// post performs one attempt and records it. A non-negative retryAfter marks the
// error as retryable; -1 marks it as permanent.
func (c *Client) post(ctx context.Context, raw []byte) (string, time.Duration, error) {
	started := c.now()
	ts, retryAfter, err := c.postOnce(ctx, raw)
	c.metrics.ObserveSlackRequest("chat.postMessage", attemptResult(err), c.now().Sub(started))
	return ts, retryAfter, err
}

func (c *Client) postOnce(ctx context.Context, raw []byte) (string, time.Duration, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL+"/chat.postMessage", bytes.NewReader(raw))
	if err != nil {
		return "", -1, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("call slack: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return "", 0, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode == http.StatusTooManyRequests {
		return "", retryAfter(resp.Header.Get("Retry-After")), errRateLimited
	}
	if resp.StatusCode >= 500 {
		return "", 0, fmt.Errorf("slack returned HTTP %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return "", -1, fmt.Errorf("slack returned HTTP %d", resp.StatusCode)
	}

	var out postResponse
	if err := json.Unmarshal(payload, &out); err != nil {
		return "", -1, fmt.Errorf("decode response: %w", err)
	}
	if !out.OK {
		if transientError(out.Error) {
			return "", 0, payloadError(out.Error)
		}
		return "", -1, fmt.Errorf("slack error: %s", out.Error)
	}
	return out.TS, 0, nil
}

// payloadError turns an ok=false code into an error, marking the throttled one
// so the metrics can tell being told to slow down from actually failing.
func payloadError(code string) error {
	if code == "ratelimited" {
		return fmt.Errorf("slack error: %s: %w", code, errRateLimited)
	}
	return fmt.Errorf("slack error: %s", code)
}

// transientError reports whether an ok=false response is worth retrying.
// Slack signals transient conditions through the error string, not the
// status code.
func transientError(code string) bool {
	return code == "ratelimited" || code == "service_unavailable" || code == "internal_error"
}

func retryAfter(header string) time.Duration {
	secs, err := strconv.Atoi(strings.TrimSpace(header))
	if err != nil || secs <= 0 {
		return 0
	}
	d := time.Duration(secs) * time.Second
	if d > maxRetryWait {
		return maxRetryWait
	}
	return d
}

// FindThreadParent returns the timestamp of the most recent message in channel
// that carries marker and is not older than since. channel accepts a name,
// a #name, or a conversation ID.
//
// Alertmanager renders the marker into its Slack template, which is the only
// join key available: an incoming webhook tells nobody what it posted, and
// slack_configs cannot carry a hidden identifier because it has no access to
// block_id.
func (c *Client) FindThreadParent(ctx context.Context, channel, marker string, since time.Time) (string, error) {
	if marker == "" {
		return "", fmt.Errorf("marker is empty")
	}
	id, err := c.resolveChannelID(ctx, channel)
	if err != nil {
		return "", err
	}

	// An alert storm can push the notification past any single page, so the
	// scan follows the cursor until the window is exhausted. conversations.history
	// returns newest first, so the first hit is the most recent notification
	// for this alert group.
	cursor := ""
	for range maxHistoryPages {
		query := url.Values{}
		query.Set("channel", id)
		query.Set("limit", strconv.Itoa(historyLimit))
		query.Set("inclusive", "true")
		if !since.IsZero() {
			query.Set("oldest", strconv.FormatInt(since.Unix(), 10))
		}
		if cursor != "" {
			query.Set("cursor", cursor)
		}

		var out struct {
			Messages []struct {
				TS          string `json:"ts"`
				Text        string `json:"text"`
				Attachments []struct {
					Title    string `json:"title"`
					Text     string `json:"text"`
					Footer   string `json:"footer"`
					Fallback string `json:"fallback"`
				} `json:"attachments"`
			} `json:"messages"`
			HasMore          bool `json:"has_more"`
			ResponseMetadata struct {
				NextCursor string `json:"next_cursor"`
			} `json:"response_metadata"`
		}
		if err := c.get(ctx, "conversations.history", query, &out); err != nil {
			return "", fmt.Errorf("read channel history: %w", err)
		}

		for _, msg := range out.Messages {
			if strings.Contains(msg.Text, marker) {
				return msg.TS, nil
			}
			for _, att := range msg.Attachments {
				if strings.Contains(att.Footer, marker) || strings.Contains(att.Text, marker) ||
					strings.Contains(att.Title, marker) || strings.Contains(att.Fallback, marker) {
					return msg.TS, nil
				}
			}
		}

		cursor = out.ResponseMetadata.NextCursor
		if !out.HasMore || cursor == "" {
			break
		}
	}
	return "", ErrMessageNotFound
}

// resolveChannelID maps a channel name to its ID, which conversations.history
// requires. chat.postMessage accepts a name, this call does not.
//
// Public channels are searched first because that only needs channels:read.
// Private channels are searched second and only when the name was not public,
// so a bot that threads exclusively in public channels never needs groups:read.
func (c *Client) resolveChannelID(ctx context.Context, channel string) (string, error) {
	name := strings.TrimPrefix(strings.TrimSpace(channel), "#")
	if name == "" {
		return "", fmt.Errorf("channel is empty")
	}
	if channelID.MatchString(name) {
		return name, nil
	}

	c.mu.Lock()
	entry, ok := c.channels[name]
	c.mu.Unlock()
	if ok && c.now().Sub(entry.resolved) < channelCacheTTL {
		return entry.id, nil
	}

	id, err := c.findChannel(ctx, name, "public_channel")
	if errors.Is(err, errChannelNotFound) {
		id, err = c.findChannel(ctx, name, "private_channel")
	}
	switch {
	case err == nil:
	case errors.Is(err, errChannelNotFound):
		return "", fmt.Errorf("channel %q not found; the bot must be able to see it", channel)
	case strings.Contains(err.Error(), "missing_scope"):
		return "", fmt.Errorf("channel %q is not a visible public channel, and listing private channels needs the groups:read scope: %w", channel, err)
	default:
		return "", err
	}

	c.mu.Lock()
	c.channels[name] = channelEntry{id: id, resolved: c.now()}
	c.mu.Unlock()
	return id, nil
}

// findChannel sweeps conversations.list for the given channel types and
// returns the ID whose name matches, or errChannelNotFound.
func (c *Client) findChannel(ctx context.Context, name, types string) (string, error) {
	cursor := ""
	for range 20 { // bounded so a paging bug cannot spin forever
		query := url.Values{}
		query.Set("limit", "1000")
		query.Set("exclude_archived", "true")
		query.Set("types", types)
		if cursor != "" {
			query.Set("cursor", cursor)
		}

		var out struct {
			Channels []struct {
				ID   string `json:"id"`
				Name string `json:"name"`
			} `json:"channels"`
			ResponseMetadata struct {
				NextCursor string `json:"next_cursor"`
			} `json:"response_metadata"`
		}
		if err := c.get(ctx, "conversations.list", query, &out); err != nil {
			return "", fmt.Errorf("list channels: %w", err)
		}
		for _, ch := range out.Channels {
			if ch.Name == name {
				return ch.ID, nil
			}
		}
		cursor = out.ResponseMetadata.NextCursor
		if cursor == "" {
			break
		}
	}
	return "", errChannelNotFound
}

// AddReaction puts an emoji reaction on the message at ts. name is the emoji
// name without colons; surrounding colons are stripped for convenience.
func (c *Client) AddReaction(ctx context.Context, channel, ts, name string) error {
	return c.react(ctx, "reactions.add", channel, ts, name)
}

// RemoveReaction removes an emoji reaction the bot added earlier.
func (c *Client) RemoveReaction(ctx context.Context, channel, ts, name string) error {
	return c.react(ctx, "reactions.remove", channel, ts, name)
}

// react resolves the channel and then calls the reaction method, recording only
// the reaction call: the channel resolution is a conversations.list call that
// records itself.
func (c *Client) react(ctx context.Context, method, channel, ts, name string) error {
	id, err := c.resolveChannelID(ctx, channel)
	if err != nil {
		return err
	}
	started := c.now()
	err = c.reactOnce(ctx, method, id, ts, name)
	c.metrics.ObserveSlackRequest(method, attemptResult(err), c.now().Sub(started))
	return err
}

func (c *Client) reactOnce(ctx context.Context, method, id, ts, name string) error {
	raw, err := json.Marshal(map[string]string{
		"channel":   id,
		"timestamp": ts,
		"name":      strings.Trim(strings.TrimSpace(name), ":"),
	})
	if err != nil {
		return fmt.Errorf("encode reaction: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.apiURL+"/"+method, bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("call slack: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("slack returned HTTP %d", resp.StatusCode)
	}

	var out struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(payload, &out); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}
	// Both states describe the outcome the caller wanted, so a duplicate add
	// or a remove of something already gone is not a failure.
	if !out.OK && out.Error != "already_reacted" && out.Error != "no_reaction" {
		return fmt.Errorf("slack error: %s", out.Error)
	}
	return nil
}

// get calls a read-only Web API method and decodes its payload into out.
// Reads sit on the parent-lookup path, where one unretried rate limit turns
// the analysis into an orphan channel message, so transient failures are
// retried the same way Post retries writes.
func (c *Client) get(ctx context.Context, method string, query url.Values, out any) error {
	var lastErr error
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		retryAfter, err := c.getOnce(ctx, method, query, out)
		if err == nil {
			return nil
		}
		lastErr = err
		if retryAfter < 0 || attempt == maxAttempts {
			break
		}
		if retryAfter == 0 {
			retryAfter = c.backoff * time.Duration(attempt)
		}
		c.logger.Warn("retrying slack read", "method", method, "attempt", attempt, "wait", retryAfter.String(), "error", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(retryAfter):
		}
	}
	return lastErr
}

// getOnce performs one attempt and records it. A non-negative retryAfter marks
// the error as retryable; -1 marks it as permanent.
func (c *Client) getOnce(ctx context.Context, method string, query url.Values, out any) (time.Duration, error) {
	started := c.now()
	retryAfter, err := c.getAttempt(ctx, method, query, out)
	c.metrics.ObserveSlackRequest(method, attemptResult(err), c.now().Sub(started))
	return retryAfter, err
}

func (c *Client) getAttempt(ctx context.Context, method string, query url.Values, out any) (time.Duration, error) {
	endpoint := c.apiURL + "/" + method + "?" + query.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return -1, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.http.Do(req)
	if err != nil {
		return 0, fmt.Errorf("call slack: %w", err)
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return 0, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		return retryAfter(resp.Header.Get("Retry-After")), errRateLimited
	}
	if resp.StatusCode >= 500 {
		return 0, fmt.Errorf("slack returned HTTP %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return -1, fmt.Errorf("slack returned HTTP %d", resp.StatusCode)
	}

	var status struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.Unmarshal(payload, &status); err != nil {
		return -1, fmt.Errorf("decode response: %w", err)
	}
	if !status.OK {
		if transientError(status.Error) {
			return 0, payloadError(status.Error)
		}
		return -1, fmt.Errorf("slack error: %s", status.Error)
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return -1, err
	}
	return 0, nil
}

// Truncate shortens text to maxRunes, appending a marker when it had to cut.
// Slack rejects oversized messages outright, so a long agent reply must be
// trimmed rather than dropped.
func Truncate(text string, maxRunes int) string {
	if maxRunes <= 0 {
		return text
	}
	runes := []rune(text)
	if len(runes) <= maxRunes {
		return text
	}
	const marker = "\n_(truncated)_"
	keep := maxRunes - len([]rune(marker))
	if keep < 0 {
		keep = 0
	}
	return string(runes[:keep]) + marker
}
