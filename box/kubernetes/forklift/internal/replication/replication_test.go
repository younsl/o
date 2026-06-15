package replication

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/storage"
)

const testToken = "test-replication-token"

type env struct {
	dir   string
	store *meta.Store
	blobs *storage.FSStore
}

func newEnv(t *testing.T) *env {
	t.Helper()
	dir := t.TempDir()
	store, err := meta.Open(context.Background(), filepath.Join(dir, "forklift.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	blobs, err := storage.NewFSStore(dir)
	if err != nil {
		t.Fatalf("open blobs: %v", err)
	}
	return &env{dir: dir, store: store, blobs: blobs}
}

// putBlob stores content and records the blob row so listings see it.
func (e *env) putBlob(t *testing.T, content string) string {
	t.Helper()
	ctx := context.Background()
	digest, size, err := e.blobs.Put(ctx, bytes.NewReader([]byte(content)))
	if err != nil {
		t.Fatalf("put blob: %v", err)
	}
	_, err = e.store.DB().ExecContext(ctx,
		`INSERT OR IGNORE INTO blobs(sha256, size, ref_count, created_at) VALUES(?, ?, 1, ?)`,
		digest, size, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		t.Fatalf("record blob: %v", err)
	}
	return digest
}

func (e *env) source(t *testing.T) *Source {
	t.Helper()
	return NewSource(e.store, e.blobs, testToken, e.dir, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func (e *env) serve(t *testing.T) *httptest.Server {
	t.Helper()
	r := chi.NewRouter()
	r.Mount("/internal/replication", e.source(t).Routes())
	ts := httptest.NewServer(r)
	t.Cleanup(ts.Close)
	return ts
}

func (e *env) replicator(t *testing.T, leaderURL string) *Replicator {
	t.Helper()
	return New(Options{
		Store:      e.store,
		Blobs:      e.blobs,
		DataDir:    e.dir,
		Token:      testToken,
		Interval:   10 * time.Millisecond,
		LeaderURL:  StaticLeaderURL(leaderURL),
		Log:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		Registerer: prometheus.NewRegistry(),
	})
}

func localDigests(t *testing.T, blobs *storage.FSStore) []string {
	t.Helper()
	var out []string
	if err := blobs.WalkDigests(context.Background(), func(d string) error {
		out = append(out, d)
		return nil
	}); err != nil {
		t.Fatalf("walk: %v", err)
	}
	return out
}

func TestSourceRequiresToken(t *testing.T) {
	leader := newEnv(t)
	ts := leader.serve(t)

	for _, auth := range []string{"", "Bearer wrong"} {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/internal/replication/blobs", nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("auth %q: got %d, want 401", auth, resp.StatusCode)
		}
	}

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/internal/replication/blobs", nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("got %d, want 200", resp.StatusCode)
	}
}

func TestSourceListBlobsPaging(t *testing.T) {
	leader := newEnv(t)
	want := map[string]bool{}
	for i := range 3 {
		want[leader.putBlob(t, fmt.Sprintf("content-%d", i))] = true
	}
	ts := leader.serve(t)

	var got []string
	after := ""
	for {
		req, _ := http.NewRequest(http.MethodGet,
			ts.URL+"/internal/replication/blobs?limit=2&after="+after, nil)
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var page blobPage
		if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if len(page.Digests) == 0 {
			break
		}
		got = append(got, page.Digests...)
		after = page.Digests[len(page.Digests)-1]
	}
	if len(got) != len(want) {
		t.Fatalf("got %d digests, want %d", len(got), len(want))
	}
	for i := 1; i < len(got); i++ {
		if got[i-1] >= got[i] {
			t.Fatalf("digests not strictly ordered: %v", got)
		}
	}
	for _, d := range got {
		if !want[d] {
			t.Fatalf("unexpected digest %s", d)
		}
	}
}

func TestSourceListBlobsRejectsBadLimit(t *testing.T) {
	leader := newEnv(t)
	ts := leader.serve(t)
	for _, limit := range []string{"0", "-1", "9999", "abc"} {
		req, _ := http.NewRequest(http.MethodGet,
			ts.URL+"/internal/replication/blobs?limit="+limit, nil)
		req.Header.Set("Authorization", "Bearer "+testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("limit %q: got %d, want 400", limit, resp.StatusCode)
		}
	}
}

func TestSourceGetBlobNotFound(t *testing.T) {
	leader := newEnv(t)
	ts := leader.serve(t)
	missing := "0000000000000000000000000000000000000000000000000000000000000000"
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/internal/replication/blobs/"+missing, nil)
	req.Header.Set("Authorization", "Bearer "+testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("got %d, want 404", resp.StatusCode)
	}
}

func TestSyncAndPromote(t *testing.T) {
	ctx := context.Background()
	leader := newEnv(t)
	d1 := leader.putBlob(t, "blob-one")
	d2 := leader.putBlob(t, "blob-two")
	repo, err := leader.store.CreateRepository(ctx, meta.Repository{
		Name: "npm-proxy", Format: meta.FormatNPM, Type: meta.TypeProxy,
		UpstreamURL: "https://registry.npmjs.org",
	})
	if err != nil {
		t.Fatalf("create repo: %v", err)
	}
	ts := leader.serve(t)

	standby := newEnv(t)
	extra := standby.putBlob(t, "standby-only-blob")
	rep := standby.replicator(t, ts.URL)

	if err := rep.sync(ctx); err != nil {
		t.Fatalf("sync: %v", err)
	}

	got := localDigests(t, standby.blobs)
	want := map[string]bool{d1: true, d2: true}
	if len(got) != 2 {
		t.Fatalf("standby has %d blobs %v, want 2", len(got), got)
	}
	for _, d := range got {
		if !want[d] {
			t.Fatalf("unexpected standby blob %s (extra %s should be deleted)", d, extra)
		}
	}

	// Round-trip the bytes to prove content integrity, not just presence.
	rc, _, err := standby.blobs.Open(ctx, d1)
	if err != nil {
		t.Fatalf("open synced blob: %v", err)
	}
	b, _ := io.ReadAll(rc)
	rc.Close()
	if string(b) != "blob-one" {
		t.Fatalf("synced blob content = %q", b)
	}

	// Promotion applies the replicated snapshot: the leader's repository becomes
	// visible through the standby's store handle.
	if _, err := standby.store.GetRepositoryByName(ctx, "npm-proxy"); err == nil {
		t.Fatal("standby unexpectedly has leader repo before promote")
	}
	if err := rep.Promote(ctx); err != nil {
		t.Fatalf("promote: %v", err)
	}
	promoted, err := standby.store.GetRepositoryByName(ctx, "npm-proxy")
	if err != nil {
		t.Fatalf("repo after promote: %v", err)
	}
	if promoted.ID != repo.ID {
		t.Fatalf("promoted repo ID = %d, want %d", promoted.ID, repo.ID)
	}

	// The consumed snapshot must not be re-applied on a later promotion.
	if err := rep.Promote(ctx); err != nil {
		t.Fatalf("second promote: %v", err)
	}
}

func TestPromoteWithoutSnapshotKeepsLocalData(t *testing.T) {
	ctx := context.Background()
	e := newEnv(t)
	if _, err := e.store.CreateRepository(ctx, meta.Repository{
		Name: "local-maven", Format: meta.FormatMaven, Type: meta.TypeHosted,
	}); err != nil {
		t.Fatal(err)
	}
	rep := e.replicator(t, "")
	if err := rep.Promote(ctx); err != nil {
		t.Fatalf("promote: %v", err)
	}
	if _, err := e.store.GetRepositoryByName(ctx, "local-maven"); err != nil {
		t.Fatalf("local data lost on promote: %v", err)
	}
}

// TestSyncDoesNotCommitSnapshotWhenBlobSyncFails pins the commit ordering: a
// snapshot must only become visible to Promote after the blob mirror it
// references has been pulled. Otherwise a failover right after a sync could
// serve metadata whose blobs were never fetched.
func TestSyncDoesNotCommitSnapshotWhenBlobSyncFails(t *testing.T) {
	leader := newEnv(t)
	src := leader.source(t)

	// Real /db endpoint, failing /blobs listing.
	r := chi.NewRouter()
	r.Mount("/internal/replication", src.Routes())
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/replication/blobs", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	mux.Handle("/", r)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)

	standby := newEnv(t)
	rep := standby.replicator(t, ts.URL)
	if err := rep.sync(context.Background()); err == nil {
		t.Fatal("expected sync error from failing blob listing")
	}
	if rep.snapshotPath != "" {
		t.Fatalf("snapshot committed despite failed blob sync: %q", rep.snapshotPath)
	}
	if _, err := os.Stat(filepath.Join(standby.dir, "replica", "forklift.db")); !os.IsNotExist(err) {
		t.Fatal("snapshot file should not exist after failed blob sync")
	}
	if _, err := os.Stat(filepath.Join(standby.dir, "replica", "forklift.db.tmp")); !os.IsNotExist(err) {
		t.Fatal("temp snapshot should be removed after failed blob sync")
	}
}

func TestSyncSkipsWhenLeaderUnknownOrSelf(t *testing.T) {
	e := newEnv(t)
	rep := e.replicator(t, "") // resolver returns ""
	if err := rep.sync(context.Background()); err != nil {
		t.Fatalf("sync should skip, got %v", err)
	}
	rep.isLeader.Store(true)
	if err := rep.sync(context.Background()); err != nil {
		t.Fatalf("sync as leader should skip, got %v", err)
	}
}

func TestFetchBlobDigestMismatch(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/internal/replication/blobs/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not the promised content"))
	})
	ts := httptest.NewServer(mux)
	defer ts.Close()

	e := newEnv(t)
	rep := e.replicator(t, ts.URL)
	wantDigest := "1111111111111111111111111111111111111111111111111111111111111111"
	if err := rep.fetchBlob(context.Background(), ts.URL, wantDigest); err == nil {
		t.Fatal("expected digest mismatch error")
	}
	if got := localDigests(t, e.blobs); len(got) != 0 {
		t.Fatalf("mismatched blob must not be kept: %v", got)
	}
}

func TestRunCleansStaleReplicaDir(t *testing.T) {
	e := newEnv(t)
	stale := filepath.Join(e.dir, "replica", "forklift.db")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stale, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}

	rep := e.replicator(t, "")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { rep.Run(ctx); close(done) }()
	time.Sleep(50 * time.Millisecond)
	cancel()
	<-done

	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("stale replica snapshot should be removed at startup")
	}
}

func TestLeaseLeaderURL(t *testing.T) {
	ctx := context.Background()
	resolve := LeaseLeaderURL(fakeHolder{id: "forklift-0"}, "forklift-1", "forklift-headless.tools.svc", 8080)
	u, err := resolve(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if u != "http://forklift-0.forklift-headless.tools.svc:8080" {
		t.Fatalf("url = %q", u)
	}

	// Self holds the lease: no leader to pull from.
	resolve = LeaseLeaderURL(fakeHolder{id: "forklift-1"}, "forklift-1", "svc", 8080)
	if u, _ := resolve(ctx); u != "" {
		t.Fatalf("self leader should resolve to empty, got %q", u)
	}

	// No holder yet.
	resolve = LeaseLeaderURL(fakeHolder{}, "forklift-1", "svc", 8080)
	if u, _ := resolve(ctx); u != "" {
		t.Fatalf("no holder should resolve to empty, got %q", u)
	}
}

type fakeHolder struct{ id string }

func (f fakeHolder) LeaderIdentity(context.Context) (string, error) { return f.id, nil }
