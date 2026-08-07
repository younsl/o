// Package promx queries a Prometheus-compatible HTTP API (Prometheus, Mimir,
// Thanos) so the controller can judge how much traffic a tunnel is actually
// carrying before it replaces one.
//
// The cron window says when maintenance is allowed. This says whether now is
// actually a quiet moment, which a fixed schedule cannot know: a 02:00 window is
// only low-impact until a batch job moves.
package promx

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Client runs instant queries against a Prometheus-compatible API.
type Client struct {
	baseURL string
	headers map[string]string
	http    *http.Client
}

// Config parameterizes the client.
type Config struct {
	// Endpoint is the API base URL, the part before /api/v1/query. For Mimir that
	// is usually the .../prometheus path.
	Endpoint string
	// Headers are sent with every request, for tenant selectors such as
	// X-Scope-OrgID or an Authorization header.
	Headers map[string]string
	// Timeout bounds a single query.
	Timeout time.Duration
}

// New builds a Client.
func New(cfg Config) (*Client, error) {
	if cfg.Endpoint == "" {
		return nil, fmt.Errorf("prometheus endpoint is required")
	}
	if _, err := url.Parse(cfg.Endpoint); err != nil {
		return nil, fmt.Errorf("invalid prometheus endpoint %q: %w", cfg.Endpoint, err)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	return &Client{
		baseURL: strings.TrimSuffix(cfg.Endpoint, "/"),
		headers: cfg.Headers,
		http:    &http.Client{Timeout: timeout},
	}, nil
}

// ErrNoData reports that the query succeeded but matched no series. It is distinct
// from a failure because the two deserve different treatment: no data may mean a
// genuinely idle tunnel, or a wrong query, and the caller decides which.
var ErrNoData = fmt.Errorf("query returned no data")

// queryResponse is the subset of the Prometheus API response that matters here.
type queryResponse struct {
	Status string `json:"status"`
	Error  string `json:"error"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Value  [2]json.RawMessage   `json:"value"`
			Values [][2]json.RawMessage `json:"values"`
		} `json:"result"`
		// A scalar result carries the value directly rather than in a series.
		Scalar [2]json.RawMessage `json:"result_scalar,omitempty"`
	} `json:"data"`
}

// Sample is one point of a range query, in the order the API returned it.
type Sample struct {
	At time.Time
	V  float64
}

// Query runs an instant query and returns a single sample value.
//
// Anything other than exactly one value is an error: a query meant to gate an
// irreversible operation has to be unambiguous, and silently taking the first of
// several series would hide a missing aggregation.
func (c *Client) Query(ctx context.Context, promql string) (float64, error) {
	parsed, err := c.post(ctx, "/api/v1/query", url.Values{"query": {promql}})
	if err != nil {
		return 0, err
	}

	switch parsed.Data.ResultType {
	case "vector":
		if len(parsed.Data.Result) == 0 {
			return 0, ErrNoData
		}
		if len(parsed.Data.Result) > 1 {
			return 0, fmt.Errorf("query returned %d series; it must aggregate to exactly one",
				len(parsed.Data.Result))
		}
		return decodeSample(parsed.Data.Result[0].Value)
	case "scalar":
		return decodeSample(parsed.Data.Scalar)
	default:
		return 0, fmt.Errorf("unsupported result type %q; the query must return an instant vector or scalar",
			parsed.Data.ResultType)
	}
}

// QueryRange runs a range query and returns the one series it must aggregate to.
//
// The gate judges "quiet" against how much this connection usually carries during
// its maintenance window, and that distribution is a range of samples rather than a
// single number: an instant query could only be compared against a threshold
// somebody had to pick by hand.
func (c *Client) QueryRange(ctx context.Context, promql string, start, end time.Time, step time.Duration) ([]Sample, error) {
	form := url.Values{
		"query": {promql},
		"start": {strconv.FormatInt(start.Unix(), 10)},
		"end":   {strconv.FormatInt(end.Unix(), 10)},
		"step":  {strconv.FormatInt(int64(step.Seconds()), 10)},
	}
	parsed, err := c.post(ctx, "/api/v1/query_range", form)
	if err != nil {
		return nil, err
	}
	if parsed.Data.ResultType != "matrix" {
		return nil, fmt.Errorf("unsupported result type %q; a range query must return a matrix",
			parsed.Data.ResultType)
	}
	if len(parsed.Data.Result) == 0 {
		return nil, ErrNoData
	}
	if len(parsed.Data.Result) > 1 {
		return nil, fmt.Errorf("range query returned %d series; it must aggregate to exactly one",
			len(parsed.Data.Result))
	}

	raw := parsed.Data.Result[0].Values
	samples := make([]Sample, 0, len(raw))
	for _, point := range raw {
		v, err := decodeSample(point)
		// A NaN in the middle of a range is a gap, not a failure: the exporter may
		// simply not have been scraped then, and dropping the point keeps the rest
		// of the distribution usable.
		if errors.Is(err, ErrNoData) {
			continue
		}
		if err != nil {
			return nil, err
		}
		at, err := decodeTimestamp(point)
		if err != nil {
			return nil, err
		}
		samples = append(samples, Sample{At: at, V: v})
	}
	if len(samples) == 0 {
		return nil, ErrNoData
	}
	return samples, nil
}

// post sends one form-encoded query and decodes the envelope both query shapes share.
func (c *Client) post(ctx context.Context, path string, form url.Values) (*queryResponse, error) {
	endpoint := c.baseURL + path

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, fmt.Errorf("build prometheus request: %w", err)
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for k, v := range c.headers {
		req.Header.Set(k, v)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("query prometheus at %s: %w", endpoint, err)
	}
	defer func() { _ = resp.Body.Close() }()

	// Generous, because a four-week range at a five-minute step is thousands of
	// points; the instant path never comes close to it.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, fmt.Errorf("read prometheus response: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus returned %s: %s", resp.Status, strings.TrimSpace(string(body)))
	}

	var parsed queryResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode prometheus response: %w", err)
	}
	if parsed.Status != "success" {
		return nil, fmt.Errorf("prometheus query failed: %s", parsed.Error)
	}
	return &parsed, nil
}

// decodeTimestamp reads the timestamp half of a [timestamp, "value"] pair, which the
// API sends as a number of seconds with a fractional part.
func decodeTimestamp(sample [2]json.RawMessage) (time.Time, error) {
	var seconds float64
	if err := json.Unmarshal(sample[0], &seconds); err != nil {
		return time.Time{}, fmt.Errorf("decode sample timestamp: %w", err)
	}
	return time.Unix(int64(seconds), 0), nil
}

// decodeSample reads the [timestamp, "value"] pair Prometheus returns.
func decodeSample(sample [2]json.RawMessage) (float64, error) {
	var raw string
	if err := json.Unmarshal(sample[1], &raw); err != nil {
		return 0, fmt.Errorf("decode sample value: %w", err)
	}
	v, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return 0, fmt.Errorf("sample value %q is not a number: %w", raw, err)
	}
	// NaN is what Prometheus returns for an undefined expression, and comparing it
	// against a threshold would silently pass.
	if math.IsNaN(v) {
		return 0, ErrNoData
	}
	return v, nil
}
