package repo

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
	"github.com/younsl/o/box/kubernetes/forklift/internal/vuln"
)

type fakeScanner struct{}

func (fakeScanner) Query(context.Context, string, string, string) (vuln.Finding, error) {
	return vuln.Finding{}, nil
}

func (fakeScanner) Source() string { return "fake" }

func vulnCfg(action, threshold string, ignore ...string) repoconfig.Config {
	cfg := repoconfig.Default()
	cfg.Vuln = repoconfig.VulnPolicyConfig{Enabled: true, Action: action, Threshold: threshold, Ignore: ignore}
	return cfg
}

func TestVulnGate(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "tarball-bytes")
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	m.SetVulnScanner(fakeScanner{}) // activates the gate; async Query is unused here
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL, vulnCfg(repoconfig.VulnActionBlock, repoconfig.SeverityHigh))
	h := mux(m)

	tarball := "/npm/npmjs/lodash/-/lodash-4.17.99.tgz"
	get := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tarball, nil))
		return rec
	}
	ctx := t.Context()

	// Critical vuln, block action -> 403.
	if err := store.UpsertVulnScan(ctx, "npm", "lodash", "4.17.99", "critical", []string{"CVE-2026-1"}, nil, 0, nil, "OSV"); err != nil {
		t.Fatal(err)
	}
	if rec := get(); rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "known vulnerabilities") {
		t.Fatalf("blocked: code=%d body=%q", rec.Code, rec.Body.String())
	}

	// Below threshold (low < high) -> served.
	if err := store.UpsertVulnScan(ctx, "npm", "lodash", "4.17.99", "low", []string{"CVE-2026-1"}, nil, 0, nil, "OSV"); err != nil {
		t.Fatal(err)
	}
	if rec := get(); rec.Code != http.StatusOK {
		t.Fatalf("below-threshold should serve: code=%d", rec.Code)
	}
}

func TestVulnGateIgnoreAndAudit(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "tarball-bytes")
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	m.SetVulnScanner(fakeScanner{})
	ctx := t.Context()

	// Ignore list covers the only advisory -> served despite critical severity.
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL,
		vulnCfg(repoconfig.VulnActionBlock, repoconfig.SeverityHigh, "CVE-2026-1"))
	if err := store.UpsertVulnScan(ctx, "npm", "lodash", "4.17.99", "critical", []string{"CVE-2026-1"}, nil, 0, nil, "OSV"); err != nil {
		t.Fatal(err)
	}
	h := mux(m)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/npmjs/lodash/-/lodash-4.17.99.tgz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("ignored advisory should serve: code=%d", rec.Code)
	}

	// Audit mode never blocks even at/above threshold.
	mkFormatRepo(t, store, "npm-audit", meta.FormatNPM, meta.TypeProxy, upstream.URL,
		vulnCfg(repoconfig.VulnActionAudit, repoconfig.SeverityHigh))
	if err := store.UpsertVulnScan(ctx, "npm", "react", "1.0.0", "critical", []string{"CVE-2026-2"}, nil, 0, nil, "OSV"); err != nil {
		t.Fatal(err)
	}
	h = mux(m)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/npm-audit/react/-/react-1.0.0.tgz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("audit mode must serve: code=%d", rec.Code)
	}
}

func TestVulnGateBlockUnscanned(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "tarball-bytes")
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	m.SetVulnScanner(fakeScanner{})
	cfg := vulnCfg(repoconfig.VulnActionBlock, repoconfig.SeverityHigh)
	cfg.Vuln.BlockUnscanned = true
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL, cfg)
	h := mux(m)

	// No stored scan + BlockUnscanned -> 403 pending.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/npmjs/unscanned/-/unscanned-1.0.0.tgz", nil))
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "pending vulnerability scan") {
		t.Fatalf("block_unscanned: code=%d body=%q", rec.Code, rec.Body.String())
	}
}

func TestVulnGateDisabledWithoutScanner(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "tarball-bytes")
	}))
	defer upstream.Close()

	// No scanner set: even a stored critical vuln does not block (feature off).
	m, _, store := newTestManager(t)
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL, vulnCfg(repoconfig.VulnActionBlock, repoconfig.SeverityHigh))
	if err := store.UpsertVulnScan(t.Context(), "npm", "lodash", "4.17.99", "critical", []string{"CVE-2026-1"}, nil, 0, nil, "OSV"); err != nil {
		t.Fatal(err)
	}
	h := mux(m)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/npmjs/lodash/-/lodash-4.17.99.tgz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("gate must be off without a scanner: code=%d", rec.Code)
	}
}

func TestDisabledRepositoryRefusesServing(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "tarball-bytes")
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL, repoconfig.Default())
	h := mux(m)
	path := "/npm/npmjs/lodash/-/lodash-4.17.21.tgz"

	// Online: served.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("online repo: code=%d", rec.Code)
	}

	// Disabled: 503, no serving.
	repo, _ := store.GetRepositoryByName(t.Context(), "npmjs")
	if err := store.SetRepositoryDisabled(t.Context(), repo.ID, true); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("disabled repo: code=%d, want 503", rec.Code)
	}

	// Re-enabled: served again.
	if err := store.SetRepositoryDisabled(t.Context(), repo.ID, false); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("re-enabled repo: code=%d", rec.Code)
	}
}
