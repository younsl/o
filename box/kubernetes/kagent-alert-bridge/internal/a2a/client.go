// Package a2a is a minimal client for the kagent A2A JSON-RPC endpoint.
//
// The analysis is submitted as a non-blocking message/send and its task is
// then polled with tasks/get until it reaches a terminal state. Polling keeps
// every HTTP request short, which no load balancer idle timeout can kill, and
// it leaves a task ID behind that a deadline can cancel with tasks/cancel
// instead of abandoning the run to keep burning tokens. Streaming would let
// the bridge post partial output, but the reply is one Slack message, so the
// poll loop reports task state through Request.OnProgress instead, which is
// enough to keep a status line current without a second transport.
package a2a

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/observability"
)

// maxConsecutivePollFailures bounds how many tasks/get calls may fail in a row
// before the run is abandoned. Combined with the poll interval this tolerates
// roughly half a minute of controller unavailability, which covers a restart.
const maxConsecutivePollFailures = 6

// Client talks to the kagent controller over A2A. One Client serves every
// agent in a namespace: the controller exposes each agent under its own path,
// so the agent is chosen per call rather than per connection.
type Client struct {
	http         *http.Client
	baseURL      string
	namespace    string
	userID       string
	metrics      *observability.Metrics
	logger       *slog.Logger
	pollInterval time.Duration
	now          func() time.Time
}

// New returns a Client for the controller at baseURL, e.g.
// http://kagent-controller.kagent:8083, serving agents in namespace.
// requestTimeout bounds one HTTP call (submit, poll, or cancel), not the whole
// analysis; the analysis deadline is the context given to Send. metrics may be
// nil, which leaves the exchange unmeasured.
func New(baseURL, namespace, userID string, requestTimeout, pollInterval time.Duration, metrics *observability.Metrics, logger *slog.Logger) *Client {
	return &Client{
		http:         &http.Client{Timeout: requestTimeout},
		baseURL:      strings.TrimSuffix(baseURL, "/"),
		namespace:    namespace,
		userID:       userID,
		metrics:      metrics,
		logger:       logger,
		pollInterval: pollInterval,
		now:          time.Now,
	}
}

// Endpoint returns the A2A JSON-RPC endpoint one agent is served on.
func (c *Client) Endpoint(agent string) string {
	return fmt.Sprintf("%s/api/a2a/%s/%s", c.baseURL, c.namespace, agent)
}

type request struct {
	JSONRPC string `json:"jsonrpc"`
	ID      string `json:"id"`
	Method  string `json:"method"`
	Params  any    `json:"params"`
}

type sendParams struct {
	Message       message `json:"message"`
	Configuration reqConf `json:"configuration"`
}

type taskParams struct {
	ID            string `json:"id"`
	HistoryLength int    `json:"historyLength,omitempty"`
}

type reqConf struct {
	Blocking bool `json:"blocking"`
}

type message struct {
	Kind      string `json:"kind"`
	Role      string `json:"role"`
	MessageID string `json:"messageId"`
	ContextID string `json:"contextId,omitempty"`
	Parts     []part `json:"parts"`
}

type part struct {
	Kind string `json:"kind"`
	Text string `json:"text"`
}

type response struct {
	Error  *rpcError `json:"error"`
	Result struct {
		// Kind distinguishes a Task result from a direct Message result,
		// which the spec allows a server to return for an instant reply.
		Kind      string `json:"kind"`
		ID        string `json:"id"`
		ContextID string `json:"contextId"`
		// Parts is only set on a message-kind result.
		Parts     []part `json:"parts"`
		Artifacts []struct {
			Parts []part `json:"parts"`
		} `json:"artifacts"`
		History []struct {
			Role  string `json:"role"`
			Parts []part `json:"parts"`
		} `json:"history"`
		Status struct {
			State   string `json:"state"`
			Message *struct {
				Parts []part `json:"parts"`
			} `json:"message"`
		} `json:"status"`
	} `json:"result"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Result is the outcome of one analysis run.
type Result struct {
	Text      string
	TaskID    string
	ContextID string
}

// Request is one call to an agent.
type Request struct {
	Agent string
	Text  string
	// ContextID continues an existing session. Empty starts a new one, which
	// is what the alert path always does: an alert is not a conversation.
	ContextID string
	// OnProgress is called as the task moves, so a caller can report the run
	// while it is still running. It runs on the polling goroutine, so an
	// implementation must not block: the mention path only records the state
	// and lets its own ticker do the Slack call.
	OnProgress func(Progress)
}

// Progress is one observation of a running task.
type Progress struct {
	TaskID string
	// State is the task state the controller last reported, e.g. submitted,
	// working, or completed.
	State string
	// Polls is how many tasks/get reads have been spent so far.
	Polls int
}

// Send submits a request to an agent and polls the resulting task until it
// completes, fails, or ctx expires. On ctx expiry the task is cancelled so an
// abandoned run stops consuming model tokens.
func (c *Client) Send(ctx context.Context, req Request) (Result, error) {
	agent := req.Agent
	out, err := c.call(ctx, agent, "message/send", sendParams{
		Message: message{
			Kind:      "message",
			Role:      "user",
			MessageID: randomID(),
			ContextID: req.ContextID,
			Parts:     []part{{Kind: "text", Text: req.Text}},
		},
		Configuration: reqConf{Blocking: false},
	})
	if err != nil {
		return Result{}, fmt.Errorf("submit analysis: %w", err)
	}

	// A server may answer a trivial request with a plain message instead of a
	// task, in which case there is nothing to poll.
	if out.Result.Kind == "message" {
		res := Result{ContextID: out.Result.ContextID}
		var b strings.Builder
		writeParts(&b, out.Result.Parts)
		res.Text = strings.TrimSpace(b.String())
		if res.Text == "" {
			return res, fmt.Errorf("agent returned an empty message")
		}
		return res, nil
	}

	taskID := out.Result.ID
	if taskID == "" {
		return Result{}, fmt.Errorf("agent returned no task id (state %q)", out.Result.Status.State)
	}
	// Timing the task from the accepted submission separates the controller's
	// own processing time from the queueing and Slack work around it.
	submitted := c.now()
	c.logger.Info("analysis task submitted", "agent", agent, "task_id", taskID, "state", out.Result.Status.State)
	report(req.OnProgress, Progress{TaskID: taskID, State: out.Result.Status.State})

	if terminal(out.Result.Status.State) {
		c.metrics.ObserveAgentTask(agent, out.Result.Status.State, 0, c.now().Sub(submitted))
		return c.finalize(out)
	}
	return c.poll(ctx, agent, taskID, submitted, req.OnProgress)
}

// report calls a progress hook when the caller supplied one.
func report(hook func(Progress), p Progress) {
	if hook != nil {
		hook(p)
	}
}

// poll reads the task state every pollInterval until it turns terminal or ctx
// expires. Transient read failures are tolerated up to
// maxConsecutivePollFailures so one dropped poll does not abandon a paid run.
func (c *Client) poll(ctx context.Context, agent, taskID string, submitted time.Time, onProgress func(Progress)) (Result, error) {
	ticker := time.NewTicker(c.pollInterval)
	defer ticker.Stop()

	polls, failures := 0, 0
	for {
		select {
		case <-ctx.Done():
			c.metrics.ObserveAgentTask(agent, "timeout", polls, c.now().Sub(submitted))
			c.cancelTask(agent, taskID)
			return Result{TaskID: taskID}, fmt.Errorf("analysis deadline exceeded, task cancelled: %w", ctx.Err())
		case <-ticker.C:
		}

		polls++
		out, err := c.call(ctx, agent, "tasks/get", taskParams{ID: taskID, HistoryLength: 50})
		if err != nil {
			// A cancelled context surfaces as a call error too; route it to the
			// deadline path so the task still gets cancelled.
			if ctx.Err() != nil {
				c.metrics.ObserveAgentTask(agent, "timeout", polls, c.now().Sub(submitted))
				c.cancelTask(agent, taskID)
				return Result{TaskID: taskID}, fmt.Errorf("analysis deadline exceeded, task cancelled: %w", ctx.Err())
			}
			failures++
			if failures >= maxConsecutivePollFailures {
				c.metrics.ObserveAgentTask(agent, "unreachable", polls, c.now().Sub(submitted))
				return Result{TaskID: taskID}, fmt.Errorf("gave up polling task after %d consecutive failures: %w", failures, err)
			}
			c.logger.Warn("task poll failed, retrying", "agent", agent, "task_id", taskID, "failures", failures, "error", err)
			continue
		}
		failures = 0
		report(onProgress, Progress{TaskID: taskID, State: out.Result.Status.State, Polls: polls})

		if terminal(out.Result.Status.State) {
			c.metrics.ObserveAgentTask(agent, out.Result.Status.State, polls, c.now().Sub(submitted))
			return c.finalize(out)
		}
		c.logger.Debug("task still running", "agent", agent, "task_id", taskID, "state", out.Result.Status.State)
	}
}

// cancelTask tells the controller to stop a task the bridge no longer waits
// for. It runs on its own context because the caller's one is already dead.
func (c *Client) cancelTask(agent, taskID string) {
	ctx, cancel := context.WithTimeout(context.Background(), c.http.Timeout)
	defer cancel()
	if _, err := c.call(ctx, agent, "tasks/cancel", taskParams{ID: taskID}); err != nil {
		c.logger.Warn("failed to cancel task", "agent", agent, "task_id", taskID, "error", err)
		return
	}
	c.logger.Info("cancelled abandoned task", "agent", agent, "task_id", taskID)
}

// terminal reports whether a task state can still change. input-required and
// auth-required cannot progress either: the bridge is a one-shot caller with
// nobody to answer a follow-up question.
func terminal(state string) bool {
	switch state {
	case "completed", "failed", "canceled", "rejected", "input-required", "auth-required":
		return true
	}
	return false
}

// finalize turns a terminal task into a Result or an error.
func (c *Client) finalize(out response) (Result, error) {
	res := Result{
		Text:      answer(out),
		TaskID:    out.Result.ID,
		ContextID: out.Result.ContextID,
	}
	state := out.Result.Status.State
	switch state {
	case "completed", "input-required":
		// input-required carries the agent's question as its final text, which
		// is still worth posting: it usually names what was missing.
		if res.Text == "" {
			return res, fmt.Errorf("agent returned no text (task state %q)", state)
		}
		c.logger.Debug("agent replied", "task_id", res.TaskID, "context_id", res.ContextID, "state", state, "chars", len(res.Text))
		return res, nil
	default:
		if res.Text != "" {
			return res, fmt.Errorf("task ended in state %q: %s", state, snippet([]byte(res.Text)))
		}
		return res, fmt.Errorf("task ended in state %q", state)
	}
}

// call performs one JSON-RPC request and decodes the envelope, recording the
// attempt so a slow or failing controller is visible per method.
func (c *Client) call(ctx context.Context, agent, method string, params any) (response, error) {
	started := c.now()
	out, err := c.do(ctx, agent, method, params)
	result := "ok"
	if err != nil {
		result = "error"
	}
	c.metrics.ObserveAgentRequest(method, result, c.now().Sub(started))
	return out, err
}

func (c *Client) do(ctx context.Context, agent, method string, params any) (response, error) {
	body, err := json.Marshal(request{
		JSONRPC: "2.0",
		ID:      randomID(),
		Method:  method,
		Params:  params,
	})
	if err != nil {
		return response{}, fmt.Errorf("encode request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint(agent), bytes.NewReader(body))
	if err != nil {
		return response{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	// The controller runs with auth.mode=unsecure, where X-User-Id selects the
	// session owner. A stable ID keeps every analysis under one kagent user,
	// and tasks/get only sees tasks submitted by the same user.
	req.Header.Set("X-User-Id", c.userID)

	resp, err := c.http.Do(req)
	if err != nil {
		return response{}, fmt.Errorf("call agent: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return response{}, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return response{}, fmt.Errorf("agent returned HTTP %d: %s", resp.StatusCode, snippet(raw))
	}

	var out response
	if err := json.Unmarshal(raw, &out); err != nil {
		return response{}, fmt.Errorf("decode response: %w", err)
	}
	if out.Error != nil {
		return response{}, fmt.Errorf("agent error %d: %s", out.Error.Code, out.Error.Message)
	}
	return out, nil
}

// answer extracts the reply text. The controller puts the final answer in
// artifacts, but a task that ends in an input-required or failed state carries
// its message under status instead, and older agents only fill history.
func answer(out response) string {
	var b strings.Builder
	for _, artifact := range out.Result.Artifacts {
		writeParts(&b, artifact.Parts)
	}
	if b.Len() > 0 {
		return strings.TrimSpace(b.String())
	}
	if out.Result.Status.Message != nil {
		writeParts(&b, out.Result.Status.Message.Parts)
		if b.Len() > 0 {
			return strings.TrimSpace(b.String())
		}
	}
	for i := len(out.Result.History) - 1; i >= 0; i-- {
		if out.Result.History[i].Role != "agent" {
			continue
		}
		writeParts(&b, out.Result.History[i].Parts)
		if b.Len() > 0 {
			return strings.TrimSpace(b.String())
		}
	}
	return ""
}

func writeParts(b *strings.Builder, parts []part) {
	for _, p := range parts {
		if p.Kind != "" && p.Kind != "text" {
			continue
		}
		if p.Text == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n")
		}
		b.WriteString(p.Text)
	}
}

func randomID() string {
	var buf [16]byte
	// crypto/rand.Read never returns an error on supported platforms.
	_, _ = rand.Read(buf[:])
	return hex.EncodeToString(buf[:])
}

func snippet(raw []byte) string {
	const max = 200
	s := strings.TrimSpace(string(raw))
	if len(s) > max {
		return s[:max] + "..."
	}
	return s
}
