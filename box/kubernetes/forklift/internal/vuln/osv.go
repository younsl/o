package vuln

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// OSVScanner queries the OSV database (https://osv.dev) for a coordinate. The
// endpoint is operator-configured and trusted, so a plain client is used; the
// caller may pass an SSRF-guarded client for hardened deployments.
type OSVScanner struct {
	url    string
	client *http.Client
}

// NewOSV builds a scanner against baseURL (e.g. https://api.osv.dev). A nil
// client gets a default with a short timeout.
func NewOSV(baseURL string, client *http.Client) *OSVScanner {
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &OSVScanner{url: strings.TrimRight(baseURL, "/"), client: client}
}

type osvQuery struct {
	Version string     `json:"version"`
	Package osvPackage `json:"package"`
}

type osvPackage struct {
	Name      string `json:"name"`
	Ecosystem string `json:"ecosystem"`
}

type osvResponse struct {
	Vulns []osvVuln `json:"vulns"`
}

type osvVuln struct {
	ID        string   `json:"id"`
	Aliases   []string `json:"aliases"`
	Withdrawn string   `json:"withdrawn"`
	Severity  []struct {
		Type  string `json:"type"`
		Score string `json:"score"`
	} `json:"severity"`
	DatabaseSpecific struct {
		Severity string `json:"severity"`
	} `json:"database_specific"`
}

// Query asks OSV which advisories affect the exact version. OSV resolves the
// affected-version ranges server-side, avoiding error-prone local version
// comparison across ecosystem version schemes.
func (o *OSVScanner) Query(ctx context.Context, ecosystem, pkg, version string) (Finding, error) {
	if pkg == "" || version == "" {
		return Finding{}, nil
	}
	body, err := json.Marshal(osvQuery{Version: version, Package: osvPackage{Name: pkg, Ecosystem: ecosystem}})
	if err != nil {
		return Finding{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, o.url+"/v1/query", bytes.NewReader(body))
	if err != nil {
		return Finding{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := o.client.Do(req)
	if err != nil {
		return Finding{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Finding{}, fmt.Errorf("osv query: status %d", resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return Finding{}, err
	}
	var doc osvResponse
	if err := json.Unmarshal(raw, &doc); err != nil {
		return Finding{}, err
	}

	var f Finding
	seen := map[string]bool{}
	for _, v := range doc.Vulns {
		if v.Withdrawn != "" { // retracted advisory: ignore
			continue
		}
		id := v.ID
		// Prefer a CVE alias for readability when present.
		for _, a := range v.Aliases {
			if strings.HasPrefix(a, "CVE-") {
				id = a
				break
			}
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		f.IDs = append(f.IDs, id)
		if sev := severityOf(v); sev > f.Max {
			f.Max = sev
		}
	}
	return f, nil
}

// severityOf derives a severity for one advisory. It prefers the GHSA-style
// database_specific label, then a numeric CVSS score; malware (MAL-) advisories
// are always critical, and a known advisory with no parseable severity is
// treated conservatively as High rather than silently ignored.
func severityOf(v osvVuln) Severity {
	switch strings.ToUpper(v.DatabaseSpecific.Severity) {
	case "CRITICAL":
		return SevCritical
	case "HIGH":
		return SevHigh
	case "MODERATE", "MEDIUM":
		return SevMedium
	case "LOW":
		return SevLow
	}
	for _, s := range v.Severity {
		if score, err := strconv.ParseFloat(s.Score, 64); err == nil {
			return bucketCVSS(score)
		}
	}
	if strings.HasPrefix(v.ID, "MAL-") {
		return SevCritical
	}
	return SevHigh
}

func bucketCVSS(score float64) Severity {
	switch {
	case score >= 9.0:
		return SevCritical
	case score >= 7.0:
		return SevHigh
	case score >= 4.0:
		return SevMedium
	case score > 0:
		return SevLow
	default:
		return SevNone
	}
}
