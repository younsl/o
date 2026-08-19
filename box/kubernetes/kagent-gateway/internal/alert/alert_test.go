package alert

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

const webhookBody = `{
  "version": "4",
  "groupKey": "{}:{alertname=\"KubePodCrashLooping\"}",
  "status": "firing",
  "receiver": "kagent-gateway",
  "groupLabels": {"alertname": "KubePodCrashLooping"},
  "commonLabels": {"alertname": "KubePodCrashLooping", "severity": "critical", "cluster": "prod-cluster"},
  "commonAnnotations": {"summary": "파드가 재시작을 반복합니다"},
  "externalURL": "http://alertmanager.example.com",
  "alerts": [
    {
      "status": "firing",
      "labels": {"alertname": "KubePodCrashLooping", "severity": "critical", "cluster": "prod-cluster", "namespace": "demo", "pod": "demo-api-0"},
      "annotations": {"summary": "파드가 재시작을 반복합니다", "description": "demo-api-0 restarted 7 times"},
      "startsAt": "2026-07-28T01:02:03Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "http://prometheus/graph",
      "fingerprint": "a1b2c3"
    }
  ]
}`

func decode(t *testing.T, body string) Payload {
	t.Helper()
	var p Payload
	if err := json.Unmarshal([]byte(body), &p); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	return p
}

func TestDecodeWebhook(t *testing.T) {
	p := decode(t, webhookBody)

	if p.Name() != "KubePodCrashLooping" {
		t.Errorf("Name() = %q", p.Name())
	}
	if p.Severity() != "critical" {
		t.Errorf("Severity() = %q", p.Severity())
	}
	if p.Cluster() != "prod-cluster" {
		t.Errorf("Cluster() = %q", p.Cluster())
	}
	if p.Resolved() {
		t.Error("Resolved() = true, want false")
	}
	if len(p.Alerts) != 1 || p.Alerts[0].Fingerprint != "a1b2c3" {
		t.Fatalf("alerts = %+v", p.Alerts)
	}
	if !p.Alerts[0].StartsAt.Equal(time.Date(2026, 7, 28, 1, 2, 3, 0, time.UTC)) {
		t.Errorf("StartsAt = %s", p.Alerts[0].StartsAt)
	}
}

func TestNameFallbacks(t *testing.T) {
	tests := []struct {
		name string
		p    Payload
		want string
	}{
		{"alertname", Payload{CommonLabels: map[string]string{"alertname": "A"}}, "A"},
		{"group label", Payload{GroupLabels: map[string]string{"alertname": "B"}}, "B"},
		{"falco rule", Payload{CommonLabels: map[string]string{"rule": "Terminal shell in container"}}, "Terminal shell in container"},
		{"receiver", Payload{Receiver: "falco-slack"}, "falco-slack"},
		{"nothing", Payload{}, "unknown"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.p.Name(); got != tt.want {
				t.Errorf("Name() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestTitleAndColor(t *testing.T) {
	tests := []struct {
		name      string
		p         Payload
		wantTitle string
		wantColor string
	}{
		{
			"critical firing",
			Payload{Status: "firing", CommonLabels: map[string]string{"alertname": "A", "severity": "critical"}},
			"🚨 [FIRING] A", "danger",
		},
		{
			"warning firing",
			Payload{Status: "firing", CommonLabels: map[string]string{"alertname": "A", "severity": "warning"}},
			"🚨 [FIRING] A", "warning",
		},
		{
			"info firing",
			Payload{Status: "firing", CommonLabels: map[string]string{"alertname": "A", "severity": "info"}},
			"ℹ️ [NOTED] A", "#439FE0",
		},
		{
			"resolved",
			Payload{Status: "resolved", CommonLabels: map[string]string{"alertname": "A", "severity": "critical"}},
			"✅ [RESOLVED] A", "good",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.p.Title(); got != tt.wantTitle {
				t.Errorf("Title() = %q, want %q", got, tt.wantTitle)
			}
			if got := tt.p.Color(); got != tt.wantColor {
				t.Errorf("Color() = %q, want %q", got, tt.wantColor)
			}
		})
	}
}

func TestSeverityUnknownWhenGroupMixes(t *testing.T) {
	p := Payload{Status: "firing", CommonLabels: map[string]string{"alertname": "A"}}
	if got := p.Severity(); got != "unknown" {
		t.Errorf("Severity() = %q, want unknown", got)
	}
}

func TestSlackText(t *testing.T) {
	got := decode(t, webhookBody).SlackText(5)

	for _, want := range []string{
		"*Severity:* critical",
		"*Summary:* 파드가 재시작을 반복합니다",
		"*Environment:* prod-cluster",
		"*Description:* demo-api-0 restarted 7 times",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("SlackText() missing %q\ngot:\n%s", want, got)
		}
	}
}

func TestSlackTextLimitsAlerts(t *testing.T) {
	p := Payload{Alerts: []Alert{
		{Annotations: map[string]string{"summary": "one"}},
		{Annotations: map[string]string{"summary": "two"}},
		{Annotations: map[string]string{"summary": "three"}},
	}}

	got := p.SlackText(1)
	if !strings.Contains(got, "one") {
		t.Errorf("SlackText() dropped the first alert:\n%s", got)
	}
	if strings.Contains(got, "two") {
		t.Errorf("SlackText() rendered past the limit:\n%s", got)
	}
	if !strings.Contains(got, "and 2 more alert(s)") {
		t.Errorf("SlackText() missing the overflow line:\n%s", got)
	}
}

// Alertmanager's own truncation must be added to the count the message
// reports, otherwise the reader sees fewer omitted alerts than there were.
func TestSlackTextCountsAlertmanagerTruncation(t *testing.T) {
	p := Payload{
		TruncatedAlerts: 4,
		Alerts:          []Alert{{Annotations: map[string]string{"summary": "one"}}},
	}
	if got := p.SlackText(5); !strings.Contains(got, "and 4 more alert(s)") {
		t.Errorf("SlackText() = %q", got)
	}
}

func TestPrompt(t *testing.T) {
	got := decode(t, webhookBody).Prompt("investigate it", 5)

	for _, want := range []string{
		"## Alert group",
		"status: firing",
		"cluster: prod-cluster",
		"alertCount: 1",
		"## Alert 1",
		"fingerprint: a1b2c3",
		"startsAt: 2026-07-28T01:02:03Z",
		"  namespace: demo",
		"  pod: demo-api-0",
		"## Instructions",
		"investigate it",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("Prompt() missing %q\ngot:\n%s", want, got)
		}
	}
	// endsAt is the zero value while the alert fires and must not be rendered.
	if strings.Contains(got, "endsAt") {
		t.Errorf("Prompt() rendered a zero endsAt:\n%s", got)
	}
}

// Map iteration order is random, so the same alert must still produce a
// byte-identical prompt for agent replies to be comparable across runs.
func TestPromptIsDeterministic(t *testing.T) {
	p := decode(t, webhookBody)
	first := p.Prompt("go", 5)
	for range 20 {
		if got := p.Prompt("go", 5); got != first {
			t.Fatalf("Prompt() is not deterministic:\n%s\n---\n%s", first, got)
		}
	}
}

func TestPromptReportsOmittedAlerts(t *testing.T) {
	p := Payload{Alerts: []Alert{{Status: "firing"}, {Status: "firing"}, {Status: "firing"}}}
	got := p.Prompt("go", 1)

	if strings.Contains(got, "## Alert 2") {
		t.Errorf("Prompt() rendered past the limit:\n%s", got)
	}
	if !strings.Contains(got, "2 further alert(s)") {
		t.Errorf("Prompt() missing the omission note:\n%s", got)
	}
}

func TestMarker(t *testing.T) {
	tests := []struct {
		name string
		p    Payload
		want string
	}{
		{"fingerprint", Payload{GroupKey: "gk", Alerts: []Alert{{Fingerprint: "fp"}}}, "fp"},
		{"group key fallback", Payload{GroupKey: "gk", Alerts: []Alert{{}}}, "gk"},
		{"nothing", Payload{}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.p.Marker(); got != tt.want {
				t.Errorf("Marker() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDedupeKey(t *testing.T) {
	tests := []struct {
		name string
		p    Payload
		want string
	}{
		{"group key", Payload{GroupKey: "gk"}, "gk"},
		{"fingerprint", Payload{Alerts: []Alert{{Fingerprint: "fp"}}}, "fp"},
		{"receiver and name", Payload{Receiver: "r", CommonLabels: map[string]string{"alertname": "A"}}, "r/A"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.p.DedupeKey(); got != tt.want {
				t.Errorf("DedupeKey() = %q, want %q", got, tt.want)
			}
		})
	}
}
