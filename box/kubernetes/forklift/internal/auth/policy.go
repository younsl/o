package auth

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// Subject prefixes for grant (g) lines. A bare subject is treated as a user.
const (
	subjectUserPrefix  = "user:"
	subjectGroupPrefix = "group:"
)

// ParsePolicy parses an ArgoCD-style RBAC policy into the desired managed
// state. The grammar is line-oriented; blank lines and lines beginning with
// '#' are ignored. Two statement kinds are supported:
//
//	p, <role>, <resource>, <action>, <object>, <effect>
//	g, <subject>, <role>
//
// For permission (p) lines, <resource> is "repo" (or "*"), <action> is one of
// read|write|delete|approve|admin (or "*" meaning admin), <object> is a
// repository glob pattern, and <effect> is "allow" (the only effect forklift
// enforces; "deny" is rejected). For grant (g) lines, <subject> is "user:<name>",
// "group:<name>", or a bare name (treated as a user); groups map to Keycloak
// group claims.
//
// LocalUsers are not expressed in the policy text; they are supplied separately
// (see LoadAccounts) because passwords must come from a Secret, not a ConfigMap.
func ParsePolicy(text string) (meta.ManagedRBAC, error) {
	// role name -> repo pattern -> ordered, de-duplicated action set.
	roleActions := map[string]map[string][]string{}
	roleSeen := map[string]bool{} // preserves declaration even with no permission
	var groupRoles, userRoles []meta.ManagedGrant

	for i, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := splitCSV(line)
		switch fields[0] {
		case "p":
			role, pattern, action, err := parsePermissionLine(fields)
			if err != nil {
				return meta.ManagedRBAC{}, fmt.Errorf("policy line %d: %w", i+1, err)
			}
			roleSeen[role] = true
			if roleActions[role] == nil {
				roleActions[role] = map[string][]string{}
			}
			roleActions[role][pattern] = appendUnique(roleActions[role][pattern], action)
		case "g":
			subject, role, err := parseGrantLine(fields)
			if err != nil {
				return meta.ManagedRBAC{}, fmt.Errorf("policy line %d: %w", i+1, err)
			}
			if name, ok := strings.CutPrefix(subject, subjectGroupPrefix); ok {
				groupRoles = append(groupRoles, meta.ManagedGrant{Subject: name, Role: role})
			} else {
				name := strings.TrimPrefix(subject, subjectUserPrefix)
				userRoles = append(userRoles, meta.ManagedGrant{Subject: name, Role: role})
			}
		default:
			return meta.ManagedRBAC{}, fmt.Errorf("policy line %d: unknown statement %q (want 'p' or 'g')", i+1, fields[0])
		}
	}

	return meta.ManagedRBAC{
		Roles:      buildRoles(roleSeen, roleActions),
		GroupRoles: groupRoles,
		UserRoles:  userRoles,
	}, nil
}

func parsePermissionLine(fields []string) (role, pattern, action string, err error) {
	if len(fields) < 5 || len(fields) > 6 {
		return "", "", "", fmt.Errorf("permission needs 'p, <role>, <resource>, <action>, <object>[, allow]'")
	}
	role = fields[1]
	resource := fields[2]
	action = fields[3]
	pattern = fields[4]
	effect := "allow"
	if len(fields) == 6 {
		effect = fields[5]
	}
	if role == "" || pattern == "" {
		return "", "", "", fmt.Errorf("role and object must not be empty")
	}
	if resource != "repo" && resource != "*" {
		return "", "", "", fmt.Errorf("unsupported resource %q (want 'repo')", resource)
	}
	if effect != "allow" {
		return "", "", "", fmt.Errorf("unsupported effect %q (forklift enforces allow only)", effect)
	}
	if action == "*" {
		action = ActionAdmin
	}
	if !validRoleAction(action) {
		return "", "", "", fmt.Errorf("invalid action %q", action)
	}
	return role, pattern, action, nil
}

func parseGrantLine(fields []string) (subject, role string, err error) {
	if len(fields) != 3 {
		return "", "", fmt.Errorf("grant needs 'g, <subject>, <role>'")
	}
	subject, role = fields[1], fields[2]
	if subject == "" || role == "" {
		return "", "", fmt.Errorf("subject and role must not be empty")
	}
	if subject == subjectUserPrefix || subject == subjectGroupPrefix {
		return "", "", fmt.Errorf("subject must not be empty after prefix")
	}
	return subject, role, nil
}

func buildRoles(seen map[string]bool, actions map[string]map[string][]string) []meta.ManagedRole {
	names := make([]string, 0, len(seen))
	for n := range seen {
		names = append(names, n)
	}
	sort.Strings(names)

	out := make([]meta.ManagedRole, 0, len(names))
	for _, name := range names {
		role := meta.ManagedRole{Name: name, Description: "Managed by declarative RBAC policy"}
		patterns := make([]string, 0, len(actions[name]))
		for p := range actions[name] {
			patterns = append(patterns, p)
		}
		sort.Strings(patterns)
		for _, p := range patterns {
			role.Permissions = append(role.Permissions, meta.Permission{
				RepoPattern: p,
				Actions:     strings.Join(actions[name][p], ","),
			})
		}
		out = append(out, role)
	}
	return out
}

// validRoleAction reports whether action is a grantable RBAC action.
func validRoleAction(action string) bool {
	switch action {
	case ActionRead, ActionWrite, ActionDelete, ActionApprove, ActionAudit, ActionAdmin:
		return true
	default:
		return false
	}
}

func splitCSV(line string) []string {
	parts := strings.Split(line, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func appendUnique(list []string, v string) []string {
	if slices.Contains(list, v) {
		return list
	}
	return append(list, v)
}
