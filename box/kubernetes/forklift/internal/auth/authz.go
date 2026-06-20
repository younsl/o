// Package auth provides authentication (local password, Keycloak OIDC, personal
// access tokens) and repository-scoped RBAC authorization.
package auth

import (
	"strings"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// Action constants. "admin" implies all other actions. "approve" grants
// package approval decisions (quarantine) on matching repositories without
// repository management rights, e.g. for security engineers. "audit" grants
// read-only access to the administrative surfaces (users, roles, group
// mappings, audit logs, repository permissions) without any mutation rights,
// e.g. for a security auditor.
const (
	ActionRead    = "read"
	ActionWrite   = "write"
	ActionDelete  = "delete"
	ActionApprove = "approve"
	ActionAudit   = "audit"
	ActionAdmin   = "admin"
)

// Scope is one entry of a personal access token's fine-grained scope: a set of
// actions on repositories matching a glob pattern.
type Scope struct {
	RepoPattern string   `json:"repo_pattern"`
	Actions     []string `json:"actions"`
}

// Principal is an authenticated identity with resolved effective permissions.
type Principal struct {
	Username string
	Source   string
	// perms is the union of permissions granted via the principal's roles.
	perms []meta.Permission
	// when viaToken is true, tokenScopes further restrict perms (intersection).
	viaToken    bool
	tokenScopes []Scope
}

// IsAdmin reports whether the principal has admin on all repositories.
func (p *Principal) IsAdmin() bool {
	return p.Can("", ActionAdmin)
}

// Can reports whether the principal may perform action on repo. An empty repo
// matches a wildcard-only check (used for global admin). A token-authenticated
// principal must satisfy both its role permissions and its token scopes.
func (p *Principal) Can(repo, action string) bool {
	if !p.rolesAllow(repo, action) {
		return false
	}
	// A token with no scopes inherits the user's full (role-limited) access; a
	// scoped token further narrows it to the listed repo/action pairs.
	if p.viaToken && len(p.tokenScopes) > 0 && !scopesAllow(p.tokenScopes, repo, action) {
		return false
	}
	return true
}

// CanApproveAny reports whether the principal may decide package approvals on
// at least one repository pattern (admin qualifies via admin-implies-all).
// Gates the approvals API and the UI nav; per-repository enforcement happens
// with Can(repo, ActionApprove) on each decision. Token-scoped principals
// never qualify: token scopes cannot carry the approve action.
func (p *Principal) CanApproveAny() bool {
	has := false
	for _, perm := range p.perms {
		if actionsContain(perm.Actions, ActionApprove) {
			has = true
			break
		}
	}
	if !has {
		return false
	}
	if p.viaToken && len(p.tokenScopes) > 0 {
		for _, s := range p.tokenScopes {
			if actionListContains(s.Actions, ActionApprove) {
				return true
			}
		}
		return false
	}
	return true
}

// CanAuditAny reports whether the principal may read the administrative
// surfaces on at least one repository pattern (admin qualifies via
// admin-implies-all). Like approve, the audit action cannot be carried by a
// token scope, so a scoped token never qualifies.
func (p *Principal) CanAuditAny() bool {
	has := false
	for _, perm := range p.perms {
		if actionsContain(perm.Actions, ActionAudit) {
			has = true
			break
		}
	}
	if !has {
		return false
	}
	if p.viaToken && len(p.tokenScopes) > 0 {
		return false
	}
	return true
}

func (p *Principal) rolesAllow(repo, action string) bool {
	for _, perm := range p.perms {
		if matchGlob(perm.RepoPattern, repo) && actionsContain(perm.Actions, action) {
			return true
		}
	}
	return false
}

func scopesAllow(scopes []Scope, repo, action string) bool {
	for _, s := range scopes {
		if matchGlob(s.RepoPattern, repo) && actionListContains(s.Actions, action) {
			return true
		}
	}
	return false
}

// actionsContain checks a CSV action list, honouring admin-implies-all.
func actionsContain(csv, action string) bool {
	for _, a := range strings.Split(csv, ",") {
		a = strings.TrimSpace(a)
		if a == ActionAdmin {
			return true
		}
		if a == action {
			return true
		}
	}
	return false
}

func actionListContains(list []string, action string) bool {
	for _, a := range list {
		if a == ActionAdmin || a == action {
			return true
		}
	}
	return false
}

// MatchRepoPattern reports whether a permission's repo pattern matches a
// repository name, using the same glob semantics as authorization. Exported so
// the API can list which roles apply to a given repository.
func MatchRepoPattern(pattern, name string) bool { return matchGlob(pattern, name) }

// matchGlob matches a repository name against a pattern that may contain '*'
// wildcards. Repository names contain no slashes, so '*' matches any run of
// characters. An empty repo only matches a "*" pattern (global checks).
func matchGlob(pattern, name string) bool {
	if pattern == "*" {
		return true
	}
	if name == "" {
		return false
	}
	return globMatch(pattern, name)
}

// globMatch is a small '*'-only glob matcher using the canonical two-pointer
// algorithm with star backtracking.
func globMatch(pattern, s string) bool {
	sx, px := 0, 0
	starIdx, sTmp := -1, -1
	for sx < len(s) {
		switch {
		case px < len(pattern) && pattern[px] == s[sx]:
			sx++
			px++
		case px < len(pattern) && pattern[px] == '*':
			starIdx = px
			sTmp = sx
			px++
		case starIdx != -1:
			px = starIdx + 1
			sTmp++
			sx = sTmp
		default:
			return false
		}
	}
	for px < len(pattern) && pattern[px] == '*' {
		px++
	}
	return px == len(pattern)
}
