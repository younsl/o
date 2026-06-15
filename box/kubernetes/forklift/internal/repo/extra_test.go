package repo

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// Mutable metadata is revalidated once its TTL elapses, unlike immutable
// artifacts which are served from cache indefinitely.
func TestMavenMetadataRevalidation(t *testing.T) {
	var hits int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&hits, 1)
		_, _ = io.WriteString(w, "<metadata/>")
	}))
	defer upstream.Close()

	cfg := repoconfig.Default()
	cfg.Cache.MetadataTTL = repoconfig.Duration(time.Minute)
	m, eng, store := newTestManager(t)
	mkRepo(t, store, "p", meta.TypeProxy, upstream.URL, cfg)
	h := mux(m)
	path := "/maven/p/g/a/maven-metadata.xml"

	base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	eng.now = func() time.Time { return base }

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("first = %d", rec.Code)
	}
	// Within TTL: served from cache.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if atomic.LoadInt32(&hits) != 1 {
		t.Fatalf("within ttl hits = %d, want 1", hits)
	}
	// Past TTL: revalidated upstream.
	eng.now = func() time.Time { return base.Add(2 * time.Minute) }
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	if atomic.LoadInt32(&hits) != 2 {
		t.Fatalf("past ttl hits = %d, want 2", hits)
	}
}

func TestMavenMethodNotAllowed(t *testing.T) {
	m, _, store := newTestManager(t)
	mkRepo(t, store, "mvn-local", meta.TypeHosted, "", repoconfig.Default())
	rec := httptest.NewRecorder()
	mux(m).ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/maven/mvn-local/g/a/1/a-1.jar", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("delete = %d, want 405", rec.Code)
	}
}

func TestProxyHeadFromCache(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "BODY")
	}))
	defer upstream.Close()
	m, _, store := newTestManager(t)
	mkRepo(t, store, "p", meta.TypeProxy, upstream.URL, repoconfig.Default())
	h := mux(m)
	path := "/maven/p/g/a/1/a-1.jar"

	// Prime the cache.
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
	// HEAD from cache returns headers, no body.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, path, nil))
	if rec.Code != http.StatusOK || rec.Body.Len() != 0 {
		t.Fatalf("head = %d bodylen=%d", rec.Code, rec.Body.Len())
	}
}

// Hosted repositories are authoritative: a stored artifact must be served
// regardless of cache freshness (TTL) or caching being disabled.
func TestLocalServesRegardlessOfFreshness(t *testing.T) {
	m, eng, store := newTestManager(t)
	// Cache disabled, which would make fresh() return false for proxy.
	cfg := repoconfig.Default()
	cfg.Cache.Enabled = false
	mkRepo(t, store, "loc", meta.TypeHosted, "", cfg)
	h := mux(m)

	put := httptest.NewRequest(http.MethodPut, "/maven/loc/g/a/1/a-1.jar", strings.NewReader("LOCALJAR"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, put)
	if rec.Code != http.StatusCreated {
		t.Fatalf("put = %d", rec.Code)
	}

	// Advance well past any metadata TTL; local must still serve.
	eng.now = func() time.Time { return time.Now().Add(1000 * time.Hour) }
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/loc/g/a/1/a-1.jar", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "LOCALJAR" {
		t.Fatalf("local get = %d body=%q (regression: local 404 on stale/disabled cache)", rec.Code, rec.Body.String())
	}

	// Local metadata (maven-metadata.xml) must also persist beyond TTL.
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPut, "/maven/loc/g/a/maven-metadata.xml", strings.NewReader("<m/>")))
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/loc/g/a/maven-metadata.xml", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "<m/>" {
		t.Fatalf("local metadata get = %d body=%q", rec.Code, rec.Body.String())
	}
}
