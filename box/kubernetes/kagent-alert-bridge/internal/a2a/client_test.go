package a2a

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/younsl/o/box/kubernetes/kagent-alert-bridge/internal/observability"
)

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

const testAgent = "alert-triage-agent"

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return New(srv.URL, "kagent", "bridge@kagent.dev", 5*time.Second, 10*time.Millisecond, observability.NewMetrics(), testLogger())
}

// rpcMethod extracts the JSON-RPC method from a request body and hands the
// decoded envelope back for parameter assertions.
func rpcMethod(t *testing.T, r *http.Request) (string, map[string]any) {
	t.Helper()
	var body map[string]any
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		t.Errorf("decode request: %v", err)
	}
	method, _ := body["method"].(string)
	return method, body
}

func TestSendSubmitsNonBlockingAndReturnsImmediateResult(t *testing.T) {
	var gotBody map[string]any
	var gotUser, gotContentType string

	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		gotUser = r.Header.Get("X-User-Id")
		gotContentType = r.Header.Get("Content-Type")
		_, gotBody = rpcMethod(t, r)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"jsonrpc":"2.0","id":"1","result":{
			"kind":"task","id":"task-1","contextId":"ctx-1",
			"status":{"state":"completed"},
			"artifacts":[{"parts":[{"kind":"text","text":"*Summary* pod is crashlooping"}]}]}}`)
	})

	res, err := client.Send(context.Background(), testAgent, "analyse this")
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if res.Text != "*Summary* pod is crashlooping" {
		t.Errorf("Text = %q", res.Text)
	}
	if res.TaskID != "task-1" || res.ContextID != "ctx-1" {
		t.Errorf("ids = %q/%q", res.TaskID, res.ContextID)
	}
	if gotUser != "bridge@kagent.dev" {
		t.Errorf("X-User-Id = %q", gotUser)
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type = %q", gotContentType)
	}
	if gotBody["method"] != "message/send" {
		t.Errorf("method = %v", gotBody["method"])
	}
	params, _ := gotBody["params"].(map[string]any)
	conf, _ := params["configuration"].(map[string]any)
	if conf["blocking"] != false {
		t.Errorf("configuration.blocking = %v, want false", conf["blocking"])
	}
	msg, _ := params["message"].(map[string]any)
	parts, _ := msg["parts"].([]any)
	first, _ := parts[0].(map[string]any)
	if first["text"] != "analyse this" {
		t.Errorf("prompt = %v", first["text"])
	}
	if msg["messageId"] == "" {
		t.Error("messageId must be set")
	}
}

// The normal polled path: message/send acknowledges the task, tasks/get sees
// it working, then completed.
func TestSendPollsUntilCompleted(t *testing.T) {
	var polls atomic.Int32
	var gotHistoryLength float64
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		method, body := rpcMethod(t, r)
		switch method {
		case "message/send":
			io.WriteString(w, `{"result":{"kind":"task","id":"task-9","contextId":"ctx-9",
				"status":{"state":"submitted"}}}`)
		case "tasks/get":
			params, _ := body["params"].(map[string]any)
			if id, _ := params["id"].(string); id != "task-9" {
				t.Errorf("tasks/get id = %q", id)
			}
			gotHistoryLength, _ = params["historyLength"].(float64)
			if polls.Add(1) < 3 {
				io.WriteString(w, `{"result":{"kind":"task","id":"task-9","status":{"state":"working"}}}`)
				return
			}
			io.WriteString(w, `{"result":{"kind":"task","id":"task-9","contextId":"ctx-9",
				"status":{"state":"completed"},
				"artifacts":[{"parts":[{"kind":"text","text":"done"}]}]}}`)
		default:
			t.Errorf("unexpected method %q", method)
		}
	})

	res, err := client.Send(context.Background(), testAgent, "prompt")
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if res.Text != "done" || res.TaskID != "task-9" {
		t.Errorf("res = %+v", res)
	}
	if polls.Load() != 3 {
		t.Errorf("polls = %d, want 3", polls.Load())
	}
	if gotHistoryLength == 0 {
		t.Error("historyLength must be requested so the history fallback has data")
	}
}

// One dropped poll must not abandon a run the model is still paying for.
func TestSendToleratesTransientPollFailures(t *testing.T) {
	var polls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		method, _ := rpcMethod(t, r)
		if method == "message/send" {
			io.WriteString(w, `{"result":{"kind":"task","id":"t1","status":{"state":"submitted"}}}`)
			return
		}
		switch polls.Add(1) {
		case 1:
			w.WriteHeader(http.StatusInternalServerError)
		case 2:
			io.WriteString(w, `{not json`)
		default:
			io.WriteString(w, `{"result":{"kind":"task","id":"t1","status":{"state":"completed"},
				"artifacts":[{"parts":[{"kind":"text","text":"ok"}]}]}}`)
		}
	})

	res, err := client.Send(context.Background(), testAgent, "prompt")
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if res.Text != "ok" {
		t.Errorf("Text = %q", res.Text)
	}
}

func TestSendGivesUpAfterConsecutivePollFailures(t *testing.T) {
	var polls atomic.Int32
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		method, _ := rpcMethod(t, r)
		if method == "message/send" {
			io.WriteString(w, `{"result":{"kind":"task","id":"t1","status":{"state":"submitted"}}}`)
			return
		}
		polls.Add(1)
		w.WriteHeader(http.StatusBadGateway)
	})

	_, err := client.Send(context.Background(), testAgent, "prompt")
	if err == nil || !strings.Contains(err.Error(), "gave up polling") {
		t.Fatalf("error = %v", err)
	}
	if polls.Load() != maxConsecutivePollFailures {
		t.Errorf("polls = %d, want %d", polls.Load(), maxConsecutivePollFailures)
	}
}

// When the analysis deadline expires the task must be cancelled, not merely
// abandoned to keep consuming tokens.
func TestSendCancelsTaskOnContextExpiry(t *testing.T) {
	cancelled := make(chan string, 1)
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		method, body := rpcMethod(t, r)
		switch method {
		case "message/send":
			io.WriteString(w, `{"result":{"kind":"task","id":"task-slow","status":{"state":"submitted"}}}`)
		case "tasks/get":
			io.WriteString(w, `{"result":{"kind":"task","id":"task-slow","status":{"state":"working"}}}`)
		case "tasks/cancel":
			params, _ := body["params"].(map[string]any)
			id, _ := params["id"].(string)
			select {
			case cancelled <- id:
			default:
			}
			io.WriteString(w, `{"result":{"kind":"task","id":"task-slow","status":{"state":"canceled"}}}`)
		}
	})

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	res, err := client.Send(ctx, testAgent, "prompt")
	if err == nil || !strings.Contains(err.Error(), "deadline exceeded") {
		t.Fatalf("error = %v", err)
	}
	if res.TaskID != "task-slow" {
		t.Errorf("TaskID = %q, want it reported even on failure", res.TaskID)
	}
	select {
	case id := <-cancelled:
		if id != "task-slow" {
			t.Errorf("cancelled task = %q", id)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("tasks/cancel was never called")
	}
}

// A server may answer with a plain message instead of a task, in which case
// there is nothing to poll.
func TestSendAcceptsDirectMessageResult(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		method, _ := rpcMethod(t, r)
		if method != "message/send" {
			t.Errorf("unexpected method %q", method)
		}
		io.WriteString(w, `{"result":{"kind":"message","contextId":"ctx-2",
			"parts":[{"kind":"text","text":"instant answer"}]}}`)
	})

	res, err := client.Send(context.Background(), testAgent, "prompt")
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if res.Text != "instant answer" || res.ContextID != "ctx-2" {
		t.Errorf("res = %+v", res)
	}
}

func TestSendJoinsMultipleParts(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"result":{"kind":"task","id":"t1","status":{"state":"completed"},"artifacts":[
			{"parts":[{"kind":"text","text":"first"},{"kind":"data","text":"ignored"}]},
			{"parts":[{"kind":"text","text":"second"}]}]}}`)
	})

	res, err := client.Send(context.Background(), testAgent, "prompt")
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if res.Text != "first\nsecond" {
		t.Errorf("Text = %q", res.Text)
	}
}

// A task that ends without artifacts still carries its answer, so the client
// must fall back rather than report an empty reply.
func TestSendFallsBackToStatusAndHistory(t *testing.T) {
	t.Run("status message", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			io.WriteString(w, `{"result":{"kind":"task","id":"t1","status":{"state":"input-required",
				"message":{"parts":[{"kind":"text","text":"which namespace?"}]}}}}`)
		})
		res, err := client.Send(context.Background(), testAgent, "prompt")
		if err != nil {
			t.Fatalf("Send() error = %v", err)
		}
		if res.Text != "which namespace?" {
			t.Errorf("Text = %q", res.Text)
		}
	})

	t.Run("last agent message", func(t *testing.T) {
		client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
			io.WriteString(w, `{"result":{"kind":"task","id":"t1","status":{"state":"completed"},"history":[
				{"role":"user","parts":[{"kind":"text","text":"prompt"}]},
				{"role":"agent","parts":[{"kind":"text","text":"older"}]},
				{"role":"agent","parts":[{"kind":"text","text":"newest"}]}]}}`)
		})
		res, err := client.Send(context.Background(), testAgent, "prompt")
		if err != nil {
			t.Fatalf("Send() error = %v", err)
		}
		if res.Text != "newest" {
			t.Errorf("Text = %q, want the last agent message", res.Text)
		}
	})
}

func TestSendErrors(t *testing.T) {
	tests := []struct {
		name    string
		handler http.HandlerFunc
		wantErr string
	}{
		{
			"rpc error",
			func(w http.ResponseWriter, _ *http.Request) {
				io.WriteString(w, `{"error":{"code":-32603,"message":"agent not found"}}`)
			},
			"agent not found",
		},
		{
			"http error",
			func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusInternalServerError)
				io.WriteString(w, "boom")
			},
			"HTTP 500",
		},
		{
			"malformed json",
			func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "{not json") },
			"decode response",
		},
		{
			"no task id",
			func(w http.ResponseWriter, _ *http.Request) {
				io.WriteString(w, `{"result":{"kind":"task","status":{"state":"submitted"}}}`)
			},
			"no task id",
		},
		{
			"failed task",
			func(w http.ResponseWriter, _ *http.Request) {
				io.WriteString(w, `{"result":{"kind":"task","id":"t1","status":{"state":"failed",
					"message":{"parts":[{"kind":"text","text":"tool exploded"}]}}}}`)
			},
			`state "failed"`,
		},
		{
			"empty completed reply",
			func(w http.ResponseWriter, _ *http.Request) {
				io.WriteString(w, `{"result":{"kind":"task","id":"t1","status":{"state":"completed"}}}`)
			},
			"no text",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := newTestClient(t, tt.handler)
			_, err := client.Send(context.Background(), testAgent, "prompt")
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("error = %v, want it to mention %q", err, tt.wantErr)
			}
		})
	}
}

// The failed-task error must carry the agent's own words, or the Slack thread
// only ever says "failed" with nothing to act on.
func TestSendFailedTaskIncludesStatusMessage(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, `{"result":{"kind":"task","id":"t1","status":{"state":"failed",
			"message":{"parts":[{"kind":"text","text":"tool exploded"}]}}}}`)
	})
	_, err := client.Send(context.Background(), testAgent, "prompt")
	if err == nil || !strings.Contains(err.Error(), "tool exploded") {
		t.Fatalf("error = %v, want the status message included", err)
	}
}

func TestSendRespectsContextDuringSubmit(t *testing.T) {
	// The handler holds the request open until the test is done. It cannot
	// wait on the request context instead: the server only notices the
	// abandoned client on the next read, so httptest.Server.Close would block.
	release := make(chan struct{})
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		<-release
	})
	t.Cleanup(func() { close(release) })

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := client.Send(ctx, testAgent, "prompt"); err == nil {
		t.Fatal("expected an error when the context expires")
	}
}

func TestRandomIDIsUnique(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		id := randomID()
		if len(id) != 32 {
			t.Fatalf("randomID() = %q, want 32 hex characters", id)
		}
		if seen[id] {
			t.Fatalf("randomID() repeated %q", id)
		}
		seen[id] = true
	}
}

func TestSnippetTruncates(t *testing.T) {
	if got := snippet([]byte("  short  ")); got != "short" {
		t.Errorf("snippet() = %q", got)
	}
	long := strings.Repeat("x", 500)
	got := snippet([]byte(long))
	if len(got) != 203 || !strings.HasSuffix(got, "...") {
		t.Errorf("snippet() length = %d, suffix = %q", len(got), got[len(got)-3:])
	}
}

// A slow analysis is almost always the controller taking its time, so the task
// duration and the poll count it cost are recorded per terminal state.
func TestSendRecordsTaskMetrics(t *testing.T) {
	metrics := observability.NewMetrics()
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, _ := rpcMethod(t, r)
		switch method {
		case "message/send":
			io.WriteString(w, `{"result":{"kind":"task","id":"task-m","status":{"state":"submitted"}}}`)
		case "tasks/get":
			if polls.Add(1) < 2 {
				io.WriteString(w, `{"result":{"kind":"task","id":"task-m","status":{"state":"working"}}}`)
				return
			}
			io.WriteString(w, `{"result":{"kind":"task","id":"task-m","status":{"state":"completed"},
				"artifacts":[{"parts":[{"kind":"text","text":"done"}]}]}}`)
		default:
			t.Errorf("unexpected method %q", method)
		}
	}))
	t.Cleanup(srv.Close)

	client := New(srv.URL, "kagent", "bridge@kagent.dev", 5*time.Second, time.Millisecond, metrics, testLogger())
	if _, err := client.Send(context.Background(), testAgent, "prompt"); err != nil {
		t.Fatalf("Send() error = %v", err)
	}

	if got := seriesCount(t, metrics, "kagent_alert_bridge_agent_task_duration_seconds", map[string]string{"state": "completed"}); got != 1 {
		t.Errorf("agent_task_duration_seconds_count{state=\"completed\"} = %v, want 1", got)
	}
	if got := seriesSum(t, metrics, "kagent_alert_bridge_agent_task_polls", nil); got != 2 {
		t.Errorf("agent_task_polls_sum = %v, want 2", got)
	}
	if got := seriesCount(t, metrics, "kagent_alert_bridge_agent_request_duration_seconds", map[string]string{"method": "tasks/get"}); got != 2 {
		t.Errorf("agent_request_duration_seconds_count{method=\"tasks/get\"} = %v, want 2", got)
	}
}

// A cancelled analysis never reaches a controller state, so the bridge labels it
// itself; without that the timed-out runs would be invisible in the histogram.
func TestSendRecordsTimeoutAsATaskState(t *testing.T) {
	metrics := observability.NewMetrics()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method, _ := rpcMethod(t, r)
		if method == "message/send" {
			io.WriteString(w, `{"result":{"kind":"task","id":"task-t","status":{"state":"working"}}}`)
			return
		}
		io.WriteString(w, `{"result":{"kind":"task","id":"task-t","status":{"state":"working"}}}`)
	}))
	t.Cleanup(srv.Close)

	client := New(srv.URL, "kagent", "bridge@kagent.dev", 5*time.Second, 5*time.Millisecond, metrics, testLogger())
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := client.Send(ctx, testAgent, "prompt"); err == nil {
		t.Fatal("expected the deadline to end the run")
	}

	if got := seriesCount(t, metrics, "kagent_alert_bridge_agent_task_duration_seconds", map[string]string{"state": "timeout"}); got != 1 {
		t.Errorf("agent_task_duration_seconds_count{state=\"timeout\"} = %v, want 1", got)
	}
}

// seriesCount and seriesSum read one histogram off the registry, which is what a
// scrape would see.
func seriesCount(t *testing.T, m *observability.Metrics, name string, labels map[string]string) float64 {
	t.Helper()
	if h := histogram(t, m, name, labels); h != nil {
		return float64(h.GetSampleCount())
	}
	return -1
}

func seriesSum(t *testing.T, m *observability.Metrics, name string, labels map[string]string) float64 {
	t.Helper()
	if h := histogram(t, m, name, labels); h != nil {
		return h.GetSampleSum()
	}
	return -1
}

func histogram(t *testing.T, m *observability.Metrics, name string, labels map[string]string) *dto.Histogram {
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
				return metric.GetHistogram()
			}
		}
	}
	return nil
}

// One Client serves every agent, so the agent name has to reach the URL of
// each call rather than being fixed when the client is built.
func TestEndpointIsBuiltPerAgent(t *testing.T) {
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		method, _ := rpcMethod(t, r)
		if method == "message/send" {
			io.WriteString(w, `{"result":{"kind":"task","id":"task-1","status":{"state":"working"}}}`)
			return
		}
		io.WriteString(w, `{"result":{"kind":"task","id":"task-1","status":{"state":"completed"},
			"artifacts":[{"parts":[{"kind":"text","text":"done"}]}]}}`)
	}))
	t.Cleanup(srv.Close)

	// The trailing slash is what a controller URL copied out of a values file
	// usually carries, and it must not double up in the path.
	client := New(srv.URL+"/", "kagent", "bridge@kagent.dev", 5*time.Second, time.Millisecond, nil, testLogger())
	if got := client.Endpoint("security-alert-triage-agent"); got != srv.URL+"/api/a2a/kagent/security-alert-triage-agent" {
		t.Errorf("Endpoint() = %q", got)
	}
	if _, err := client.Send(context.Background(), "security-alert-triage-agent", "prompt"); err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	for _, path := range paths {
		if path != "/api/a2a/kagent/security-alert-triage-agent" {
			t.Errorf("call went to %q, want the agent's own path", path)
		}
	}
}
