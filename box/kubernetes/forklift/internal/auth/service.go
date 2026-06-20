package auth

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// Options configures the auth Service.
type Options struct {
	SessionSecret []byte
	SessionTTL    time.Duration
	AnonymousRead bool
	OIDC          *OIDCProvider // optional
	// DefaultRole, when set, grants its permissions to every authenticated
	// principal regardless of explicit role assignments (ArgoCD policy.default).
	DefaultRole string
	// BootstrapAdminUser names the seeded admin account, which is exempt from
	// failed-password lockout so an operator can never lock themselves out of
	// the only guaranteed admin.
	BootstrapAdminUser string
}

// Service authenticates requests and resolves effective permissions.
type Service struct {
	store          *meta.Store
	log            *slog.Logger
	codec          *SessionCodec
	oidc           *OIDCProvider
	anonymousRead  bool
	defaultRole    string
	bootstrapAdmin string
}

// NewService builds a Service. If SessionSecret is empty, an ephemeral random
// secret is generated (suitable for single-instance only).
func NewService(store *meta.Store, log *slog.Logger, opts Options) *Service {
	secret := opts.SessionSecret
	if len(secret) == 0 {
		secret = make([]byte, 32)
		_, _ = rand.Read(secret)
		log.Warn("FORKLIFT_SESSION_SECRET not set; using ephemeral secret (sessions will not survive restart or work across replicas)")
	}
	ttl := opts.SessionTTL
	if ttl <= 0 {
		ttl = 12 * time.Hour
	}
	return &Service{
		store:          store,
		log:            log,
		codec:          NewSessionCodec(secret, ttl),
		oidc:           opts.OIDC,
		anonymousRead:  opts.AnonymousRead,
		defaultRole:    opts.DefaultRole,
		bootstrapAdmin: opts.BootstrapAdminUser,
	}
}

// IsProtectedAdmin reports whether username is the seeded bootstrap admin, which
// is exempt from failed-password lockout.
func (s *Service) IsProtectedAdmin(username string) bool {
	return s.bootstrapAdmin != "" && username == s.bootstrapAdmin
}

// AnonymousRead reports whether unauthenticated reads are allowed.
func (s *Service) AnonymousRead() bool { return s.anonymousRead }

// OIDCEnabled reports whether OIDC login is available.
func (s *Service) OIDCEnabled() bool { return s.oidc != nil }

// AuthenticateLocal verifies a username/password against a local user. When the
// account opted into lockout, consecutive password failures are counted and the
// account is refused once locked (even with the right password) until an admin
// unlocks it; a success clears the count. The bootstrap admin is never locked.
func (s *Service) AuthenticateLocal(ctx context.Context, username, password string) (meta.User, error) {
	u, err := s.store.GetUserByUsername(ctx, username)
	if err != nil {
		return meta.User{}, ErrInvalidCredential
	}
	if u.Disabled || u.Source != meta.SourceLocal || u.PasswordHash == "" {
		return meta.User{}, ErrInvalidCredential
	}
	protected := s.IsProtectedAdmin(u.Username)
	if u.Locked() && !protected {
		return meta.User{}, ErrAccountLocked
	}
	if !VerifyPassword(u.PasswordHash, password) {
		if !protected {
			if err := s.store.RegisterFailedLogin(ctx, u.ID, MaxFailedLogins); err != nil {
				s.log.Warn("record failed login", "user", u.Username, "err", err)
			}
		}
		return meta.User{}, ErrInvalidCredential
	}
	// Success: clear any accumulated failures (write only when there is state to
	// clear, so steady-state Basic-auth requests stay read-only).
	if u.FailedLoginCount > 0 || u.Locked() {
		if err := s.store.ResetFailedLogin(ctx, u.ID); err != nil {
			s.log.Warn("reset failed login", "user", u.Username, "err", err)
		}
	}
	return u, nil
}

// IssueSession encodes a signed session cookie value for a user.
func (s *Service) IssueSession(username, source string, groups []string) (string, error) {
	return s.codec.Encode(username, source, groups)
}

// Resolve identifies the principal for a request, or nil for anonymous. It tries
// the session cookie, then the Authorization header (PAT or local Basic, and an
// OIDC bearer token if configured).
func (s *Service) Resolve(ctx context.Context, r *http.Request) (*Principal, error) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		if data, err := s.codec.Decode(c.Value); err == nil {
			return s.principalFromSession(ctx, data)
		}
	}

	authz := r.Header.Get("Authorization")
	switch {
	case strings.HasPrefix(authz, "Bearer "):
		tok := strings.TrimPrefix(authz, "Bearer ")
		if IsPAT(tok) {
			return s.principalFromToken(ctx, tok)
		}
		if s.oidc != nil {
			return s.principalFromBearerJWT(ctx, tok)
		}
	case strings.HasPrefix(authz, "Basic "):
		user, pass, ok := r.BasicAuth()
		if !ok {
			return nil, nil
		}
		switch {
		case IsPAT(pass):
			return s.principalFromToken(ctx, pass)
		case IsPAT(user):
			return s.principalFromToken(ctx, user)
		default:
			return s.principalFromPassword(ctx, user, pass)
		}
	}
	return nil, nil
}

func (s *Service) principalFromSession(ctx context.Context, d sessionData) (*Principal, error) {
	u, err := s.store.GetUserByUsername(ctx, d.Username)
	if err != nil {
		return nil, nil
	}
	if u.Disabled {
		return nil, nil
	}
	return s.buildPrincipal(ctx, u, d.Groups, false, nil)
}

func (s *Service) principalFromPassword(ctx context.Context, username, password string) (*Principal, error) {
	u, err := s.AuthenticateLocal(ctx, username, password)
	if err != nil {
		return nil, nil
	}
	return s.buildPrincipal(ctx, u, nil, false, nil)
}

func (s *Service) principalFromToken(ctx context.Context, plaintext string) (*Principal, error) {
	t, err := s.store.GetTokenByHash(ctx, HashToken(plaintext))
	if err != nil {
		return nil, nil
	}
	if t.ExpiresAt != nil && time.Now().After(*t.ExpiresAt) {
		return nil, nil
	}
	u, err := s.store.GetUser(ctx, t.UserID)
	if err != nil || u.Disabled {
		return nil, nil
	}
	var scopes []Scope
	if t.ScopesJSON != "" {
		_ = json.Unmarshal([]byte(t.ScopesJSON), &scopes)
	}
	_ = s.store.TouchToken(ctx, t.ID)
	return s.buildPrincipal(ctx, u, nil, true, scopes)
}

func (s *Service) principalFromBearerJWT(ctx context.Context, raw string) (*Principal, error) {
	username, _, groups, err := s.oidc.Verify(ctx, raw)
	if err != nil {
		return nil, nil
	}
	u, err := s.store.GetUserByUsername(ctx, username)
	if err != nil {
		// Unknown identity presenting a valid token: treat as anonymous until a
		// login flow records the user.
		return nil, nil
	}
	return s.buildPrincipal(ctx, u, groups, false, nil)
}

// buildPrincipal resolves the effective permissions for a user, combining
// directly-assigned roles with OIDC group-mapped roles.
func (s *Service) buildPrincipal(ctx context.Context, u meta.User, groups []string, viaToken bool, scopes []Scope) (*Principal, error) {
	perms, err := s.store.PermissionsForUser(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	if len(groups) > 0 {
		names, err := s.store.RoleNamesForGroups(ctx, groups)
		if err != nil {
			return nil, err
		}
		groupPerms, err := s.store.PermissionsForRoleNames(ctx, names)
		if err != nil {
			return nil, err
		}
		perms = append(perms, groupPerms...)
	}
	// Every authenticated principal inherits the default role's permissions, if
	// one is configured (e.g. read-only access for all signed-in users).
	if s.defaultRole != "" {
		defPerms, err := s.store.PermissionsForRoleNames(ctx, []string{s.defaultRole})
		if err != nil {
			return nil, err
		}
		perms = append(perms, defPerms...)
	}
	return &Principal{
		Username:    u.Username,
		Source:      u.Source,
		perms:       perms,
		viaToken:    viaToken,
		tokenScopes: scopes,
	}, nil
}

// ApproversFor lists the usernames of enabled users who may approve packages on
// repo, computed from each user's persisted roles (directly assigned plus any
// synced from OIDC groups) and the default role, using the same Can check the
// API enforces. OIDC group approvers who have never signed in are not persisted
// and so are not enumerable here.
func (s *Service) ApproversFor(ctx context.Context, repo string) ([]string, error) {
	users, err := s.store.ListUsers(ctx)
	if err != nil {
		return nil, err
	}
	out := []string{}
	for _, u := range users {
		if u.Disabled {
			continue
		}
		p, err := s.buildPrincipal(ctx, u, nil, false, nil)
		if err != nil {
			return nil, err
		}
		if p.Can(repo, ActionApprove) {
			out = append(out, u.Username)
		}
	}
	return out, nil
}

// BootstrapAdmin seeds an initial admin user and role on first run when no users
// exist yet. It is idempotent and a no-op once any user is present. When no
// password is supplied, a random one is generated and logged once so the
// operator can sign in and rotate it.
func (s *Service) BootstrapAdmin(ctx context.Context, username, password string) error {
	if username == "" {
		username = "admin"
	}
	n, err := s.store.CountUsers(ctx)
	if err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	generated := password == ""
	if generated {
		password, err = RandomPassword()
		if err != nil {
			return err
		}
	}
	hash, err := HashPassword(password)
	if err != nil {
		return err
	}
	u, err := s.store.CreateUser(ctx, meta.User{Username: username, PasswordHash: hash, Source: meta.SourceLocal})
	if err != nil {
		// Another replica won the bootstrap race; treat as already done.
		if strings.Contains(err.Error(), "UNIQUE") {
			return nil
		}
		return err
	}
	role, err := s.store.GetRoleByName(ctx, "administrator")
	if errors.Is(err, meta.ErrNotFound) {
		role, err = s.store.CreateRole(ctx, meta.Role{Name: "administrator", Description: "Full administrative access"})
		if err != nil {
			return err
		}
		if _, err := s.store.AddPermission(ctx, meta.Permission{RoleID: role.ID, RepoPattern: "*", Actions: ActionAdmin}); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	if err := s.store.AssignRole(ctx, u.ID, role.ID); err != nil {
		return err
	}
	if generated {
		s.log.Warn("generated initial admin password; sign in and rotate it",
			"username", username, "password", password)
	} else {
		s.log.Info("bootstrapped admin user", "username", username)
	}
	return nil
}
