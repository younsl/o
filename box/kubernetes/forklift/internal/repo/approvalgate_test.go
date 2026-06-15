package repo

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

func TestPackageExtractors(t *testing.T) {
	cases := []struct {
		fn   func(string) string
		in   string
		want string
	}{
		{npmPackage, "lodash", "lodash"},
		{npmPackage, "lodash/-/lodash-4.17.21.tgz", "lodash"},
		{npmPackage, "@scope/name", "@scope/name"},
		{npmPackage, "@scope/name/-/name-1.0.0.tgz", "@scope/name"},
		{npmPackage, "@scope%2fname", "@scope/name"},
		{pypiPackageFromFilename, "requests-2.31.0-py3-none-any.whl", "requests"},
		{pypiPackageFromFilename, "typing_extensions-4.8.0.tar.gz", "typing-extensions"},
		{pypiPackageFromFilename, "Foo.Bar-1.0.zip", "foo-bar"},
		{pypiPackageFromFilename, "requests-2.31.0-py3-none-any.whl.metadata", "requests"},
		{pypiPackageFromFilename, "noversion", ""},
		{cargoPackage, "api/v1/crates/serde/1.0.0/download", "serde"},
		{cargoPackage, "se/rd/serde", "serde"},
		{cargoPackage, "3/a/aes", "aes"},
		{cargoPackage, "1/x", "x"},
		{cargoPackage, "config.json", ""},
		{goPackage, "example.com/foo/@v/list", "example.com/foo"},
		{goPackage, "example.com/foo/@v/v1.0.0.zip", "example.com/foo"},
		{goPackage, "example.com/foo/@latest", "example.com/foo"},
		{goPackage, "example.com/foo", ""},
		{mavenPackage, "com/google/guava/guava/31.0/guava-31.0.jar", "com.google.guava:guava"},
		{mavenPackage, "com/google/guava/guava/maven-metadata.xml", "com.google.guava:guava"},
		{mavenPackage, "com/google/guava/guava/1.0-SNAPSHOT/maven-metadata.xml", "com.google.guava:guava"},
		{mavenPackage, "junit/junit/4.13/junit-4.13.jar", "junit:junit"},
		{mavenPackage, "junit/maven-metadata.xml", ""},
		{mavenPackage, "short", ""},
		{npmVersion, "lodash", ""},
		{npmVersion, "lodash/-/lodash-4.17.21.tgz", "4.17.21"},
		{npmVersion, "lodash/-/lodash-1.0.0-beta.1.tgz", "1.0.0-beta.1"},
		{npmVersion, "@scope/name/-/name-1.0.0.tgz", "1.0.0"},
		{npmVersion, "pkg/-/other-1.0.0.tgz", ""},
		{npmVersion, "pkg/-/pkg-1.0.0.bad", ""},
	}
	for _, tc := range cases {
		if got := tc.fn(tc.in); got != tc.want {
			t.Errorf("extract(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestVersionDenyGate(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "tarball-bytes")
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	// Approval workflow OFF: the deny list must still enforce.
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL, repoconfig.Default())
	h := mux(m)

	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		return rec
	}

	// Cache the tarball first, then deny it: cached copies must be revoked.
	if rec := get("/npm/npmjs/lodash/-/lodash-4.17.99.tgz"); rec.Code != http.StatusOK {
		t.Fatalf("pre-deny fetch: code=%d", rec.Code)
	}
	if _, err := store.UpsertVersionDeny(t.Context(), "npmjs", "lodash", "4.17.99", "IOC", "sec"); err != nil {
		t.Fatal(err)
	}

	rec := get("/npm/npmjs/lodash/-/lodash-4.17.99.tgz")
	if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "version denied") {
		t.Fatalf("denied version: code=%d body=%q", rec.Code, rec.Body.String())
	}
	// Other versions of the same package keep flowing.
	if rec := get("/npm/npmjs/lodash/-/lodash-4.17.21.tgz"); rec.Code != http.StatusOK {
		t.Fatalf("other version: code=%d", rec.Code)
	}
	// Metadata requests (version == "") are not blocked.
	if rec := get("/npm/npmjs/lodash"); rec.Code == http.StatusForbidden {
		t.Fatal("packument must not be blocked by a version deny")
	}

	// Un-deny: traffic resumes.
	rows, err := store.ListVersionDenies(t.Context(), "npmjs", 10, 0)
	if err != nil || len(rows) != 1 {
		t.Fatalf("denies = %d err=%v", len(rows), err)
	}
	if err := store.DeleteVersionDeny(t.Context(), rows[0].ID); err != nil {
		t.Fatal(err)
	}
	if rec := get("/npm/npmjs/lodash/-/lodash-4.17.99.tgz"); rec.Code != http.StatusOK {
		t.Fatalf("after un-deny: code=%d", rec.Code)
	}
}

func TestVersionDenyOverridesApproval(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "tarball-bytes")
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	// Audit mode never blocks on approval status; the deny must still enforce.
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL, approvalCfg(repoconfig.ModeAudit))
	h := mux(m)

	if _, err := store.UpsertApprovalDecision(t.Context(), "npmjs", "lodash", meta.ApprovalApproved, "admin", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertVersionDeny(t.Context(), "npmjs", "lodash", "4.17.99", "poisoned release", "sec"); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/npmjs/lodash/-/lodash-4.17.99.tgz", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("deny must override approval (audit mode): code=%d", rec.Code)
	}
}

// approvalCfg returns a proxy config with the approval policy enabled.
func approvalCfg(mode string, autoApprove ...string) repoconfig.Config {
	cfg := repoconfig.Default()
	cfg.Approval = repoconfig.ApprovalConfig{Enabled: true, Mode: mode, AutoApprove: autoApprove}
	return cfg
}

func TestApprovalGateEnforce(t *testing.T) {
	var upstreamHits atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits.Add(1)
		io.WriteString(w, `{"name":"left-pad","versions":{},"time":{}}`)
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL, approvalCfg(""))
	h := mux(m)

	get := func(p string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		return rec
	}

	// Unapproved: packument and tarball both 403, upstream never contacted.
	for _, p := range []string{"/npm/npmjs/left-pad", "/npm/npmjs/left-pad/-/left-pad-1.3.0.tgz"} {
		rec := get(p)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "pending approval") {
			t.Fatalf("%s: code=%d body=%q", p, rec.Code, rec.Body.String())
		}
	}
	if upstreamHits.Load() != 0 {
		t.Fatalf("upstream hit %d times for unapproved package", upstreamHits.Load())
	}

	// Repeated requests dedup into one pending row (write-suppressed).
	rows, err := store.ListApprovals(t.Context(), "npmjs", meta.ApprovalPending, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Package != "left-pad" {
		t.Fatalf("pending rows = %+v", rows)
	}

	// Approve: traffic flows.
	if err := store.DecideApproval(t.Context(), rows[0].ID, meta.ApprovalApproved, "admin", "ok"); err != nil {
		t.Fatal(err)
	}
	if rec := get("/npm/npmjs/left-pad"); rec.Code != http.StatusOK {
		t.Fatalf("approved packument: code=%d body=%q", rec.Code, rec.Body.String())
	}
	if upstreamHits.Load() == 0 {
		t.Fatal("approved package should reach upstream")
	}

	// Reject after the packument is cached: served content is revoked immediately.
	if err := store.DecideApproval(t.Context(), rows[0].ID, meta.ApprovalRejected, "admin", "incident"); err != nil {
		t.Fatal(err)
	}
	if rec := get("/npm/npmjs/left-pad"); rec.Code != http.StatusForbidden {
		t.Fatalf("rejected packument: code=%d", rec.Code)
	}
}

func TestApprovalGateAutoApproveAndHosted(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"name":"x","versions":{},"time":{}}`)
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL, approvalCfg("", "@company/*"))
	// Hosted repos are never gated even with approval enabled in config.
	mkFormatRepo(t, store, "npm-hosted", meta.FormatNPM, meta.TypeHosted, "", approvalCfg(""))
	h := mux(m)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/npmjs/@company/lib", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("auto-approved: code=%d body=%q", rec.Code, rec.Body.String())
	}
	if n, _ := store.CountApprovals(t.Context(), "npmjs", ""); n != 0 {
		t.Fatalf("auto-approve must not create approval rows, got %d", n)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/npm-hosted/anything", nil))
	if rec.Code == http.StatusForbidden {
		t.Fatal("hosted repo must not be gated")
	}
}

func TestApprovalGateAuditMode(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"name":"left-pad","versions":{},"time":{}}`)
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	mkFormatRepo(t, store, "npmjs", meta.FormatNPM, meta.TypeProxy, upstream.URL, approvalCfg(repoconfig.ModeAudit))
	h := mux(m)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/npm/npmjs/left-pad", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("audit mode must serve: code=%d", rec.Code)
	}
	// Demand is still recorded.
	if n, _ := store.CountApprovals(t.Context(), "npmjs", meta.ApprovalPending); n != 1 {
		t.Fatalf("audit mode pending rows = %d, want 1", n)
	}
}

func TestApprovalGatePyPIAndGroup(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"meta":{"api-version":"1.1"},"name":"requests","files":[]}`)
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	mkFormatRepo(t, store, "pypi-gated", meta.FormatPyPI, meta.TypeProxy, upstream.URL, approvalCfg(""))
	mkFormatRepo(t, store, "pypi-open", meta.FormatPyPI, meta.TypeProxy, upstream.URL, repoconfig.Default())
	groupCfg := repoconfig.Default()
	groupCfg.Group.Members = []string{"pypi-gated", "pypi-open"}
	mkFormatRepo(t, store, "pypi-all", meta.FormatPyPI, meta.TypeGroup, "", groupCfg)
	h := mux(m)

	// Simple index and file paths are both gated.
	for _, p := range []string{
		"/pypi/pypi-gated/simple/requests/",
		"/pypi/pypi-gated/packages/aHR0cHM6Ly9leGFtcGxlLmNvbS9m/requests-2.31.0-py3-none-any.whl",
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
		if rec.Code != http.StatusForbidden {
			t.Fatalf("%s: code=%d, want 403", p, rec.Code)
		}
	}

	// A gated member's 403 is authoritative for the group: no fall-through to
	// the open member (that would bypass the gate).
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/pypi/pypi-all/simple/requests/", nil))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("group: code=%d, want 403 (no member fall-through)", rec.Code)
	}
}
