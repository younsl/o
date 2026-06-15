package repo

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
	"github.com/younsl/o/box/kubernetes/forklift/internal/storage"
)

func newTestManager(t *testing.T) (*Manager, *Engine, *meta.Store) {
	t.Helper()
	store, err := meta.Open(context.Background(), filepath.Join(t.TempDir(), "repo.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	blobs, err := storage.NewFSStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	eng := NewEngine(store, blobs, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	return NewManager(eng, store, nil, nil, nil), eng, store
}

func mux(m *Manager) http.Handler {
	r := chi.NewRouter()
	m.Register(r)
	return r
}

func mkRepo(t *testing.T, store *meta.Store, name, typ, upstream string, cfg repoconfig.Config) meta.Repository {
	t.Helper()
	j, err := cfg.JSON()
	if err != nil {
		t.Fatal(err)
	}
	repo, err := store.CreateRepository(context.Background(), meta.Repository{
		Name: name, Format: meta.FormatMaven, Type: typ, UpstreamURL: upstream, ConfigJSON: j,
	})
	if err != nil {
		t.Fatalf("create repo: %v", err)
	}
	return repo
}

func TestMavenLocalRoundTrip(t *testing.T) {
	m, _, store := newTestManager(t)
	mkRepo(t, store, "mvn-local", meta.TypeHosted, "", repoconfig.Default())
	h := mux(m)
	path := "/maven/mvn-local/com/example/app/1.0/app-1.0.jar"

	// Upload.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, path, strings.NewReader("JARBYTES")))
	if rec.Code != http.StatusCreated {
		t.Fatalf("put = %d", rec.Code)
	}

	// Download.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "JARBYTES" {
		t.Fatalf("get = %d body=%q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/java-archive" {
		t.Fatalf("content-type = %q", ct)
	}

	// HEAD returns headers, no body.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, path, nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("head = %d bodylen=%d", rec.Code, rec.Body.Len())
	}
	if rec.Header().Get("Content-Length") != "8" {
		t.Fatalf("content-length = %q", rec.Header().Get("Content-Length"))
	}
}

func TestMavenLocalMissing(t *testing.T) {
	m, _, store := newTestManager(t)
	mkRepo(t, store, "mvn-local", meta.TypeHosted, "", repoconfig.Default())
	rec := httptest.NewRecorder()
	mux(m).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/mvn-local/x/y/1/y-1.jar", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing = %d, want 404", rec.Code)
	}
}

func TestMavenProxyCaching(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.Header().Set("Last-Modified", time.Now().UTC().Add(-365*24*time.Hour).Format(http.TimeFormat))
		_, _ = io.WriteString(w, "UPSTREAM-JAR")
	}))
	defer upstream.Close()

	m, eng, store := newTestManager(t)
	mkRepo(t, store, "mvn-proxy", meta.TypeProxy, upstream.URL, repoconfig.Default())
	h := mux(m)
	path := "/maven/mvn-proxy/g/a/1.0/a-1.0.jar"

	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK || rec.Body.String() != "UPSTREAM-JAR" {
			t.Fatalf("iter %d: code=%d body=%q", i, rec.Code, rec.Body.String())
		}
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("upstream hits = %d, want 1 (artifact cached)", got)
	}
	_ = eng
}

func TestMavenProxyCacheDisabledPassthrough(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		_, _ = io.WriteString(w, "X")
	}))
	defer upstream.Close()

	cfg := repoconfig.Default()
	cfg.Cache.Enabled = false
	m, _, store := newTestManager(t)
	mkRepo(t, store, "p", meta.TypeProxy, upstream.URL, cfg)
	h := mux(m)
	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/p/g/a/1/a-1.jar", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("code = %d", rec.Code)
		}
	}
	if got := atomic.LoadInt32(&hits); got != 2 {
		t.Fatalf("passthrough hits = %d, want 2", got)
	}
}

func TestMavenProxyNegativeCache(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		http.NotFound(w, r)
	}))
	defer upstream.Close()

	m, _, store := newTestManager(t)
	mkRepo(t, store, "p", meta.TypeProxy, upstream.URL, repoconfig.Default())
	h := mux(m)
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/p/g/a/1/missing.jar", nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("iter %d code=%d", i, rec.Code)
		}
	}
	if got := atomic.LoadInt32(&hits); got != 1 {
		t.Fatalf("upstream 404 hits = %d, want 1 (negative cached)", got)
	}
}

func TestMavenProxyAgePolicyBlocks(t *testing.T) {
	publishTime := time.Date(2025, 6, 1, 0, 0, 0, 0, time.UTC)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Last-Modified", publishTime.Format(http.TimeFormat))
		_, _ = io.WriteString(w, "FRESH")
	}))
	defer upstream.Close()

	cfg := repoconfig.Default()
	cfg.AgePolicy = repoconfig.AgePolicyConfig{
		Enabled: true, MinAge: repoconfig.Duration(30 * 24 * time.Hour), Action: repoconfig.ActionBlock,
	}
	m, eng, store := newTestManager(t)
	mkRepo(t, store, "p", meta.TypeProxy, upstream.URL, cfg)
	h := mux(m)

	// "Now" is 10 days after publish: younger than the 30-day cooldown -> blocked.
	eng.now = func() time.Time { return publishTime.Add(10 * 24 * time.Hour) }
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/p/g/a/2.0/a-2.0.jar", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("within cooldown code = %d, want 404", rec.Code)
	}

	// 60 days after publish: past the cooldown -> allowed.
	eng.now = func() time.Time { return publishTime.Add(60 * 24 * time.Hour) }
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/p/g/a/3.0/a-3.0.jar", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "FRESH" {
		t.Fatalf("past cooldown code = %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestResolveErrors(t *testing.T) {
	m, _, store := newTestManager(t)
	mkRepo(t, store, "mvn-local", meta.TypeHosted, "", repoconfig.Default())
	h := mux(m)

	// Unknown repository.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/nope/a/b/1/x.jar", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("unknown repo = %d", rec.Code)
	}

	// Path traversal attempt.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/mvn-local/../../etc/passwd", nil))
	if rec.Code == http.StatusOK {
		t.Fatalf("traversal should not succeed, got %d", rec.Code)
	}

	// Upload to a proxy repo is rejected.
	mkRepo(t, store, "mvn-proxy", meta.TypeProxy, "https://example.com", repoconfig.Default())
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, "/maven/mvn-proxy/g/a/1/a-1.jar", strings.NewReader("x")))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("proxy put = %d, want 405", rec.Code)
	}
}
