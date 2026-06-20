package repo

import (
	"errors"
	"net/http"
	"strings"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
	"github.com/younsl/o/box/kubernetes/forklift/internal/vuln"
)

// vulnGate enforces the per-repository vulnerability policy for proxy reads. It
// consults stored scan results only (never blocking on a live lookup): a
// not-yet-scanned coordinate is queued for async scanning and, unless
// BlockUnscanned is set, served meanwhile. A scanned coordinate whose remaining
// (non-ignored) advisories meet the threshold is blocked, warned, or audited.
//
// Returns true when the request was blocked (response written).
func (m *Manager) vulnGate(w http.ResponseWriter, r *http.Request, res resolved, pkg, version string) bool {
	if m.scanner == nil || res.repo.Type != meta.TypeProxy {
		return false
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		return false
	}
	cfg := res.cfg.Vuln
	if !cfg.Enabled || pkg == "" || version == "" {
		return false
	}
	eco := osvEcosystem(res.repo.Format)
	if eco == "" {
		return false
	}

	scan, err := m.store.GetVulnScan(r.Context(), eco, pkg, version)
	if errors.Is(err, meta.ErrNotFound) {
		m.enqueueScan(eco, pkg, version)
		// Unknown coordinate: fail open unless the policy opts into blocking
		// pending scans under an enforcing posture.
		if cfg.EffectiveAction() == repoconfig.VulnActionBlock && cfg.BlockUnscanned {
			http.Error(w, "package pending vulnerability scan: "+pkg, http.StatusForbidden)
			return true
		}
		return false
	}
	if err != nil {
		// Best-effort: a lookup error must not break serving.
		m.engine.log.Error("vuln scan lookup failed", "repo", res.repo.Name, "package", pkg, "version", version, "err", err)
		return false
	}

	// All advisories accepted/false-positive: treat as clean.
	if len(scan.VulnIDs) == 0 || allIgnored(scan.VulnIDs, cfg.Ignore) {
		return false
	}
	if vuln.ParseSeverity(scan.MaxSeverity) < vuln.ParseSeverity(cfg.EffectiveThreshold()) {
		return false
	}

	action := cfg.EffectiveAction()
	m.vulnBlocked.WithLabelValues(res.repo.Name, action).Inc()
	if action == repoconfig.VulnActionAudit || action == repoconfig.VulnActionWarn {
		m.engine.log.Warn("vuln policy: would block",
			"repo", res.repo.Name, "package", pkg, "version", version,
			"severity", scan.MaxSeverity, "ids", strings.Join(scan.VulnIDs, ","), "action", action)
		return false
	}

	if m.rec != nil {
		var username string
		if p := auth.FromContext(r.Context()); p != nil {
			username = p.Username
		}
		m.rec.Record(audit.Event{
			Repo:      res.repo.Name,
			Action:    meta.EventVulnBlock,
			Path:      pkg + "@" + version,
			Username:  username,
			Method:    r.Method,
			Status:    http.StatusForbidden,
			ClientIP:  audit.ClientIP(r),
			UserAgent: r.UserAgent(),
		})
	}
	m.engine.log.Warn("package blocked by vulnerability policy",
		"repo", res.repo.Name, "package", pkg, "version", version,
		"severity", scan.MaxSeverity, "ids", strings.Join(scan.VulnIDs, ","))
	http.Error(w, "blocked: known vulnerabilities ("+scan.MaxSeverity+") in "+pkg+"@"+version, http.StatusForbidden)
	return true
}

// allIgnored reports whether every advisory id is in the ignore list.
func allIgnored(ids, ignore []string) bool {
	if len(ignore) == 0 {
		return false
	}
	set := make(map[string]bool, len(ignore))
	for _, ig := range ignore {
		set[ig] = true
	}
	for _, id := range ids {
		if !set[id] {
			return false
		}
	}
	return true
}
