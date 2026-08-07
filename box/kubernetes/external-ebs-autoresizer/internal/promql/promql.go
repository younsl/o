// Package promql runs instant queries against a Prometheus-compatible HTTP API
// and is deliberately limited to that one read-only operation.
//
// Both Prometheus and Grafana Mimir are supported, since Mimir implements the
// same /api/v1/query contract. Two deployment differences are handled here so
// the same config works against either backend:
//
//   - API path prefix. Prometheus serves the API at <base>/api/v1, while a Mimir
//     query-frontend or gateway usually serves it under <base>/prometheus/api/v1.
//     Preflight probes the known prefixes and pins whichever one answers, so the
//     configured URL may include the prefix or omit it.
//   - Tenant header. Mimir resolves the tenant from X-Scope-OrgID and rejects
//     queries without it when multi-tenancy is enabled. Setting tenantID sends
//     the header; Prometheus ignores it.
//
// Queries are sent as POST with a form-encoded body rather than GET, because a
// generated PromQL expression is long enough to hit URL length limits in proxies
// that sit in front of either backend. Both accept POST on /api/v1/query.
package promql

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// queryPath is the instant-query endpoint, appended after the resolved API
// prefix.
const queryPath = "/api/v1/query"

// apiPrefixes are the base-URL suffixes probed by Preflight, in order: the empty
// prefix matches Prometheus and a Mimir URL that already includes the prefix,
// "/prometheus" matches a bare Mimir gateway or query-frontend URL.
var apiPrefixes = []string{"", "/prometheus"}

// preflightQuery is the cheapest expression that exercises the full query path
// (routing, auth, tenant resolution) without reading any series.
const preflightQuery = "vector(1)"

// tenantHeader carries the Mimir tenant ID. It is ignored by Prometheus.
const tenantHeader = "X-Scope-OrgID"

// Client queries a Prometheus-compatible endpoint. It is safe for concurrent
// use.
type Client struct {
	base       string
	httpClient *http.Client
	headers    map[string]string
	logger     *slog.Logger

	// mu guards prefix, which Preflight pins once at startup and Query reads on
	// every call.
	mu     sync.RWMutex
	prefix string
}

// New builds a Client targeting baseURL, which may be a Prometheus server
// (http://prometheus-operated.monitoring:9090), a Mimir query-frontend, or a
// Mimir gateway, with or without the /prometheus API prefix. tenantID, when
// non-empty, is sent as X-Scope-OrgID for Mimir multi-tenancy. headers are extra
// static headers merged into every request (e.g. an auth header for a gateway in
// front of either backend) and win over the tenant header on a key collision.
// timeout bounds each query.
func New(baseURL, tenantID string, timeout time.Duration, headers map[string]string, logger *slog.Logger) *Client {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if logger == nil {
		logger = slog.Default()
	}
	merged := make(map[string]string, len(headers)+1)
	if tenantID != "" {
		merged[tenantHeader] = tenantID
	}
	maps.Copy(merged, headers)
	return &Client{
		base:       strings.TrimRight(baseURL, "/"),
		httpClient: &http.Client{Timeout: timeout},
		headers:    merged,
		logger:     logger,
	}
}

// Sample is one series of an instant-query result: its label set and the single
// value at the evaluation timestamp.
type Sample struct {
	Labels map[string]string
	Value  float64
}

// Endpoint returns the full query endpoint currently in use. Before Preflight
// runs it reflects the first candidate prefix.
func (c *Client) Endpoint() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.base + c.prefix + queryPath
}

// Preflight resolves the API prefix and verifies the endpoint answers a trivial
// query. It returns the resolved endpoint, the HTTP status, the request latency,
// and an error when no candidate prefix works. It never mutates state on the
// backend.
//
// A prefix is rejected and the next one tried only on 404 or 405, the statuses a
// wrong path produces. Any other failure (connection refused, 401, 500) is
// reported as-is, so a genuine auth or connectivity problem is not misreported
// as a path problem.
func (c *Client) Preflight(ctx context.Context) (string, int, time.Duration, error) {
	var (
		endpoint string
		status   int
		latency  time.Duration
		err      error
	)
	for _, prefix := range apiPrefixes {
		endpoint = c.base + prefix + queryPath
		start := time.Now()
		_, status, err = c.do(ctx, endpoint, preflightQuery)
		latency = time.Since(start)
		if err == nil {
			c.mu.Lock()
			c.prefix = prefix
			c.mu.Unlock()
			return endpoint, status, latency, nil
		}
		if status == http.StatusNotFound || status == http.StatusMethodNotAllowed {
			c.logger.Debug("prometheus api prefix not found, trying next",
				"endpoint", endpoint, "status", status)
			continue
		}
		return endpoint, status, latency, err
	}
	return endpoint, status, latency, fmt.Errorf("no Prometheus-compatible API found under %s (tried prefixes %q): %w", c.base, apiPrefixes, err)
}

// Query runs one instant query and returns its result vector. A scalar result is
// returned as a single label-less Sample. An empty result is not an error: the
// caller decides whether a node with no data is a problem.
func (c *Client) Query(ctx context.Context, query string) ([]Sample, error) {
	samples, _, err := c.do(ctx, c.Endpoint(), query)
	return samples, err
}

// wireResponse is the JSON envelope Prometheus and Mimir both return.
type wireResponse struct {
	Status    string   `json:"status"`
	ErrorType string   `json:"errorType"`
	Error     string   `json:"error"`
	Warnings  []string `json:"warnings"`
	Data      struct {
		ResultType string          `json:"resultType"`
		Result     json.RawMessage `json:"result"`
	} `json:"data"`
}

// wireSample is one vector element. value is [<unix seconds>, "<value>"]: the
// value is a JSON string, not a number, so NaN and Inf survive the encoding.
type wireSample struct {
	Metric map[string]string `json:"metric"`
	Value  []json.RawMessage `json:"value"`
}

// do posts one query to endpoint and decodes the result. It returns the HTTP
// status alongside the samples so Preflight can distinguish a wrong API prefix
// from a real failure; the status is 0 when the request never completed.
func (c *Client) do(ctx context.Context, endpoint, query string) ([]Sample, int, error) {
	form := url.Values{"query": []string{query}}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, 0, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("post %s: %w", endpoint, err)
	}
	defer resp.Body.Close()

	// Prometheus and Mimir report a bad query as 400 with the reason in the JSON
	// body, so the body is read before the status is judged: it carries the only
	// actionable detail (which part of the expression failed to parse).
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if readErr != nil {
		return nil, resp.StatusCode, fmt.Errorf("read response from %s: %w", endpoint, readErr)
	}
	var wire wireResponse
	decodeErr := json.Unmarshal(body, &wire)
	if wire.Status == "error" {
		return nil, resp.StatusCode, fmt.Errorf("query rejected by %s (%s): %s", endpoint, wire.ErrorType, wire.Error)
	}
	if resp.StatusCode >= 300 {
		return nil, resp.StatusCode, fmt.Errorf("query %s returned %s: %s", endpoint, resp.Status, snippet(body))
	}
	if decodeErr != nil {
		return nil, resp.StatusCode, fmt.Errorf("decode response from %s: %w", endpoint, decodeErr)
	}
	for _, w := range wire.Warnings {
		c.logger.Warn("prometheus query warning", "warning", w, "query", query)
	}

	samples, err := decodeResult(wire.Data.ResultType, wire.Data.Result)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("%w (query %q)", err, query)
	}
	return samples, resp.StatusCode, nil
}

// decodeResult converts a vector or scalar result into Samples. Matrix and
// string results are rejected: every query this package sends is an instant
// query that must reduce to one value per series, and silently accepting a
// matrix would mean recommending from a partially read result.
func decodeResult(resultType string, raw json.RawMessage) ([]Sample, error) {
	switch resultType {
	case "vector":
		var wire []wireSample
		if err := json.Unmarshal(raw, &wire); err != nil {
			return nil, fmt.Errorf("decode vector result: %w", err)
		}
		out := make([]Sample, 0, len(wire))
		for _, w := range wire {
			v, err := sampleValue(w.Value)
			if err != nil {
				return nil, err
			}
			out = append(out, Sample{Labels: w.Metric, Value: v})
		}
		return out, nil
	case "scalar":
		var pair []json.RawMessage
		if err := json.Unmarshal(raw, &pair); err != nil {
			return nil, fmt.Errorf("decode scalar result: %w", err)
		}
		v, err := sampleValue(pair)
		if err != nil {
			return nil, err
		}
		return []Sample{{Labels: map[string]string{}, Value: v}}, nil
	default:
		return nil, fmt.Errorf("unsupported result type %q, expected vector or scalar", resultType)
	}
}

// sampleValue extracts the float from a [timestamp, "value"] pair.
func sampleValue(pair []json.RawMessage) (float64, error) {
	if len(pair) != 2 {
		return 0, fmt.Errorf("malformed sample: expected [timestamp, value], got %d elements", len(pair))
	}
	var s string
	if err := json.Unmarshal(pair[1], &s); err != nil {
		return 0, fmt.Errorf("decode sample value: %w", err)
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0, fmt.Errorf("parse sample value %q: %w", s, err)
	}
	return v, nil
}

// snippet trims a response body down to a loggable length.
func snippet(body []byte) string {
	const limit = 512
	s := strings.TrimSpace(string(body))
	if len(s) > limit {
		return s[:limit] + "..."
	}
	return s
}
