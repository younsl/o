// Package api implements the JSON management REST API: repositories, and (from
// Phase 3) users, roles, group mappings and personal access tokens.
package api

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/version"
)

// Handler serves the management API.
type Handler struct {
	store  *meta.Store
	authz  *auth.Service
	log    *slog.Logger
	client *http.Client
	rec    *audit.Recorder
}

// New creates an API handler. authz may be nil in tests that exercise only
// public endpoints and rec may be nil to disable audit logging, but production
// wiring always provides both.
func New(store *meta.Store, authz *auth.Service, log *slog.Logger, rec *audit.Recorder) *Handler {
	return &Handler{
		store:  store,
		authz:  authz,
		log:    log,
		client: &http.Client{Timeout: 5 * time.Second},
		rec:    rec,
	}
}

// audit records a repository lifecycle event performed through the management
// API, attributed to the authenticated principal.
func (h *Handler) audit(r *http.Request, repoName, event string, status int) {
	var username string
	if p := auth.FromContext(r.Context()); p != nil {
		username = p.Username
	}
	h.rec.Record(audit.Event{
		Repo:      repoName,
		Action:    event,
		Username:  username,
		Method:    r.Method,
		Status:    status,
		ClientIP:  audit.ClientIP(r),
		UserAgent: r.UserAgent(),
	})
}

// Routes returns a router mounted under /api/v1. The auth.Service middleware is
// applied by the caller, so a principal (if any) is already in the context.
func (h *Handler) Routes() chi.Router {
	r := chi.NewRouter()

	// Public.
	r.Post("/login", h.login)
	r.Post("/logout", h.logout)
	r.Get("/me", h.me)
	r.Get("/version", h.version)

	// Authenticated self-service: personal access tokens.
	r.Group(func(r chi.Router) {
		if h.authz != nil {
			r.Use(h.authz.RequireAuth)
		}
		r.Get("/tokens", h.listTokens)
		r.Post("/tokens", h.createToken)
		r.Delete("/tokens/{id}", h.deleteToken)
		// Names only, for token-scope autocomplete.
		r.Get("/repository-names", h.listRepositoryNames)
		// Repository listing and read-only detail (config + artifact browse) are
		// available to any authenticated user; the handlers filter to repositories
		// the principal can read. Mutations, audit logs and remote-health stay
		// admin-only (below). Mirrors Nexus browse/read vs admin privileges.
		r.Get("/repositories", h.listRepositories)
		r.Get("/repositories/{id}", h.getRepository)
		r.Get("/repositories/{id}/artifacts", h.listArtifacts)
	})

	// Package approvals: administrators plus principals holding the approve
	// action (e.g. a security-engineer role). The queue is shared; decisions
	// are enforced per repository inside the handlers.
	r.Group(func(r chi.Router) {
		if h.authz != nil {
			r.Use(h.authz.RequireApprover)
		}
		r.Route("/approvals", func(r chi.Router) {
			r.Get("/", h.listApprovals)
			r.Get("/count", h.countApprovals)
			r.Get("/{id}", h.getApproval)
			r.Post("/", h.createApproval)
			r.Post("/approve-all", h.approveAllPending)
			r.Post("/{id}/approve", h.approveApproval)
			r.Post("/{id}/reject", h.rejectApproval)
		})
		r.Route("/version-denies", func(r chi.Router) {
			r.Get("/", h.listVersionDenies)
			r.Post("/", h.createVersionDeny)
			r.Delete("/{id}", h.deleteVersionDeny)
		})
	})

	// Administrative reads: administrators plus principals holding the audit
	// action (e.g. a security auditor). Read-only views of the admin surfaces.
	r.Group(func(r chi.Router) {
		if h.authz != nil {
			r.Use(h.authz.RequireAuditor)
		}
		r.Get("/repositories/{id}/upstream-health", h.upstreamHealth)
		r.Get("/repositories/{id}/audit-logs", h.listAuditLogs)
		r.Get("/repositories/{id}/permissions", h.repositoryPermissions)
		r.Get("/repositories/{id}/tokens", h.repositoryTokens)
		r.Get("/users", h.listUsers)
		r.Get("/users/{id}/tokens", h.listUserTokens)
		r.Get("/roles", h.listRoles)
		r.Get("/group-mappings", h.listGroupMappings)
	})

	// Administrative mutations: administrators only. Same paths as the reads
	// above are registered here per-method, so chi applies the admin middleware
	// to the mutating verbs while reads stay under RequireAuditor.
	r.Group(func(r chi.Router) {
		if h.authz != nil {
			r.Use(h.authz.RequireAdmin)
		}
		r.Post("/repositories", h.createRepository)
		r.Post("/repositories/check-upstream", h.checkUpstream)
		r.Put("/repositories/{id}", h.updateRepository)
		r.Post("/repositories/{id}/disabled", h.setRepositoryDisabled)
		r.Delete("/repositories/{id}", h.deleteRepository)
		r.Delete("/repositories/{id}/artifacts", h.deleteArtifact)
		r.Post("/users", h.createUser)
		r.Put("/users/{id}", h.updateUser)
		r.Delete("/users/{id}", h.deleteUser)
		r.Post("/users/{id}/roles", h.assignRole)
		r.Delete("/users/{id}/roles/{roleID}", h.removeRole)
		r.Post("/users/{id}/tokens", h.createUserToken)
		r.Delete("/users/{id}/tokens/{tokenID}", h.deleteUserToken)
		r.Post("/roles", h.createRole)
		r.Delete("/roles/{id}", h.deleteRole)
		r.Post("/roles/{id}/permissions", h.addPermission)
		r.Delete("/roles/{id}/permissions/{permID}", h.deletePermission)
		r.Post("/group-mappings", h.createGroupMapping)
		r.Delete("/group-mappings/{id}", h.deleteGroupMapping)
	})

	return r
}

// version reports the build-time version metadata so the web UI can show it in
// the sidebar. Public: it leaks nothing sensitive and aids support triage.
func (h *Handler) version(w http.ResponseWriter, _ *http.Request) {
	// oidc_enabled drives the login page: the "Sign in with Keycloak" button is
	// hidden when OIDC is not configured (its /auth/login route is unregistered).
	writeJSON(w, http.StatusOK, map[string]any{
		"version":      version.Version,
		"commit":       version.Commit,
		"oidc_enabled": h.authz != nil && h.authz.OIDCEnabled(),
	})
}

// validName accepts the identifier charset shared by every "name" input
// (repository, token, role, user names): ASCII letters, digits, '-' and '_',
// at most 64 characters. Descriptions and notes stay free-form.
func validName(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, c := range name {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
		default:
			return false
		}
	}
	return true
}

const nameRuleMsg = "may only contain letters, digits, '-' and '_' (max 64 chars)"

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// mapError translates store errors into HTTP responses.
func mapError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, meta.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	default:
		writeError(w, http.StatusInternalServerError, err.Error())
	}
}
