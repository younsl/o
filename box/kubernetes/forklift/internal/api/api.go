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

	// Authenticated self-service: personal access tokens.
	r.Group(func(r chi.Router) {
		if h.authz != nil {
			r.Use(h.authz.RequireAuth)
		}
		r.Get("/tokens", h.listTokens)
		r.Post("/tokens", h.createToken)
		r.Delete("/tokens/{id}", h.deleteToken)
		// Names only, for token-scope autocomplete (the full list is admin-only).
		r.Get("/repository-names", h.listRepositoryNames)
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
			r.Post("/", h.createApproval)
			r.Post("/{id}/approve", h.approveApproval)
			r.Post("/{id}/reject", h.rejectApproval)
		})
		r.Route("/version-denies", func(r chi.Router) {
			r.Get("/", h.listVersionDenies)
			r.Post("/", h.createVersionDeny)
			r.Delete("/{id}", h.deleteVersionDeny)
		})
	})

	// Administrative.
	r.Group(func(r chi.Router) {
		if h.authz != nil {
			r.Use(h.authz.RequireAdmin)
		}
		r.Route("/repositories", func(r chi.Router) {
			r.Get("/", h.listRepositories)
			r.Post("/", h.createRepository)
			r.Get("/{id}", h.getRepository)
			r.Put("/{id}", h.updateRepository)
			r.Delete("/{id}", h.deleteRepository)
			r.Get("/{id}/artifacts", h.listArtifacts)
			r.Get("/{id}/upstream-health", h.upstreamHealth)
			r.Get("/{id}/audit-logs", h.listAuditLogs)
		})
		r.Route("/users", func(r chi.Router) {
			r.Get("/", h.listUsers)
			r.Post("/", h.createUser)
			r.Put("/{id}", h.updateUser)
			r.Delete("/{id}", h.deleteUser)
			r.Post("/{id}/roles", h.assignRole)
			r.Delete("/{id}/roles/{roleID}", h.removeRole)
		})
		r.Route("/roles", func(r chi.Router) {
			r.Get("/", h.listRoles)
			r.Post("/", h.createRole)
			r.Delete("/{id}", h.deleteRole)
			r.Post("/{id}/permissions", h.addPermission)
			r.Delete("/{id}/permissions/{permID}", h.deletePermission)
		})
		r.Route("/group-mappings", func(r chi.Router) {
			r.Get("/", h.listGroupMappings)
			r.Post("/", h.createGroupMapping)
			r.Delete("/{id}", h.deleteGroupMapping)
		})
	})

	return r
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
