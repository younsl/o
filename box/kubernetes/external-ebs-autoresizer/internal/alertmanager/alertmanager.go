// Package alertmanager posts notifications about resize operations to the
// Alertmanager v2 API (POST /api/v2/alerts). Alerts are sent with only a
// startsAt timestamp, so Alertmanager auto-resolves them after its configured
// resolve_timeout: each resize is a one-shot event rather than a long-lived
// firing alert.
package alertmanager

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"strings"
	"time"
)

// alertsPath is the Alertmanager v2 endpoint for posting alerts.
const alertsPath = "/api/v2/alerts"

// Client posts alerts to an Alertmanager v2 endpoint. It implements
// resizer.AlertNotifier. Delivery is best-effort: failures are logged, never
// returned, so alerting never blocks or fails a reconcile.
type Client struct {
	endpoint    string
	httpClient  *http.Client
	extraLabels map[string]string
	logger      *slog.Logger
}

// New builds a Client targeting baseURL (e.g. http://alertmanager:9093). timeout
// bounds each POST. extraLabels are merged into every alert's labels for routing
// (e.g. cluster or environment); per-alert labels take precedence.
func New(baseURL string, timeout time.Duration, extraLabels map[string]string, logger *slog.Logger) *Client {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Client{
		endpoint:    strings.TrimRight(baseURL, "/") + alertsPath,
		httpClient:  &http.Client{Timeout: timeout},
		extraLabels: extraLabels,
		logger:      logger,
	}
}

// wireAlert is the JSON shape of a single Alertmanager v2 postable alert.
type wireAlert struct {
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations,omitempty"`
	StartsAt    string            `json:"startsAt,omitempty"`
}

// Notify builds and posts a single alert. severity and alertname become labels;
// summary and description become annotations (description is omitted when
// empty). labels are per-alert identifying labels (e.g. instance_id, volume_id)
// merged on top of the client's static extraLabels. startsAt is the alert's
// start time; Alertmanager auto-resolves it later.
func (c *Client) Notify(ctx context.Context, severity, alertname, summary, description string, labels map[string]string, startsAt time.Time) {
	merged := map[string]string{}
	maps.Copy(merged, c.extraLabels)
	maps.Copy(merged, labels)
	merged["alertname"] = alertname
	merged["severity"] = severity

	annotations := map[string]string{"summary": summary}
	if description != "" {
		annotations["description"] = description
	}
	alert := wireAlert{
		Labels:      merged,
		Annotations: annotations,
		StartsAt:    startsAt.UTC().Format(time.RFC3339),
	}
	if err := c.post(ctx, []wireAlert{alert}); err != nil {
		c.logger.Warn("failed to send Alertmanager alert", "alertname", alertname, "error", err)
	}
}

func (c *Client) post(ctx context.Context, alerts []wireAlert) error {
	body, err := json.Marshal(alerts)
	if err != nil {
		return fmt.Errorf("marshal alerts: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("post %s: %w", c.endpoint, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("alertmanager returned %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}
