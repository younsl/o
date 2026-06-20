package repo

import (
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
	"github.com/younsl/o/box/kubernetes/forklift/internal/vuln"
)

// Manager mounts the package-format protocol routes onto a router.
type Manager struct {
	engine *Engine
	store  *meta.Store
	authz  *auth.Service
	rec    *audit.Recorder
	// externalURL, when set, overrides request-derived bases in synthesised
	// URLs (see externalBase).
	externalURL string

	// reqMarks suppresses repeated pending-approval upserts (see approvalGate).
	reqMarks        *negCache
	approvalBlocked *prometheus.CounterVec
	denyBlocked     *prometheus.CounterVec
	ttlExpired      *prometheus.CounterVec
	vulnBlocked     *prometheus.CounterVec
	vulnScans       *prometheus.CounterVec

	// scanner performs vulnerability lookups; nil disables the vuln gate. Scan
	// jobs are queued and processed by RunVulnWorker so the serving path never
	// blocks on an advisory lookup.
	scanner   vuln.Scanner
	scanQueue chan scanJob
}

// NewManager creates a Manager. authz may be nil to disable authorization
// (all access allowed), rec may be nil to disable audit logging, and reg may
// be nil to skip metric registration, all of which are useful in tests.
func NewManager(engine *Engine, store *meta.Store, authz *auth.Service, rec *audit.Recorder, reg prometheus.Registerer) *Manager {
	m := &Manager{
		engine:   engine,
		store:    store,
		authz:    authz,
		rec:      rec,
		reqMarks: newNegCache(),
		approvalBlocked: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "approval_blocked_total",
			Help: "Requests blocked (or counted in audit mode) by the package approval policy.",
		}, []string{"repo", "mode"}),
		denyBlocked: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "version_deny_blocked_total",
			Help: "Requests blocked by the per-version deny list.",
		}, []string{"repo"}),
		ttlExpired: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "ttl_expired_total",
			Help: "Artifacts auto-deleted by the idle retention reaper.",
		}, []string{"repo"}),
		vulnBlocked: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "vuln_blocked_total",
			Help: "Requests blocked (or counted in warn/audit mode) by the vulnerability policy.",
		}, []string{"repo", "action"}),
		vulnScans: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "vuln_scans_total",
			Help: "Vulnerability scans performed, by result (clean|vulnerable|error).",
		}, []string{"result"}),
		scanQueue: make(chan scanJob, 256),
	}
	if reg != nil {
		reg.MustRegister(m.approvalBlocked, m.denyBlocked, m.ttlExpired, m.vulnBlocked, m.vulnScans)
	}
	return m
}

// SetVulnScanner enables the vulnerability gate and background scanning. When
// unset, the gate is a no-op (the feature is disabled).
func (m *Manager) SetVulnScanner(s vuln.Scanner) { m.scanner = s }

// authorize enforces RBAC for a repository request. action is read, write or
// delete. It returns false and writes the response when access is denied.
// Requests routed through a group repository were already authorized against
// the group, so member-level checks are skipped.
func (m *Manager) authorize(w http.ResponseWriter, r *http.Request, repoName, action string) bool {
	if m.authz == nil {
		return true
	}
	if viaGroup(r.Context()) {
		return true
	}
	p := auth.FromContext(r.Context())
	if p == nil {
		if action == auth.ActionRead && m.authz.AnonymousRead() {
			return true
		}
		auth.UnauthorizedBasic(w)
		return false
	}
	if !p.Can(repoName, action) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	return true
}

// actionForMethod maps an HTTP method to an RBAC action.
func actionForMethod(method string) string {
	switch method {
	case http.MethodPut, http.MethodPost:
		return auth.ActionWrite
	case http.MethodDelete:
		return auth.ActionDelete
	default:
		return auth.ActionRead
	}
}

// Engine exposes the underlying engine (for the background sweeper in main).
func (m *Manager) Engine() *Engine { return m.engine }

// SetExternalURL pins the externally-visible base URL (FORKLIFT_EXTERNAL_URL)
// instead of deriving it from request Host/X-Forwarded-* headers.
func (m *Manager) SetExternalURL(u string) { m.externalURL = strings.TrimRight(u, "/") }

// Register mounts all format endpoints onto r. Each format lives under its own
// prefix with the repository name as the first path segment:
//
//	/maven/{repo}/<maven coordinate path>
func (m *Manager) Register(r chi.Router) {
	r.Handle("/maven/{repo}/*", m.wrap(m.handleMaven))
	r.Handle("/npm/{repo}/*", m.wrap(m.handleNpm))
	r.Handle("/cargo/{repo}/*", m.wrap(m.handleCargo))
	r.Handle("/go/{repo}/*", m.wrap(m.handleGo))
	// The bare route accepts twine uploads, which POST to the repository root.
	r.Handle("/pypi/{repo}", m.wrap(m.handlePyPI))
	r.Handle("/pypi/{repo}/*", m.wrap(m.handlePyPI))
}

// wrap applies the shared format-handler middleware: group fan-out innermost,
// audit logging outermost (so a group request is audited once, under the
// group's own name with the final status).
func (m *Manager) wrap(h http.HandlerFunc) http.Handler {
	return m.audited(m.grouped(h))
}

// audited wraps a format handler so every repository request — including
// denied and not-found ones — lands in the audit log with its final status.
func (m *Manager) audited(next http.Handler) http.Handler {
	if m.rec == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		var username string
		if p := auth.FromContext(r.Context()); p != nil {
			username = p.Username
		}
		m.rec.Record(audit.Event{
			Repo:      chi.URLParam(r, "repo"),
			Action:    eventForMethod(r.Method),
			Path:      strings.TrimPrefix(chi.URLParam(r, "*"), "/"),
			Username:  username,
			Method:    r.Method,
			Status:    sw.status,
			ClientIP:  audit.ClientIP(r),
			UserAgent: r.UserAgent(),
		})
	})
}

// eventForMethod maps an HTTP method to an audit event type.
func eventForMethod(method string) string {
	switch method {
	case http.MethodPut, http.MethodPost:
		return meta.EventUpload
	case http.MethodDelete:
		return meta.EventDelete
	default:
		return meta.EventDownload
	}
}

// statusWriter captures the response status for audit records.
type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (w *statusWriter) WriteHeader(code int) {
	if !w.wrote {
		w.status = code
		w.wrote = true
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if !w.wrote {
		w.status = http.StatusOK
		w.wrote = true
	}
	return w.ResponseWriter.Write(b)
}

// resolved bundles a repository with its parsed config and the repo-relative
// request path.
type resolved struct {
	repo meta.Repository
	cfg  repoconfig.Config
	path string
}

// resolve loads the repository named in the {repo} URL param, verifies its
// format, parses its config, and extracts the repo-relative wildcard path,
// which must be non-empty.
func (m *Manager) resolve(w http.ResponseWriter, r *http.Request, format string) (resolved, bool) {
	res, ok := m.resolveRepo(w, r, format)
	if !ok {
		return resolved{}, false
	}
	if res.path == "" {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return resolved{}, false
	}
	return res, true
}

// resolveRepo is resolve without the non-empty path requirement, for formats
// whose protocol addresses the repository root (PyPI uploads).
func (m *Manager) resolveRepo(w http.ResponseWriter, r *http.Request, format string) (resolved, bool) {
	name := chi.URLParam(r, "repo")
	repo, err := m.store.GetRepositoryByName(r.Context(), name)
	if err != nil {
		if errors.Is(err, meta.ErrNotFound) {
			http.Error(w, "repository not found", http.StatusNotFound)
		} else {
			http.Error(w, "metadata error", http.StatusInternalServerError)
		}
		return resolved{}, false
	}
	if repo.Format != format {
		http.Error(w, "repository format mismatch", http.StatusNotFound)
		return resolved{}, false
	}
	if repo.Disabled {
		http.Error(w, "repository disabled", http.StatusServiceUnavailable)
		return resolved{}, false
	}
	cfg, err := repoconfig.Parse(repo.ConfigJSON)
	if err != nil {
		http.Error(w, "invalid repository config", http.StatusInternalServerError)
		return resolved{}, false
	}
	path := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if strings.Contains(path, "..") {
		http.Error(w, "invalid path", http.StatusBadRequest)
		return resolved{}, false
	}
	return resolved{repo: repo, cfg: cfg, path: path}, true
}

// joinUpstream builds an upstream URL from a base and a repo-relative path.
func joinUpstream(base, path string) string {
	return strings.TrimRight(base, "/") + "/" + strings.TrimLeft(path, "/")
}
