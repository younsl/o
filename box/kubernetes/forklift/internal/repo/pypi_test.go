package repo

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

func pypiUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, ".metadata"):
			w.Header().Set("Last-Modified", "Mon, 01 Jan 2024 00:00:00 GMT")
			io.WriteString(w, "METADATA")
		case strings.HasPrefix(r.URL.Path, "/packages/"):
			w.Header().Set("Last-Modified", "Mon, 01 Jan 2024 00:00:00 GMT")
			io.WriteString(w, "WHEEL")
		default:
			// PEP 691 simple index with one old and one fresh file.
			w.Header().Set("Content-Type", pypiJSONType)
			io.WriteString(w, `{
				"meta": {"api-version": "1.1"},
				"name": "demo",
				"versions": ["1.0.0", "2.0.0"],
				"files": [
					{"filename": "demo-1.0.0-py3-none-any.whl",
					 "url": "`+srv.URL+`/packages/aa/demo-1.0.0-py3-none-any.whl",
					 "hashes": {"sha256": "abc123"},
					 "requires-python": ">=3.8",
					 "upload-time": "2024-01-01T00:00:00Z"},
					{"filename": "demo-2.0.0-py3-none-any.whl",
					 "url": "`+srv.URL+`/packages/bb/demo-2.0.0-py3-none-any.whl",
					 "hashes": {"sha256": "def456"},
					 "upload-time": "2025-06-09T00:00:00Z"}
				]
			}`)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestPyPIProxyIndexRewriteAndAgeFilter(t *testing.T) {
	upstream := pypiUpstream(t)

	cfg := repoconfig.Default()
	cfg.AgePolicy = repoconfig.AgePolicyConfig{Enabled: true, MinAge: repoconfig.Duration(30 * 24 * time.Hour), Action: repoconfig.ActionBlock}
	m, eng, store := newTestManager(t)
	mkFormatRepo(t, store, "p", meta.FormatPyPI, meta.TypeProxy, upstream.URL+"/simple", cfg)
	eng.now = func() time.Time { return time.Date(2025, 6, 10, 0, 0, 0, 0, time.UTC) }
	h := mux(m)

	req := httptest.NewRequest(http.MethodGet, "/pypi/p/simple/demo/", nil)
	req.Header.Set("Accept", pypiJSONType)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("index = %d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != pypiJSONType {
		t.Fatalf("content type = %q", ct)
	}
	var doc struct {
		Files []struct {
			Filename string `json:"filename"`
			URL      string `json:"url"`
		} `json:"files"`
	}
	json.Unmarshal(rec.Body.Bytes(), &doc)
	if len(doc.Files) != 1 || doc.Files[0].Filename != "demo-1.0.0-py3-none-any.whl" {
		t.Fatalf("fresh file should be filtered by 30d cooldown, got %+v", doc.Files)
	}
	wantRef := base64.RawURLEncoding.EncodeToString([]byte(upstream.URL + "/packages/aa/demo-1.0.0-py3-none-any.whl"))
	if !strings.Contains(doc.Files[0].URL, "/pypi/p/packages/"+wantRef+"/demo-1.0.0-py3-none-any.whl") {
		t.Fatalf("file url not rewritten: %q", doc.Files[0].URL)
	}

	// Download through the rewritten path.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/pypi/p/packages/"+wantRef+"/demo-1.0.0-py3-none-any.whl", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "WHEEL" {
		t.Fatalf("file = %d %q", rec.Code, rec.Body.String())
	}

	// PEP 658: <file-url>.metadata resolves to the upstream metadata file.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/pypi/p/packages/"+wantRef+"/demo-1.0.0-py3-none-any.whl.metadata", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "METADATA" {
		t.Fatalf("metadata = %d %q", rec.Code, rec.Body.String())
	}

	// A bogus package reference is rejected.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/pypi/p/packages/!!!/x.whl", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("bogus ref = %d, want 400", rec.Code)
	}
}

func TestPyPIProxyIndexHTML(t *testing.T) {
	upstream := pypiUpstream(t)

	m, _, store := newTestManager(t)
	mkFormatRepo(t, store, "p", meta.FormatPyPI, meta.TypeProxy, upstream.URL+"/simple", repoconfig.Default())
	h := mux(m)

	// No PEP 691 accept header: a browser or old pip gets PEP 503 HTML.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/pypi/p/simple/demo/", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("index = %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("content type = %q", ct)
	}
	body := rec.Body.String()
	if !strings.Contains(body, ">demo-1.0.0-py3-none-any.whl</a>") ||
		!strings.Contains(body, "#sha256=abc123") ||
		!strings.Contains(body, `data-requires-python="&gt;=3.8"`) {
		t.Fatalf("html missing expected anchors:\n%s", body)
	}

	// Second request is served from the metadata cache.
	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/pypi/p/simple/demo/", nil)
	req.Header.Set("Accept", pypiJSONType)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != pypiJSONType {
		t.Fatalf("cached index = %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
}

func TestPyPILocalUploadAndIndex(t *testing.T) {
	m, _, store := newTestManager(t)
	mkFormatRepo(t, store, "internal", meta.FormatPyPI, meta.TypeHosted, "", repoconfig.Default())
	h := mux(m)

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	mw.WriteField("name", "My_Package")
	mw.WriteField("version", "1.2.3")
	fw, _ := mw.CreateFormFile("content", "my_package-1.2.3-py3-none-any.whl")
	io.WriteString(fw, "LOCAL-WHEEL")
	mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/pypi/internal", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", rec.Code, rec.Body.String())
	}

	// Index uses the PEP 503 normalized project name.
	req = httptest.NewRequest(http.MethodGet, "/pypi/internal/simple/my-package/", nil)
	req.Header.Set("Accept", pypiJSONType)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("index = %d", rec.Code)
	}
	var doc struct {
		Versions []string `json:"versions"`
		Files    []struct {
			Filename string            `json:"filename"`
			URL      string            `json:"url"`
			Hashes   map[string]string `json:"hashes"`
		} `json:"files"`
	}
	json.Unmarshal(rec.Body.Bytes(), &doc)
	if len(doc.Files) != 1 || doc.Files[0].Filename != "my_package-1.2.3-py3-none-any.whl" {
		t.Fatalf("files = %+v", doc.Files)
	}
	if doc.Files[0].Hashes["sha256"] == "" {
		t.Fatal("file should carry its sha256")
	}
	if len(doc.Versions) != 1 || doc.Versions[0] != "1.2.3" {
		t.Fatalf("versions = %v", doc.Versions)
	}
	if !strings.Contains(doc.Files[0].URL, "/pypi/internal/packages/my-package/my_package-1.2.3-py3-none-any.whl") {
		t.Fatalf("file url = %q", doc.Files[0].URL)
	}

	// Download the stored file.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/pypi/internal/packages/my-package/my_package-1.2.3-py3-none-any.whl", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "LOCAL-WHEEL" {
		t.Fatalf("download = %d %q", rec.Code, rec.Body.String())
	}

	// Unknown project 404s; upload to a proxy repo is rejected.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/pypi/internal/simple/nope/", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown project = %d", rec.Code)
	}
	mkFormatRepo(t, store, "proxyrepo", meta.FormatPyPI, meta.TypeProxy, "https://pypi.org/simple", repoconfig.Default())
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/pypi/proxyrepo", strings.NewReader("x"))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("proxy upload = %d, want 405", rec.Code)
	}
}

func TestPyPIHelpers(t *testing.T) {
	norm := map[string]string{
		"My_Package":        "my-package",
		"foo.bar--baz":      "foo-bar-baz",
		"requests":          "requests",
		"Django_REST.types": "django-rest-types",
	}
	for in, want := range norm {
		if got := normalizePyPI(in); got != want {
			t.Errorf("normalizePyPI(%q) = %q, want %q", in, got, want)
		}
	}
	versions := map[string]string{
		"demo-1.0.0-py3-none-any.whl": "1.0.0",
		"demo-2.31.0.tar.gz":          "2.31.0",
		"demo-0.1.zip":                "0.1",
		"plain.txt":                   "",
	}
	for in, want := range versions {
		if got := pypiVersion(in); got != want {
			t.Errorf("pypiVersion(%q) = %q, want %q", in, got, want)
		}
	}
}
