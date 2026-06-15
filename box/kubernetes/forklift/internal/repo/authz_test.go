package repo

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// newAuthzManager wires a Manager with a real auth.Service so the RBAC path in
// authorize() is exercised end to end.
func newAuthzManager(t *testing.T, anonymousRead bool) (*Manager, *meta.Store, *auth.Service) {
	t.Helper()
	m, eng, store := newTestManager(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	svc := auth.NewService(store, log, auth.Options{
		SessionSecret: []byte("test-secret-test-secret-test-secret"),
		AnonymousRead: anonymousRead,
	})
	if err := svc.BootstrapAdmin(context.Background(), "admin", "adminpw"); err != nil {
		t.Fatal(err)
	}
	m.authz = svc
	_ = eng
	return m, store, svc
}

// authzMux mounts the manager behind the auth middleware, mirroring main.go.
func authzMux(m *Manager, svc *auth.Service) http.Handler {
	return svc.Middleware(mux(m))
}

// grantRole creates a user with one role granting actions on pattern.
func grantRole(t *testing.T, store *meta.Store, username, password, pattern, actions string) {
	t.Helper()
	ctx := context.Background()
	hash, err := auth.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	u, err := store.CreateUser(ctx, meta.User{Username: username, PasswordHash: hash, Source: meta.SourceLocal})
	if err != nil {
		t.Fatal(err)
	}
	role, err := store.CreateRole(ctx, meta.Role{Name: username + "-role"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddPermission(ctx, meta.Permission{RoleID: role.ID, RepoPattern: pattern, Actions: actions}); err != nil {
		t.Fatal(err)
	}
	if err := store.AssignRole(ctx, u.ID, role.ID); err != nil {
		t.Fatal(err)
	}
}

func doAuthz(h http.Handler, method, path, user, pass, body string) *httptest.ResponseRecorder {
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	if user != "" {
		req.SetBasicAuth(user, pass)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestAuthorizeRBACMatrix(t *testing.T) {
	m, store, svc := newAuthzManager(t, false)
	mkRepo(t, store, "mvn-hosted", meta.TypeHosted, "", repoconfig.Default())
	grantRole(t, store, "reader", "readerpw", "mvn-*", "read")
	h := authzMux(m, svc)
	path := "/maven/mvn-hosted/com/acme/a/1.0/a-1.0.jar"

	// Anonymous is rejected with a Basic challenge when anonymous read is off.
	rec := doAuthz(h, http.MethodGet, path, "", "", "")
	if rec.Code != http.StatusUnauthorized || rec.Header().Get("WWW-Authenticate") == "" {
		t.Fatalf("anonymous get = %d challenge=%q", rec.Code, rec.Header().Get("WWW-Authenticate"))
	}

	// Admin can write; the reader cannot.
	if rec := doAuthz(h, http.MethodPut, path, "admin", "adminpw", "JAR"); rec.Code != http.StatusCreated {
		t.Fatalf("admin put = %d", rec.Code)
	}
	if rec := doAuthz(h, http.MethodPut, path, "reader", "readerpw", "JAR"); rec.Code != http.StatusForbidden {
		t.Fatalf("reader put = %d, want 403", rec.Code)
	}

	// The reader can read; a repo outside their pattern is forbidden.
	if rec := doAuthz(h, http.MethodGet, path, "reader", "readerpw", ""); rec.Code != http.StatusOK {
		t.Fatalf("reader get = %d", rec.Code)
	}
	mkRepo(t, store, "other", meta.TypeHosted, "", repoconfig.Default())
	if rec := doAuthz(h, http.MethodGet, "/maven/other/x.jar", "reader", "readerpw", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("reader get other = %d, want 403", rec.Code)
	}
}

func TestAuthorizeAnonymousRead(t *testing.T) {
	m, store, svc := newAuthzManager(t, true)
	mkRepo(t, store, "mvn-hosted", meta.TypeHosted, "", repoconfig.Default())
	h := authzMux(m, svc)
	path := "/maven/mvn-hosted/com/acme/a/1.0/a-1.0.jar"

	if rec := doAuthz(h, http.MethodPut, path, "admin", "adminpw", "JAR"); rec.Code != http.StatusCreated {
		t.Fatalf("seed put = %d", rec.Code)
	}
	// Anonymous read is allowed, anonymous write is not.
	if rec := doAuthz(h, http.MethodGet, path, "", "", ""); rec.Code != http.StatusOK {
		t.Fatalf("anonymous get = %d, want 200", rec.Code)
	}
	if rec := doAuthz(h, http.MethodPut, path, "", "", "JAR"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous put = %d, want 401", rec.Code)
	}
}

func TestGroupAuthorizationBypassesMembers(t *testing.T) {
	m, store, svc := newAuthzManager(t, false)
	mkRepo(t, store, "mvn-hosted", meta.TypeHosted, "", repoconfig.Default())
	mkGroup(t, store, "mvn-public", "mvn-hosted")
	// The reader may only access the group, not the member.
	grantRole(t, store, "reader", "readerpw", "mvn-public", "read")
	h := authzMux(m, svc)

	if rec := doAuthz(h, http.MethodPut, "/maven/mvn-hosted/a/b/1.0/b-1.0.jar", "admin", "adminpw", "JAR"); rec.Code != http.StatusCreated {
		t.Fatalf("seed put = %d", rec.Code)
	}

	// Direct member access is forbidden, but the same artifact is readable
	// through the group (member authorization is bypassed via the group grant).
	if rec := doAuthz(h, http.MethodGet, "/maven/mvn-hosted/a/b/1.0/b-1.0.jar", "reader", "readerpw", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("direct member get = %d, want 403", rec.Code)
	}
	if rec := doAuthz(h, http.MethodGet, "/maven/mvn-public/a/b/1.0/b-1.0.jar", "reader", "readerpw", ""); rec.Code != http.StatusOK {
		t.Fatalf("group get = %d, want 200", rec.Code)
	}
	// Group write is rejected before member fan-out.
	if rec := doAuthz(h, http.MethodPut, "/maven/mvn-public/a/b/1.0/b-1.0.jar", "admin", "adminpw", "X"); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("group put = %d, want 405", rec.Code)
	}
}

func TestSweeperReclaimsUnreferencedBlobs(t *testing.T) {
	m, eng, store := newTestManager(t)
	repo := mkRepo(t, store, "mvn-hosted", meta.TypeHosted, "", repoconfig.Default())
	h := mux(m)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut,
		"/maven/mvn-hosted/a/b/1.0/b-1.0.jar", strings.NewReader("BYTES")))
	if rec.Code != http.StatusCreated {
		t.Fatalf("put = %d", rec.Code)
	}
	ctx := context.Background()
	art, err := store.GetArtifact(ctx, repo.ID, "a/b/1.0/b-1.0.jar")
	if err != nil {
		t.Fatal(err)
	}

	// Deleting the repository drops the blob refcount to zero; the sweeper
	// must reclaim both the bytes and the record.
	if err := store.DeleteRepository(ctx, repo.ID); err != nil {
		t.Fatal(err)
	}
	eng.sweepOnce(ctx)

	if _, _, err := eng.blobs.Open(ctx, art.BlobSHA256); err == nil {
		t.Fatal("blob bytes not reclaimed")
	}
	if _, err := store.GetBlob(ctx, art.BlobSHA256); err == nil {
		t.Fatal("blob record not deleted")
	}

	// RunSweeper ticks until its context is cancelled.
	runCtx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() { eng.RunSweeper(runCtx, 10*time.Millisecond); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("RunSweeper did not stop on cancel")
	}

	// Accessor used by main.go.
	if m.Engine() != eng {
		t.Fatal("Engine() accessor mismatch")
	}
}

func TestMaybeEvictTrimsToCap(t *testing.T) {
	_, eng, store := newTestManager(t)
	cfg := repoconfig.Default()
	cfg.Cache.MaxSizeBytes = 8 // tiny cap: a single artifact fits, two do not
	repo := mkRepo(t, store, "mvn-proxy", meta.TypeProxy, "https://upstream.example.com", cfg)
	ctx := context.Background()

	put := func(path, body string) {
		t.Helper()
		if err := eng.put(ctx, repo, path, "", "application/java-archive", nil, strings.NewReader(body)); err != nil {
			t.Fatal(err)
		}
	}
	put("a/1.jar", "AAAAAAA")
	put("b/2.jar", "BBBBBBB")

	eng.maybeEvict(ctx, fetchSpec{repo: repo, cfg: cfg})
	size, err := store.RepoSize(ctx, repo.ID)
	if err != nil {
		t.Fatal(err)
	}
	if size > cfg.Cache.MaxSizeBytes {
		t.Fatalf("size after evict = %d, want <= %d", size, cfg.Cache.MaxSizeBytes)
	}

	// A cap of zero disables eviction.
	uncapped := repoconfig.Default()
	eng.maybeEvict(ctx, fetchSpec{repo: repo, cfg: uncapped})
}
