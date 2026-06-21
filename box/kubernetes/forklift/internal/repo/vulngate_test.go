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

// recordingScanner records the coordinates it is queried for and returns a
// clean finding, so a test can assert which artifacts the backfill scanned.
type recordingScanner struct{ calls [][3]string }

func (s *recordingScanner) Query(_ context.Context, eco, pkg, ver string) (vuln.Finding, error) {
	s.calls = append(s.calls, [3]string{eco, pkg, ver})
	return vuln.Finding{}, nil
}
func (s *recordingScanner) Source() string { return "rec" }

// TestVulnBackfillScansStoredArtifacts verifies the backfill enqueues scans for
// already-stored artifacts that have never been scanned, and skips ones that
// already have a stored scan.
func TestVulnBackfillScansStoredArtifacts(t *testing.T) {
	m, _, store := newTestManager(t)
	rec := &recordingScanner{}
	m.SetVulnScanner(rec)
	ctx := t.Context()

	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, "http://upstream.invalid", repoconfig.Default())
	repo, err := store.GetRepositoryByName(ctx, "npmjs")
	if err != nil {
		t.Fatal(err)
	}
	put := func(path, version string) {
		t.Helper()
		if _, err := store.PutArtifact(ctx, meta.Artifact{
			RepoID: repo.ID, Path: path, Version: version, BlobSHA256: path, Size: 4,
		}); err != nil {
			t.Fatal(err)
		}
	}
	// Two stored artifacts; "react" is already scanned, "lodash" is not.
	put("lodash/-/lodash-4.17.99.tgz", "4.17.99")
	put("react/-/react-18.0.0.tgz", "18.0.0")
	if err := store.UpsertVulnScan(ctx, "npm", "react", "18.0.0", "none", nil, nil, 0, nil, "OSV"); err != nil {
		t.Fatal(err)
	}

	m.backfillOnce(ctx)

	// Drain the queue synchronously so the assertions don't race the worker.
	for {
		select {
		case job := <-m.scanQueue:
			m.runScan(ctx, job)
			continue
		default:
		}
		break
	}

	// Only the unscanned coordinate was queried, and its scan is now stored.
	if len(rec.calls) != 1 || rec.calls[0] != [3]string{"npm", "lodash", "4.17.99"} {
		t.Fatalf("backfill scanned %v, want only [npm lodash 4.17.99]", rec.calls)
	}
	if _, err := store.GetVulnScan(ctx, "npm", "lodash", "4.17.99"); err != nil {
		t.Fatalf("lodash scan not stored: %v", err)
	}
}

// TestHostedUploadTriggersScan verifies that publishing to a hosted repository
// enqueues an immediate vulnerability scan for the uploaded coordinate.
func TestHostedUploadTriggersScan(t *testing.T) {
	m, _, store := newTestManager(t)
	rec := &recordingScanner{}
	m.SetVulnScanner(rec)
	mkFormatRepo(t, store, "mvn", meta.FormatMaven, meta.TypeHosted, "", repoconfig.Default())
	h := mux(m)
	ctx := t.Context()

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPut,
		"/maven/mvn/com/example/app/1.2.3/app-1.2.3.jar", strings.NewReader("JARDATA")))
	if w.Code != http.StatusCreated {
		t.Fatalf("upload code=%d", w.Code)
	}

	// Drain the queue synchronously so the assertion doesn't race the worker.
	for {
		select {
		case job := <-m.scanQueue:
			m.runScan(ctx, job)
			continue
		default:
		}
		break
	}
	if len(rec.calls) != 1 || rec.calls[0] != [3]string{"Maven", "com.example:app", "1.2.3"} {
		t.Fatalf("scan calls = %v, want [[Maven com.example:app 1.2.3]]", rec.calls)
	}
	if _, err := store.GetVulnScan(ctx, "Maven", "com.example:app", "1.2.3"); err != nil {
		t.Fatalf("scan not stored: %v", err)
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
