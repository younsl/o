package auth

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/oauth2"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// mkLocalUser creates an enabled local user with the given password.
func mkLocalUser(t *testing.T, store *meta.Store, username, password string) meta.User {
	t.Helper()
	hash, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	u, err := store.CreateUser(context.Background(), meta.User{
		Username: username, PasswordHash: hash, Source: meta.SourceLocal,
	})
	if err != nil {
		t.Fatal(err)
	}
	return u
}

// sessionRequest builds a request carrying a session cookie issued by svc,
// exercising SetSessionCookie on the way.
func sessionRequest(t *testing.T, svc *Service, username, source string, groups []string) *http.Request {
	t.Helper()
	val, err := svc.IssueSession(username, source, groups)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	SetSessionCookie(rec, val, true)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	for _, c := range rec.Result().Cookies() {
		req.AddCookie(c)
	}
	return req
}

func TestSessionCookieResolve(t *testing.T) {
	svc, store := newTestService(t)
	u := mkLocalUser(t, store, "alice", "pw123456")

	p, err := svc.Resolve(context.Background(), sessionRequest(t, svc, "alice", meta.SourceLocal, nil))
	if err != nil || p == nil || p.Username != "alice" || p.Source != meta.SourceLocal {
		t.Fatalf("resolve = %+v err=%v", p, err)
	}

	// A disabled user's session no longer resolves.
	if err := store.SetUserDisabled(context.Background(), u.ID, true); err != nil {
		t.Fatal(err)
	}
	if p, _ := svc.Resolve(context.Background(), sessionRequest(t, svc, "alice", meta.SourceLocal, nil)); p != nil {
		t.Fatalf("disabled user resolved: %+v", p)
	}

	// A session naming an unknown user resolves to anonymous.
	if p, _ := svc.Resolve(context.Background(), sessionRequest(t, svc, "ghost", meta.SourceLocal, nil)); p != nil {
		t.Fatalf("unknown user resolved: %+v", p)
	}

	// A tampered cookie value is ignored.
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: "forklift_session", Value: "garbage"})
	if p, _ := svc.Resolve(context.Background(), req); p != nil {
		t.Fatalf("tampered cookie resolved: %+v", p)
	}
}

func TestSessionGroupsGrantMappedRoles(t *testing.T) {
	svc, store := newTestService(t)
	mkLocalUser(t, store, "dev", "pw123456")
	ctx := context.Background()

	role, err := store.CreateRole(ctx, meta.Role{Name: "readers"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddPermission(ctx, meta.Permission{RoleID: role.ID, RepoPattern: "*", Actions: "read"}); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateGroupMapping(ctx, "team-x", role.ID); err != nil {
		t.Fatal(err)
	}

	// Without groups the user has no permissions; with the mapped group the
	// session grants read.
	p, _ := svc.Resolve(ctx, sessionRequest(t, svc, "dev", meta.SourceOIDC, nil))
	if p == nil || p.Can("any-repo", ActionRead) {
		t.Fatalf("groupless session should have no perms: %+v", p)
	}
	p, _ = svc.Resolve(ctx, sessionRequest(t, svc, "dev", meta.SourceOIDC, []string{"team-x"}))
	if p == nil || !p.Can("any-repo", ActionRead) {
		t.Fatalf("group-mapped session should read: %+v", p)
	}
}

func TestRequireAuthMiddleware(t *testing.T) {
	svc, store := newTestService(t)
	mkLocalUser(t, store, "alice", "pw123456")

	ok := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	h := svc.Middleware(svc.RequireAuth(ok))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous = %d, want 401", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, sessionRequest(t, svc, "alice", meta.SourceLocal, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("session = %d, want 200", rec.Code)
	}
}

func TestHandleLogoutClearsCookie(t *testing.T) {
	svc, _ := newTestService(t)
	rec := httptest.NewRecorder()
	svc.HandleLogout(rec, httptest.NewRequest(http.MethodPost, "/auth/logout", nil))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout = %d", rec.Code)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "forklift_session" || cookies[0].MaxAge >= 0 {
		t.Fatalf("cookie not cleared: %+v", cookies)
	}
}

func TestOIDCHandlersNotConfigured(t *testing.T) {
	svc, _ := newTestService(t)
	rec := httptest.NewRecorder()
	svc.HandleLogin(rec, httptest.NewRequest(http.MethodGet, "/auth/login", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("login without oidc = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	svc.HandleCallback(rec, httptest.NewRequest(http.MethodGet, "/auth/callback", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("callback without oidc = %d", rec.Code)
	}
}

// oidcTestService builds a Service with a hand-constructed provider whose token
// endpoint points at url, bypassing issuer discovery.
func oidcTestService(t *testing.T, store *meta.Store, tokenURL string) *Service {
	t.Helper()
	provider := &OIDCProvider{
		oauth: oauth2.Config{
			ClientID:    "forklift",
			RedirectURL: "https://forklift.example.com/auth/callback",
			Endpoint: oauth2.Endpoint{
				AuthURL:  "https://idp.example.com/auth",
				TokenURL: tokenURL,
			},
		},
		usernameClaim: "preferred_username",
		groupsClaim:   "groups",
	}
	return NewService(store, slog.New(slog.NewTextHandler(io.Discard, nil)), Options{
		SessionSecret: []byte("test-secret-test-secret-test-secret"),
		OIDC:          provider,
	})
}

func TestHandleLoginRedirectsToIDP(t *testing.T) {
	_, store := newTestService(t)
	svc := oidcTestService(t, store, "https://idp.example.com/token")

	rec := httptest.NewRecorder()
	svc.HandleLogin(rec, httptest.NewRequest(http.MethodGet, "/auth/login", nil))
	if rec.Code != http.StatusFound {
		t.Fatalf("login = %d, want 302", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://idp.example.com/auth") || !strings.Contains(loc, "state=") {
		t.Fatalf("redirect = %q", loc)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "forklift_oidc_state" || cookies[0].Value == "" {
		t.Fatalf("state cookie missing: %+v", cookies)
	}
}

func TestHandleCallbackStateAndExchange(t *testing.T) {
	// Token endpoint that returns a token without an id_token.
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer"})
	}))
	defer idp.Close()

	_, store := newTestService(t)
	svc := oidcTestService(t, store, idp.URL+"/token")

	// Missing state cookie -> 400.
	rec := httptest.NewRecorder()
	svc.HandleCallback(rec, httptest.NewRequest(http.MethodGet, "/auth/callback?state=x&code=c", nil))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("missing state cookie = %d, want 400", rec.Code)
	}

	// State mismatch -> 400.
	req := httptest.NewRequest(http.MethodGet, "/auth/callback?state=other&code=c", nil)
	req.AddCookie(&http.Cookie{Name: "forklift_oidc_state", Value: "expected"})
	rec = httptest.NewRecorder()
	svc.HandleCallback(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("state mismatch = %d, want 400", rec.Code)
	}

	// Valid state but the exchange yields no id_token -> 502.
	req = httptest.NewRequest(http.MethodGet, "/auth/callback?state=s1&code=c", nil)
	req.AddCookie(&http.Cookie{Name: "forklift_oidc_state", Value: "s1"})
	rec = httptest.NewRecorder()
	svc.HandleCallback(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("no id_token = %d, want 502", rec.Code)
	}

	// Exchange failure (token endpoint errors) -> 502.
	idpDown := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer idpDown.Close()
	svc = oidcTestService(t, store, idpDown.URL+"/token")
	req = httptest.NewRequest(http.MethodGet, "/auth/callback?state=s1&code=c", nil)
	req.AddCookie(&http.Cookie{Name: "forklift_oidc_state", Value: "s1"})
	rec = httptest.NewRecorder()
	svc.HandleCallback(rec, req)
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("exchange failure = %d, want 502", rec.Code)
	}
}

func TestNewOIDCDiscovery(t *testing.T) {
	// Minimal OIDC discovery document; the issuer must match the server URL.
	var issuer string
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                 issuer,
			"authorization_endpoint": issuer + "/auth",
			"token_endpoint":         issuer + "/token",
			"jwks_uri":               issuer + "/keys",
		})
	}))
	defer idp.Close()
	issuer = idp.URL

	p, err := NewOIDC(context.Background(), OIDCParams{IssuerURL: issuer, ClientID: "forklift"})
	if err != nil {
		t.Fatalf("NewOIDC: %v", err)
	}
	if p.usernameClaim != "preferred_username" || p.groupsClaim != "groups" {
		t.Fatalf("claim defaults not applied: %+v", p)
	}

	// A malformed token fails verification (error path of Verify).
	if _, _, _, err := p.Verify(context.Background(), "not-a-jwt"); err == nil {
		t.Fatal("garbage token verified")
	}

	// Unreachable issuer fails discovery.
	if _, err := NewOIDC(context.Background(), OIDCParams{IssuerURL: "http://127.0.0.1:1/nope"}); err == nil {
		t.Fatal("expected discovery error")
	}
}
