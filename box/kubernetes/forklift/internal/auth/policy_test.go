package auth

import (
	"strings"
	"testing"
)

func TestParsePolicy(t *testing.T) {
	policy := `
# comment line
p, readonly, repo, read, *, allow
p, dev, repo, read, team-a-*, allow
p, dev, repo, write, team-a-*, allow
p, dev, repo, read, team-a-*, allow
p, super, *, *, *
g, group:/platform, readonly
g, user:alice, dev
g, bob, dev
`
	got, err := ParsePolicy(policy)
	if err != nil {
		t.Fatalf("ParsePolicy: %v", err)
	}

	// Roles are sorted by name: dev, readonly, super.
	if len(got.Roles) != 3 {
		t.Fatalf("roles = %d, want 3: %+v", len(got.Roles), got.Roles)
	}
	if got.Roles[0].Name != "dev" || got.Roles[1].Name != "readonly" || got.Roles[2].Name != "super" {
		t.Fatalf("role order = %v", []string{got.Roles[0].Name, got.Roles[1].Name, got.Roles[2].Name})
	}

	// dev has one merged permission on team-a-* with read,write (deduped).
	dev := got.Roles[0]
	if len(dev.Permissions) != 1 {
		t.Fatalf("dev permissions = %d, want 1: %+v", len(dev.Permissions), dev.Permissions)
	}
	if dev.Permissions[0].RepoPattern != "team-a-*" || dev.Permissions[0].Actions != "read,write" {
		t.Fatalf("dev perm = %+v", dev.Permissions[0])
	}

	// '*' action resolves to admin.
	if got.Roles[2].Permissions[0].Actions != ActionAdmin {
		t.Fatalf("super action = %q, want admin", got.Roles[2].Permissions[0].Actions)
	}

	// Group vs user subjects.
	if len(got.GroupRoles) != 1 || got.GroupRoles[0].Subject != "/platform" || got.GroupRoles[0].Role != "readonly" {
		t.Fatalf("group roles = %+v", got.GroupRoles)
	}
	// alice (user: prefix) and bob (bare) both become user grants.
	if len(got.UserRoles) != 2 {
		t.Fatalf("user roles = %d, want 2: %+v", len(got.UserRoles), got.UserRoles)
	}
	if got.UserRoles[0].Subject != "alice" || got.UserRoles[1].Subject != "bob" {
		t.Fatalf("user subjects = %+v", got.UserRoles)
	}
}

func TestParsePolicyEmpty(t *testing.T) {
	got, err := ParsePolicy("\n  \n# only comments\n")
	if err != nil {
		t.Fatalf("ParsePolicy empty: %v", err)
	}
	if len(got.Roles) != 0 || len(got.GroupRoles) != 0 || len(got.UserRoles) != 0 {
		t.Fatalf("empty policy should be empty: %+v", got)
	}
}

func TestParsePolicyErrors(t *testing.T) {
	cases := map[string]string{
		"bad action":      "p, r, repo, frobnicate, *, allow",
		"deny effect":     "p, r, repo, read, *, deny",
		"bad resource":    "p, r, secret, read, *, allow",
		"short perm":      "p, r, repo, read",
		"empty role":      "p, , repo, read, *, allow",
		"grant arity":     "g, user:alice",
		"empty subject":   "g, , dev",
		"empty role name": "g, user:alice, ",
		"prefix only":     "g, group:, dev",
		"unknown stmt":    "x, foo, bar",
	}
	for name, policy := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := ParsePolicy(policy); err == nil {
				t.Fatalf("expected error for %q", policy)
			}
		})
	}
}

func TestParsePolicyLineNumberInError(t *testing.T) {
	_, err := ParsePolicy("p, ok, repo, read, *, allow\np, bad, repo, nope, *, allow")
	if err == nil || !strings.Contains(err.Error(), "line 2") {
		t.Fatalf("error should point at line 2: %v", err)
	}
}
