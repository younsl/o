package slackx

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// slack-go writes its own unstructured lines to stderr unless it is given a logger.
// A reconnect that lands outside the JSON format is invisible to any log query the
// operator has set up, so the bridge has to turn it into a normal record.
func TestSlogBridgeEmitsStructuredRecords(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil)).With("component", "slack")

	if err := (slogBridge{logger: logger}).Output(2, "slack-go/slack/socketmode reconnecting\n"); err != nil {
		t.Fatalf("Output returned error: %v", err)
	}

	var record map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &record); err != nil {
		t.Fatalf("the bridged line is not structured: %q", buf.String())
	}
	if record["component"] != "slack" {
		t.Fatalf("component = %v, want slack", record["component"])
	}
	msg, _ := record["msg"].(string)
	if !strings.Contains(msg, "reconnecting") {
		t.Fatalf("msg = %q, want the library's text", msg)
	}
	if strings.HasSuffix(msg, "\n") {
		t.Fatalf("msg = %q, want the trailing newline trimmed", msg)
	}
}
