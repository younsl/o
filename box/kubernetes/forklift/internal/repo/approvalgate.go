package repo

import (
	"errors"
	"net/http"
	"path"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// pendingMarkTTL suppresses repeated pending-approval upserts for the same
// (repo, package) so unapproved hot paths do not hammer the single-writer
// SQLite. One mark per instance; a duplicate upsert after failover is idempotent.
const pendingMarkTTL = time.Minute

// approvalGate enforces the package approval policy (quarantine) for proxy
// repositories. It runs before any cache lookup or upstream fetch: rejected
// packages stop being served even when already cached, blocked responses never
// touch the negative cache, and unapproved packages never reach upstream. The
// age policy runs later (inside the engine) and stays orthogonal: approval
// admits the package, age gates its versions.
//
// It returns true when the request was blocked (response written). Blocks use
// 403, not 404: the group fan-out treats 404 as a member miss and would silently
// serve the package from the next member, and the GOPROXY protocol falls back
// to the next proxy on 404 — both would bypass the gate.
//
// version is the exact version derived from the request path ("" for metadata
// requests). It feeds the per-version deny list, which runs before — and
// independently of — the package approval workflow: a deny is an explicit
// security decision (poisoned release, IOC), so it blocks even when approval
// is disabled or in audit mode, and overrides package-level approval.
func (m *Manager) approvalGate(w http.ResponseWriter, r *http.Request, res resolved, pkg, version string) bool {
	if res.repo.Type != meta.TypeProxy {
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	if m.versionDenyGate(w, r, res, pkg, version) {
		return true
	}
	if !res.cfg.Approval.Enabled {
		return false
	}
	// Never block when the package name cannot be derived from the path
	// (mirrors the age policy's nil-publishedAt behavior).
	if pkg == "" {
		return false
	}
	for _, pat := range res.cfg.Approval.AutoApprove {
		if ok, _ := path.Match(pat, pkg); ok {
			return false
		}
	}

	mode := res.cfg.Approval.EffectiveMode()
	status, err := m.store.GetApprovalStatus(r.Context(), res.repo.Name, pkg)
	if err != nil && !errors.Is(err, meta.ErrNotFound) {
		m.engine.log.Error("approval status lookup failed", "repo", res.repo.Name, "package", pkg, "err", err)
		// Fail closed in enforce mode, open in audit mode.
		if mode == repoconfig.ModeEnforce {
			http.Error(w, "approval check failed", http.StatusServiceUnavailable)
			return true
		}
		return false
	}
	if err == nil && status == meta.ApprovalApproved {
		return false
	}

	// Record demand, suppressed per (repo, package) to bound write volume.
	mark := res.repo.Name + "\x00" + pkg
	if !m.reqMarks.has(mark) {
		m.reqMarks.set(mark, pendingMarkTTL)
		var username string
		if p := auth.FromContext(r.Context()); p != nil {
			username = p.Username
		}
		// Scan the requested coordinate so the approval queue carries a
		// vulnerability signal for the reviewer. A known version scans precisely;
		// an unknown version (e.g. a blocked npm packument) falls back to a
		// package-level scan. No-op when scanning is disabled.
		m.enqueueScan(osvEcosystem(res.repo.Format), pkg, version)
		created, uerr := m.store.UpsertPendingApproval(r.Context(), res.repo.Name, pkg, username, version)
		if uerr != nil {
			m.engine.log.Error("pending approval upsert failed", "repo", res.repo.Name, "package", pkg, "err", uerr)
		} else if created && m.rec != nil {
			m.rec.Record(audit.Event{
				Repo:      res.repo.Name,
				Action:    meta.EventApprovalRequest,
				Path:      pkg,
				Username:  username,
				Method:    r.Method,
				Status:    http.StatusForbidden,
				ClientIP:  audit.ClientIP(r),
				UserAgent: r.UserAgent(),
			})
		}
	}

	m.approvalBlocked.WithLabelValues(res.repo.Name, mode).Inc()
	if mode == repoconfig.ModeAudit {
		m.engine.log.Warn("approval audit: would block",
			"repo", res.repo.Name, "package", pkg, "status", statusOrNone(status, err))
		return false
	}
	m.engine.log.Warn("package blocked pending approval",
		"repo", res.repo.Name, "package", pkg, "status", statusOrNone(status, err))
	http.Error(w, "package pending approval: "+pkg, http.StatusForbidden)
	return true
}

// versionDenyGate blocks requests for explicitly denied (package, version)
// pairs. It runs before any cache lookup or upstream fetch, so denying a
// version immediately cuts off already-cached copies too. Metadata requests
// (version == "") pass through: a denied version stays listed in packuments
// and indexes, but its artifact fetch fails loudly with 403 — for a poisoned
// release a loud failure beats the resolver silently picking another version.
func (m *Manager) versionDenyGate(w http.ResponseWriter, r *http.Request, res resolved, pkg, version string) bool {
	if pkg == "" || version == "" {
		return false
	}
	denied, err := m.store.IsVersionDenied(r.Context(), res.repo.Name, pkg, version)
	if err != nil {
		// Fail closed: a deny is an always-enforce control, never silently
		// skipped (unlike audit-mode approval lookups).
		m.engine.log.Error("version deny lookup failed",
			"repo", res.repo.Name, "package", pkg, "version", version, "err", err)
		http.Error(w, "deny check failed", http.StatusServiceUnavailable)
		return true
	}
	if !denied {
		return false
	}

	// Audit each blocked (repo, package, version) at most once per mark TTL,
	// mirroring the pending-approval suppression.
	mark := "deny\x00" + res.repo.Name + "\x00" + pkg + "\x00" + version
	if !m.reqMarks.has(mark) {
		m.reqMarks.set(mark, pendingMarkTTL)
		if m.rec != nil {
			var username string
			if p := auth.FromContext(r.Context()); p != nil {
				username = p.Username
			}
			m.rec.Record(audit.Event{
				Repo:      res.repo.Name,
				Action:    meta.EventDenyBlock,
				Path:      pkg + "@" + version,
				Username:  username,
				Method:    r.Method,
				Status:    http.StatusForbidden,
				ClientIP:  audit.ClientIP(r),
				UserAgent: r.UserAgent(),
			})
		}
	}

	m.denyBlocked.WithLabelValues(res.repo.Name).Inc()
	m.engine.log.Warn("version blocked by deny list",
		"repo", res.repo.Name, "package", pkg, "version", version)
	http.Error(w, "version denied: "+pkg+"@"+version, http.StatusForbidden)
	return true
}

// statusOrNone renders an approval status for logging, with "none" for packages
// that have no approval row yet.
func statusOrNone(status string, err error) string {
	if err != nil {
		return "none"
	}
	return status
}
