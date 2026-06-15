package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExtractClaims(t *testing.T) {
	o := &OIDCProvider{usernameClaim: "preferred_username", groupsClaim: "groups"}
	user, email, groups, err := o.extractClaims(map[string]any{
		"preferred_username": "alice",
		"email":              "alice@example.com",
		"groups":             []any{"devs", "platform", 42},
	})
	if err != nil {
		t.Fatal(err)
	}
	if user != "alice" || email != "alice@example.com" {
		t.Fatalf("user=%q email=%q", user, email)
	}
	if len(groups) != 2 || groups[0] != "devs" {
		t.Fatalf("groups = %v", groups)
	}

	if _, _, _, err := o.extractClaims(map[string]any{"email": "x"}); err == nil {
		t.Fatal("missing username should error")
	}
}

func TestOIDCHandlersDisabled(t *testing.T) {
	svc, _ := newTestService(t) // no OIDC provider
	rec := httptest.NewRecorder()
	svc.HandleLogin(rec, httptest.NewRequest(http.MethodGet, "/auth/login", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("login without oidc = %d, want 404", rec.Code)
	}
	rec = httptest.NewRecorder()
	svc.HandleCallback(rec, httptest.NewRequest(http.MethodGet, "/auth/callback", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("callback without oidc = %d, want 404", rec.Code)
	}
}

func TestRandomStateAndSecure(t *testing.T) {
	if a, b := randomState(), randomState(); a == b || len(a) != 32 {
		t.Fatalf("randomState weak: %q %q", a, b)
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	if isSecure(r) {
		t.Fatal("plain http should not be secure")
	}
	r.Header.Set("X-Forwarded-Proto", "https")
	if !isSecure(r) {
		t.Fatal("forwarded https should be secure")
	}
}

func TestServiceFlags(t *testing.T) {
	svc, _ := newTestService(t)
	if svc.OIDCEnabled() {
		t.Fatal("OIDC should be disabled")
	}
	if svc.AnonymousRead() {
		t.Fatal("anonymous read should default off")
	}
}
