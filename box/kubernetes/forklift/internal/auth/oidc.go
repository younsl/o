package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// OIDCParams configures the OIDC provider (decoupled from the config package).
type OIDCParams struct {
	IssuerURL     string
	ClientID      string
	ClientSecret  string
	RedirectURL   string
	UsernameClaim string
	GroupsClaim   string
}

// OIDCProvider verifies OIDC tokens and drives the Authorization Code flow
// against Keycloak (or any compliant provider).
type OIDCProvider struct {
	verifier      *oidc.IDTokenVerifier
	oauth         oauth2.Config
	usernameClaim string
	groupsClaim   string
}

// NewOIDC discovers the provider and builds the verifier and OAuth2 config. It
// requires network access to the issuer at startup.
func NewOIDC(ctx context.Context, p OIDCParams) (*OIDCProvider, error) {
	provider, err := oidc.NewProvider(ctx, p.IssuerURL)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	if p.UsernameClaim == "" {
		p.UsernameClaim = "preferred_username"
	}
	if p.GroupsClaim == "" {
		p.GroupsClaim = "groups"
	}
	return &OIDCProvider{
		verifier: provider.Verifier(&oidc.Config{ClientID: p.ClientID}),
		oauth: oauth2.Config{
			ClientID:     p.ClientID,
			ClientSecret: p.ClientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  p.RedirectURL,
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		},
		usernameClaim: p.UsernameClaim,
		groupsClaim:   p.GroupsClaim,
	}, nil
}

// Verify validates a raw ID token and extracts identity claims.
func (o *OIDCProvider) Verify(ctx context.Context, rawIDToken string) (username, email string, groups []string, err error) {
	idToken, err := o.verifier.Verify(ctx, rawIDToken)
	if err != nil {
		return "", "", nil, err
	}
	var claims map[string]any
	if err := idToken.Claims(&claims); err != nil {
		return "", "", nil, err
	}
	return o.extractClaims(claims)
}

func (o *OIDCProvider) extractClaims(claims map[string]any) (string, string, []string, error) {
	username, _ := claims[o.usernameClaim].(string)
	if username == "" {
		return "", "", nil, fmt.Errorf("missing username claim %q", o.usernameClaim)
	}
	email, _ := claims["email"].(string)
	var groups []string
	if raw, ok := claims[o.groupsClaim].([]any); ok {
		for _, g := range raw {
			if gs, ok := g.(string); ok {
				groups = append(groups, gs)
			}
		}
	}
	return username, email, groups, nil
}

const oidcStateCookie = "forklift_oidc_state"

// HandleLogin starts the Authorization Code flow.
func (s *Service) HandleLogin(w http.ResponseWriter, r *http.Request) {
	if s.oidc == nil {
		http.Error(w, "oidc not configured", http.StatusNotFound)
		return
	}
	state := randomState()
	http.SetCookie(w, &http.Cookie{
		Name: oidcStateCookie, Value: state, Path: "/", HttpOnly: true,
		Secure: isSecure(r), SameSite: http.SameSiteLaxMode, MaxAge: 300,
	})
	http.Redirect(w, r, s.oidc.oauth.AuthCodeURL(state), http.StatusFound)
}

// HandleCallback completes the flow: it verifies state, exchanges the code,
// upserts the OIDC user, and issues a session cookie.
func (s *Service) HandleCallback(w http.ResponseWriter, r *http.Request) {
	if s.oidc == nil {
		http.Error(w, "oidc not configured", http.StatusNotFound)
		return
	}
	stateCookie, err := r.Cookie(oidcStateCookie)
	if err != nil || stateCookie.Value == "" || stateCookie.Value != r.URL.Query().Get("state") {
		http.Error(w, "invalid oauth state", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	token, err := s.oidc.oauth.Exchange(ctx, r.URL.Query().Get("code"))
	if err != nil {
		http.Error(w, "token exchange failed", http.StatusBadGateway)
		return
	}
	rawID, ok := token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "no id_token in response", http.StatusBadGateway)
		return
	}
	username, email, groups, err := s.oidc.Verify(ctx, rawID)
	if err != nil {
		http.Error(w, "id token verification failed", http.StatusUnauthorized)
		return
	}
	u, err := s.store.EnsureUser(ctx, username, email, sourceOIDC)
	if err != nil {
		http.Error(w, "user provisioning failed", http.StatusInternalServerError)
		return
	}
	// Materialize the user's group-mapped forklift roles so the assignment is
	// durable and visible in the UI, syncing on every login to track the
	// identity provider's current group membership. Best-effort: effective
	// permissions are also resolved dynamically from the session groups, so a
	// sync failure must not block the login.
	if err := s.store.SyncOIDCGroupRoles(ctx, u.ID, groups); err != nil {
		s.log.Warn("sync oidc group roles", "user", u.Username, "err", err)
	}
	// Best-effort: a bookkeeping failure must not block the login.
	if err := s.store.TouchLastLogin(ctx, u.ID); err != nil {
		s.log.Warn("record last login", "user", u.Username, "err", err)
	}
	value, err := s.IssueSession(username, sourceOIDC, groups)
	if err != nil {
		http.Error(w, "session issue failed", http.StatusInternalServerError)
		return
	}
	SetSessionCookie(w, value, isSecure(r))
	http.Redirect(w, r, "/", http.StatusFound)
}

// HandleLogout clears the session cookie.
func (s *Service) HandleLogout(w http.ResponseWriter, r *http.Request) {
	ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

const sourceOIDC = "oidc"

func randomState() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func isSecure(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}
