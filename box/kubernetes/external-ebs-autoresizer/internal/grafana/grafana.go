// Package grafana posts annotations about resize operations to the Grafana
// HTTP API (POST /api/annotations). Annotations are tag-based and global (no
// dashboardUID), so any dashboard that subscribes to the configured tags via a
// "-- Grafana --" annotation query renders the resize markers. A resize that
// completes is posted as a region annotation spanning its duration (time +
// timeEnd); a failure is posted as a point annotation (time only).
package grafana

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// annotationsPath is the Grafana endpoint for posting annotations.
const annotationsPath = "/api/annotations"

// Client posts annotations to a Grafana endpoint. It implements
// resizer.Annotator. Delivery is best-effort: failures are logged, never
// returned, so annotating never blocks or fails a reconcile.
type Client struct {
	endpoint   string
	token      string
	httpClient *http.Client
	baseTags   []string
	logger     *slog.Logger
}

// New builds a Client targeting baseURL (e.g. http://grafana.monitoring:3000).
// token is a Grafana service account token sent as a Bearer credential. timeout
// bounds each POST. baseTags are merged into every annotation's tags and are
// what dashboards subscribe to (e.g. event:ebs-resize); per-annotation tags are
// appended after them.
func New(baseURL, token string, timeout time.Duration, baseTags []string, logger *slog.Logger) *Client {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Client{
		endpoint:   strings.TrimRight(baseURL, "/") + annotationsPath,
		token:      token,
		httpClient: &http.Client{Timeout: timeout},
		baseTags:   baseTags,
		logger:     logger,
	}
}

// wireAnnotation is the JSON shape of a single Grafana annotation. time and
// timeEnd are epoch milliseconds; timeEnd is omitted for a point annotation.
type wireAnnotation struct {
	Time    int64    `json:"time"`
	TimeEnd int64    `json:"timeEnd,omitempty"`
	Tags    []string `json:"tags"`
	Text    string   `json:"text"`
}

// Annotate builds and posts a single annotation. text is the marker body; tags
// are per-annotation tags appended to the client's baseTags. start is the
// marker time; when end is non-zero the annotation is a region spanning
// start..end, otherwise it is a point annotation at start.
func (c *Client) Annotate(ctx context.Context, text string, tags []string, start, end time.Time) {
	merged := make([]string, 0, len(c.baseTags)+len(tags))
	merged = append(merged, c.baseTags...)
	merged = append(merged, tags...)

	ann := wireAnnotation{
		Time: start.UnixMilli(),
		Tags: merged,
		Text: text,
	}
	if !end.IsZero() {
		ann.TimeEnd = end.UnixMilli()
	}
	if err := c.post(ctx, ann); err != nil {
		c.logger.Warn("failed to post Grafana annotation", "error", err)
	}
}

func (c *Client) post(ctx context.Context, ann wireAnnotation) error {
	body, err := json.Marshal(ann)
	if err != nil {
		return fmt.Errorf("marshal annotation: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("post %s: %w", c.endpoint, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("grafana returned %s: %s", resp.Status, strings.TrimSpace(string(msg)))
	}
	return nil
}
