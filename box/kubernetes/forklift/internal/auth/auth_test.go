package auth

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

func TestGlobMatch(t *testing.T) {
	cases := []struct {
		pattern, name string
		want          bool
	}{
		{"*", "anything", true},
		{"maven-*", "maven-central", true},
		{"maven-*", "npm-proxy", false},
		{"*-proxy", "npm-proxy", true},
		{"exact", "exact", true},
		{"exact", "other", false},
		{"a*c", "abc", true},
		{"a*c", "ac", true},
		{"a*c", "abd", false},
	}
	for _, c := range cases {
		if got := matchGlob(c.pattern, c.name); got != c.want {
			t.Errorf("matchGlob(%q,%q) = %v, want %v", c.pattern, c.name, got, c.want)
		}
	}
	// Empty name only matches "*".
	if matchGlob("foo", "") {
		t.Error("empty name should not match non-wildcard pattern")
	}
}

func TestPrincipalCan(t *testing.T) {
	p := &Principal{perms: []meta.Permission{
		{RepoPattern: "maven-*", Actions: "read,write"},
		{RepoPattern: "shared", Actions: "read"},
	}}
	if !p.Can("maven-central", ActionRead) || !p.Can("maven-central", ActionWrite) {
		t.Error("expected read/write on maven-central")
	}
	if p.Can("maven-central", ActionDelete) {
		t.Error("delete should be denied")
	}
	if !p.Can("shared", ActionRead) || p.Can("shared", ActionWrite) {
		t.Error("shared should be read-only")
	}
	if p.Can("npm-proxy", ActionRead) {
		t.Error("npm-proxy not granted")
	}
}

func TestPrincipalAdminImpliesAll(t *testing.T) {
	p := &Principal{perms: []meta.Permission{{RepoPattern: "*", Actions: "admin"}}}
	if !p.IsAdmin() || !p.Can("anything", ActionDelete) {
		t.Error("admin should imply all actions")
	}
}

func TestPrincipalTokenScopeNarrows(t *testing.T) {
	base := []meta.Permission{{RepoPattern: "*", Actions: "admin"}}
	// Unscoped token inherits full access.
	full := &Principal{perms: base, viaToken: true}
	if !full.Can("any", ActionWrite) {
		t.Error("unscoped token should inherit role perms")
	}
	// Scoped token narrows to a single repo/action.
	scoped := &Principal{perms: base, viaToken: true, tokenScopes: []Scope{
		{RepoPattern: "maven-*", Actions: []string{ActionRead}},
	}}
	if !scoped.Can("maven-central", ActionRead) {
		t.Error("scoped read should be allowed")
	}
	if scoped.Can("maven-central", ActionWrite) || scoped.Can("npm", ActionRead) {
		t.Error("scope should narrow access")
	}
}

func TestPasswordAndToken(t *testing.T) {
	hash, err := HashPassword("s3cret")
	if err != nil {
		t.Fatal(err)
	}
	if !VerifyPassword(hash, "s3cret") || VerifyPassword(hash, "wrong") {
		t.Fatal("password verification broken")
	}

	plain, h, err := GenerateToken()
	if err != nil {
		t.Fatal(err)
	}
	if !IsPAT(plain) {
		t.Fatalf("generated token has no PAT prefix: %s", plain)
	}
	if HashToken(plain) != h {
		t.Fatal("token hash mismatch")
	}
	if IsPAT("not-a-token") {
		t.Fatal("arbitrary string should not be a PAT")
	}
}

func TestSessionCodec(t *testing.T) {
	c := NewSessionCodec([]byte("secret"), time.Hour)
	base := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	c.now = func() time.Time { return base }

	val, err := c.Encode("alice", "local", []string{"devs"})
	if err != nil {
		t.Fatal(err)
	}
	d, err := c.Decode(val)
	if err != nil || d.Username != "alice" || len(d.Groups) != 1 {
		t.Fatalf("decode = %+v err=%v", d, err)
	}

	// Tampering breaks the signature.
	if _, err := c.Decode(val + "x"); err == nil {
		t.Error("tampered session should fail")
	}
	// Expired session is rejected.
	c.now = func() time.Time { return base.Add(2 * time.Hour) }
	if _, err := c.Decode(val); err == nil {
		t.Error("expired session should fail")
	}
}

func newTestService(t *testing.T) (*Service, *meta.Store) {
	t.Helper()
	store, err := meta.Open(context.Background(), filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	svc := NewService(store, slog.New(slog.NewTextHandler(io.Discard, nil)), Options{
		SessionSecret: []byte("test-secret-test-secret-test-secret"),
	})
	return svc, store
}

func TestBootstrapAndLocalAuth(t *testing.T) {
	svc, store := newTestService(t)
	ctx := context.Background()

	if err := svc.BootstrapAdmin(ctx, "admin", "pw"); err != nil {
		t.Fatal(err)
	}
	// Idempotent: second call is a no-op.
	if err := svc.BootstrapAdmin(ctx, "admin", "pw"); err != nil {
		t.Fatal(err)
	}
	if n, _ := store.CountUsers(ctx); n != 1 {
		t.Fatalf("user count = %d, want 1", n)
	}

	if _, err := svc.AuthenticateLocal(ctx, "admin", "pw"); err != nil {
		t.Fatalf("admin login failed: %v", err)
	}
	if _, err := svc.AuthenticateLocal(ctx, "admin", "bad"); err == nil {
		t.Fatal("bad password should fail")
	}
}

func TestAccountLockout(t *testing.T) {
	store, err := meta.Open(context.Background(), filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	svc := NewService(store, slog.New(slog.NewTextHandler(io.Discard, nil)), Options{
		SessionSecret:      []byte("test-secret-test-secret-test-secret"),
		BootstrapAdminUser: "admin",
	})
	ctx := context.Background()

	hash, _ := HashPassword("pw")
	u, err := store.CreateUser(ctx, meta.User{Username: "alice", PasswordHash: hash, Source: meta.SourceLocal})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLockoutEnabled(ctx, u.ID, true); err != nil {
		t.Fatal(err)
	}

	// MaxFailedLogins-1 failures must not lock yet.
	for i := 0; i < MaxFailedLogins-1; i++ {
		if _, err := svc.AuthenticateLocal(ctx, "alice", "bad"); !errors.Is(err, ErrInvalidCredential) {
			t.Fatalf("attempt %d: err = %v, want invalid credential", i, err)
		}
	}
	// A correct password before the threshold still works and resets the count.
	if _, err := svc.AuthenticateLocal(ctx, "alice", "pw"); err != nil {
		t.Fatalf("login before lock should succeed: %v", err)
	}

	// Now fail the full threshold to lock the account.
	for i := 0; i < MaxFailedLogins; i++ {
		_, _ = svc.AuthenticateLocal(ctx, "alice", "bad")
	}
	if _, err := svc.AuthenticateLocal(ctx, "alice", "pw"); !errors.Is(err, ErrAccountLocked) {
		t.Fatalf("locked account: err = %v, want ErrAccountLocked", err)
	}

	// Admin unlock restores access.
	if err := store.ResetFailedLogin(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.AuthenticateLocal(ctx, "alice", "pw"); err != nil {
		t.Fatalf("after unlock: %v", err)
	}

	// The protected bootstrap admin never locks, even with lockout enabled.
	adminHash, _ := HashPassword("pw")
	admin, err := store.CreateUser(ctx, meta.User{Username: "admin", PasswordHash: adminHash, Source: meta.SourceLocal})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLockoutEnabled(ctx, admin.ID, true); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < MaxFailedLogins+3; i++ {
		_, _ = svc.AuthenticateLocal(ctx, "admin", "bad")
	}
	if _, err := svc.AuthenticateLocal(ctx, "admin", "pw"); err != nil {
		t.Fatalf("protected admin must never lock: %v", err)
	}
}

func TestBootstrapGeneratesRandomPassword(t *testing.T) {
	svc, store := newTestService(t)
	ctx := context.Background()

	// Empty password on an empty DB seeds an admin with a generated password.
	if err := svc.BootstrapAdmin(ctx, "", ""); err != nil {
		t.Fatal(err)
	}
	n, _ := store.CountUsers(ctx)
	if n != 1 {
		t.Fatalf("user count = %d, want 1 (admin auto-created)", n)
	}
	u, err := store.GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatalf("admin not created: %v", err)
	}
	if u.PasswordHash == "" {
		t.Fatal("generated admin should have a password hash")
	}
	// Idempotent: a second call does not create another user.
	if err := svc.BootstrapAdmin(ctx, "", ""); err != nil {
		t.Fatal(err)
	}
	if n, _ := store.CountUsers(ctx); n != 1 {
		t.Fatalf("count after re-bootstrap = %d, want 1", n)
	}
}

func TestRandomPasswordUnique(t *testing.T) {
	a, err := RandomPassword()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := RandomPassword()
	if a == b || len(a) < 16 {
		t.Fatalf("weak random password: %q %q", a, b)
	}
}

func TestResolveBasicAndToken(t *testing.T) {
	svc, store := newTestService(t)
	ctx := context.Background()
	if err := svc.BootstrapAdmin(ctx, "admin", "pw"); err != nil {
		t.Fatal(err)
	}

	// Basic auth resolves an admin principal.
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.SetBasicAuth("admin", "pw")
	p, err := svc.Resolve(ctx, r)
	if err != nil || p == nil || !p.IsAdmin() {
		t.Fatalf("basic resolve: p=%v err=%v", p, err)
	}

	// Create a scoped PAT for the admin and resolve via Bearer.
	admin, _ := store.GetUserByUsername(ctx, "admin")
	plain, hash, _ := GenerateToken()
	if _, err := store.CreateToken(ctx, meta.Token{
		UserID: admin.ID, Name: "ci", Hash: hash,
		ScopesJSON: `[{"repo_pattern":"maven-*","actions":["read"]}]`,
	}); err != nil {
		t.Fatal(err)
	}
	r = httptest.NewRequest(http.MethodGet, "/", nil)
	r.Header.Set("Authorization", "Bearer "+plain)
	p, err = svc.Resolve(ctx, r)
	if err != nil || p == nil {
		t.Fatalf("token resolve: p=%v err=%v", p, err)
	}
	if !p.Can("maven-central", ActionRead) || p.Can("maven-central", ActionWrite) {
		t.Fatal("token scope not enforced")
	}

	// Anonymous request resolves to nil.
	if p, _ := svc.Resolve(ctx, httptest.NewRequest(http.MethodGet, "/", nil)); p != nil {
		t.Fatal("expected anonymous principal")
	}
}

func TestRBACGroupMapping(t *testing.T) {
	svc, store := newTestService(t)
	ctx := context.Background()

	role, _ := store.CreateRole(ctx, meta.Role{Name: "maven-writers"})
	store.AddPermission(ctx, meta.Permission{RoleID: role.ID, RepoPattern: "maven-*", Actions: "read,write"})
	store.CreateGroupMapping(ctx, "team-platform", role.ID)
	u, _ := store.CreateUser(ctx, meta.User{Username: "bob", Source: meta.SourceOIDC})

	p, err := svc.buildPrincipal(ctx, u, []string{"team-platform"}, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !p.Can("maven-snapshots", ActionWrite) {
		t.Fatal("group-mapped role should grant write")
	}
	if p.Can("npm-proxy", ActionRead) {
		t.Fatal("unmapped repo should be denied")
	}
}

func TestMiddlewareInjectsPrincipal(t *testing.T) {
	svc, _ := newTestService(t)
	ctx := context.Background()
	svc.BootstrapAdmin(ctx, "admin", "pw")

	var got *Principal
	h := svc.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = FromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.SetBasicAuth("admin", "pw")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if got == nil || got.Username != "admin" {
		t.Fatalf("principal not injected: %v", got)
	}
}

func TestRequireAdmin(t *testing.T) {
	svc, store := newTestService(t)
	ctx := context.Background()
	svc.BootstrapAdmin(ctx, "admin", "pw")
	// Non-admin user.
	hash, _ := HashPassword("pw")
	store.CreateUser(ctx, meta.User{Username: "plain", PasswordHash: hash, Source: meta.SourceLocal})

	guard := svc.Middleware(svc.RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})))

	// Admin allowed.
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.SetBasicAuth("admin", "pw")
	rec := httptest.NewRecorder()
	guard.ServeHTTP(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin = %d", rec.Code)
	}

	// Non-admin forbidden.
	r = httptest.NewRequest(http.MethodGet, "/", nil)
	r.SetBasicAuth("plain", "pw")
	rec = httptest.NewRecorder()
	guard.ServeHTTP(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin = %d, want 403", rec.Code)
	}

	// Anonymous unauthorized.
	rec = httptest.NewRecorder()
	guard.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anon = %d, want 401", rec.Code)
	}
}

func TestUnauthorizedChallengeHeaders(t *testing.T) {
	// UI API 401s must not carry a Basic challenge: browsers would pop the
	// native credential dialog and cache credentials, bypassing logout.
	rec := httptest.NewRecorder()
	Unauthorized(rec)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("Unauthorized = %d, want 401", rec.Code)
	}
	if h := rec.Header().Get("WWW-Authenticate"); h != "" {
		t.Fatalf("Unauthorized WWW-Authenticate = %q, want empty", h)
	}

	// Package-manager 401s keep the challenge so clients send credentials.
	rec = httptest.NewRecorder()
	UnauthorizedBasic(rec)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("UnauthorizedBasic = %d, want 401", rec.Code)
	}
	if h := rec.Header().Get("WWW-Authenticate"); h != `Basic realm="forklift"` {
		t.Fatalf("UnauthorizedBasic WWW-Authenticate = %q", h)
	}
}
