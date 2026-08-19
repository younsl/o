// Package alert decodes Alertmanager webhook payloads and renders them for
// Slack and for the analysis agent.
package alert

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// Payload is the body Alertmanager POSTs to a webhook receiver.
// Ref: https://prometheus.io/docs/alerting/latest/configuration/#webhook_config
type Payload struct {
	Version           string            `json:"version"`
	GroupKey          string            `json:"groupKey"`
	TruncatedAlerts   int               `json:"truncatedAlerts"`
	Status            string            `json:"status"`
	Receiver          string            `json:"receiver"`
	GroupLabels       map[string]string `json:"groupLabels"`
	CommonLabels      map[string]string `json:"commonLabels"`
	CommonAnnotations map[string]string `json:"commonAnnotations"`
	ExternalURL       string            `json:"externalURL"`
	Alerts            []Alert           `json:"alerts"`
}

// Alert is a single alert instance inside a Payload.
type Alert struct {
	Status       string            `json:"status"`
	Labels       map[string]string `json:"labels"`
	Annotations  map[string]string `json:"annotations"`
	StartsAt     time.Time         `json:"startsAt"`
	EndsAt       time.Time         `json:"endsAt"`
	GeneratorURL string            `json:"generatorURL"`
	Fingerprint  string            `json:"fingerprint"`
}

// Resolved reports whether the whole group has stopped firing.
func (p Payload) Resolved() bool { return p.Status == "resolved" }

// Name returns the alertname, falling back to the receiver so a message is
// never titled with an empty string.
func (p Payload) Name() string {
	if v := p.label("alertname"); v != "" {
		return v
	}
	if v := p.label("rule"); v != "" { // Falco alerts group by rule, not alertname
		return v
	}
	if p.Receiver != "" {
		return p.Receiver
	}
	return "unknown"
}

// Severity returns the common severity label, or "unknown" when the group
// mixes severities and Alertmanager therefore drops the label.
func (p Payload) Severity() string {
	if v := p.label("severity"); v != "" {
		return v
	}
	return "unknown"
}

// Cluster returns the cluster label shared by the group.
func (p Payload) Cluster() string { return p.label("cluster") }

// DedupeKey identifies the alert group across repeated notifications.
// Alertmanager reuses groupKey for the lifetime of a group, so it is stable
// across repeat_interval resends while still separating distinct groups.
func (p Payload) DedupeKey() string {
	if p.GroupKey != "" {
		return p.GroupKey
	}
	if len(p.Alerts) > 0 && p.Alerts[0].Fingerprint != "" {
		return p.Alerts[0].Fingerprint
	}
	return p.Receiver + "/" + p.Name()
}

// Marker is the token an Alertmanager Slack template renders so the gateway can
// recognise its own alert in channel history. The first alert's fingerprint is
// short, opaque, and reproducible from the same notification, which is what a
// join key across two independent Alertmanager deliveries has to be.
func (p Payload) Marker() string {
	if len(p.Alerts) > 0 && p.Alerts[0].Fingerprint != "" {
		return p.Alerts[0].Fingerprint
	}
	return p.GroupKey
}

func (p Payload) label(key string) string {
	if v := p.CommonLabels[key]; v != "" {
		return v
	}
	return p.GroupLabels[key]
}

// Title renders the Slack message title using the same emoji and status
// wording the Alertmanager slack_configs templates used before the gateway.
func (p Payload) Title() string {
	switch {
	case p.Resolved():
		return fmt.Sprintf("✅ [RESOLVED] %s", p.Name())
	case p.Severity() == "info":
		return fmt.Sprintf("ℹ️ [NOTED] %s", p.Name())
	default:
		return fmt.Sprintf("🚨 [FIRING] %s", p.Name())
	}
}

// Color returns the Slack attachment colour for the group.
func (p Payload) Color() string {
	switch {
	case p.Resolved():
		return "good"
	case p.Severity() == "critical":
		return "danger"
	case p.Severity() == "warning":
		return "warning"
	default:
		return "#439FE0"
	}
}

// SlackText renders the alert body posted as the Slack parent message.
// At most maxAlerts entries are rendered; the rest are summarised in a
// trailing line so a large group never produces an unreadable wall of text.
func (p Payload) SlackText(maxAlerts int) string {
	var b strings.Builder
	for i, a := range p.limit(maxAlerts) {
		if i > 0 {
			b.WriteString("\n")
		}
		writeLine(&b, "Severity", a.Labels["severity"])
		writeLine(&b, "Summary", a.Annotations["summary"])
		writeLine(&b, "Environment", a.Labels["cluster"])
		writeLine(&b, "Description", a.Annotations["description"])
	}
	if n := p.omitted(maxAlerts); n > 0 {
		fmt.Fprintf(&b, "\n_and %d more alert(s) in this group_", n)
	}
	return strings.TrimSpace(b.String())
}

// Prompt renders the analysis request sent to the agent. The alert is
// serialised as plain text rather than JSON because the agent reasons over it
// directly and the label set is small.
func (p Payload) Prompt(instructions string, maxAlerts int) string {
	var b strings.Builder
	b.WriteString("An alert group fired in the monitoring stack. Investigate it.\n\n")
	b.WriteString("## Alert group\n")
	writeField(&b, "status", p.Status)
	writeField(&b, "receiver", p.Receiver)
	writeField(&b, "groupKey", p.GroupKey)
	writeField(&b, "cluster", p.Cluster())
	writeField(&b, "alertname", p.Name())
	writeField(&b, "externalURL", p.ExternalURL)
	writeField(&b, "alertCount", fmt.Sprintf("%d", len(p.Alerts)))

	for i, a := range p.limit(maxAlerts) {
		fmt.Fprintf(&b, "\n## Alert %d\n", i+1)
		writeField(&b, "status", a.Status)
		writeField(&b, "fingerprint", a.Fingerprint)
		if !a.StartsAt.IsZero() {
			writeField(&b, "startsAt", a.StartsAt.UTC().Format(time.RFC3339))
		}
		if !a.EndsAt.IsZero() && a.EndsAt.After(a.StartsAt) {
			writeField(&b, "endsAt", a.EndsAt.UTC().Format(time.RFC3339))
		}
		writeField(&b, "generatorURL", a.GeneratorURL)
		writeMap(&b, "labels", a.Labels)
		writeMap(&b, "annotations", a.Annotations)
	}
	if n := p.omitted(maxAlerts); n > 0 {
		fmt.Fprintf(&b, "\n%d further alert(s) in this group were omitted from this prompt.\n", n)
	}

	b.WriteString("\n## Instructions\n")
	b.WriteString(instructions)
	b.WriteString("\n")
	return b.String()
}

func (p Payload) limit(maxAlerts int) []Alert {
	if maxAlerts > 0 && len(p.Alerts) > maxAlerts {
		return p.Alerts[:maxAlerts]
	}
	return p.Alerts
}

func (p Payload) omitted(maxAlerts int) int {
	n := len(p.Alerts) - len(p.limit(maxAlerts))
	return n + p.TruncatedAlerts
}

func writeLine(b *strings.Builder, key, value string) {
	if value == "" {
		return
	}
	fmt.Fprintf(b, "*%s:* %s\n", key, value)
}

func writeField(b *strings.Builder, key, value string) {
	if value == "" {
		return
	}
	fmt.Fprintf(b, "%s: %s\n", key, value)
}

// writeMap renders a label or annotation set with sorted keys so the same
// alert always produces the same prompt, which keeps agent replies comparable.
func writeMap(b *strings.Builder, name string, m map[string]string) {
	if len(m) == 0 {
		return
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Fprintf(b, "%s:\n", name)
	for _, k := range keys {
		fmt.Fprintf(b, "  %s: %s\n", k, m[k])
	}
}
