// Package opensearch is a minimal read-only client for the two OpenSearch
// APIs the viewer needs: the Dashboards saved-objects index (index patterns)
// and the field capabilities API.
package opensearch

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

// FieldCap is one type entry for a field in a _field_caps response. Indices
// is only populated by OpenSearch when the field has more than one type.
type FieldCap struct {
	Type    string   `json:"type"`
	Indices []string `json:"indices"`
}

// FieldCaps is the subset of the _field_caps response the viewer consumes.
type FieldCaps struct {
	Indices []string                       `json:"indices"`
	Fields  map[string]map[string]FieldCap `json:"fields"`
}

// Client talks to a single OpenSearch endpoint with optional basic auth.
type Client struct {
	baseURL  string
	username string
	password string
	http     *http.Client
}

// New builds a Client. baseURL must include the scheme, e.g.
// https://opensearch.example.com:443.
func New(baseURL, username, password string) *Client {
	return &Client{
		baseURL:  strings.TrimRight(baseURL, "/"),
		username: username,
		password: password,
		http:     &http.Client{Timeout: 120 * time.Second},
	}
}

// IndexPatterns returns the sorted, de-duplicated titles of every index
// pattern saved object in the Dashboards saved-objects index.
func (c *Client) IndexPatterns(ctx context.Context, kibanaIndex string) ([]string, error) {
	path := fmt.Sprintf("/%s/_search?size=1000&_source=index-pattern.title&q=type:index-pattern",
		url.PathEscape(kibanaIndex))
	var res struct {
		Hits struct {
			Hits []struct {
				Source struct {
					IndexPattern struct {
						Title string `json:"title"`
					} `json:"index-pattern"`
				} `json:"_source"`
			} `json:"hits"`
		} `json:"hits"`
	}
	if err := c.get(ctx, path, &res); err != nil {
		return nil, fmt.Errorf("fetch index patterns: %w", err)
	}

	seen := map[string]bool{}
	var patterns []string
	for _, h := range res.Hits.Hits {
		title := h.Source.IndexPattern.Title
		if title == "" || seen[title] {
			continue
		}
		seen[title] = true
		patterns = append(patterns, title)
	}
	sort.Strings(patterns)
	return patterns, nil
}

// FieldCapabilities returns field capabilities for every field across the
// comma-separated index targets, e.g. "logs-*" or "logs-*,logstash-*".
func (c *Client) FieldCapabilities(ctx context.Context, targets string) (FieldCaps, error) {
	path := fmt.Sprintf("/%s/_field_caps?fields=*", url.PathEscape(targets))
	var caps FieldCaps
	if err := c.get(ctx, path, &caps); err != nil {
		return FieldCaps{}, fmt.Errorf("fetch field caps: %w", err)
	}
	return caps, nil
}

func (c *Client) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	if c.username != "" {
		req.SetBasicAuth(c.username, c.password)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("GET %s: status %d: %s", path, resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
