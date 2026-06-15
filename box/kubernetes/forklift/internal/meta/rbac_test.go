package meta

import (
	"context"
	"testing"
)

func devPolicy() ManagedRBAC {
	return ManagedRBAC{
		Roles: []ManagedRole{
			{Name: "readonly", Permissions: []Permission{{RepoPattern: "*", Actions: "read"}}},
			{Name: "dev", Permissions: []Permission{{RepoPattern: "team-*", Actions: "read,write"}}},
		},
		GroupRoles: []ManagedGrant{{Subject: "/platform", Role: "readonly"}},
		UserRoles:  []ManagedGrant{{Subject: "alice", Role: "dev"}},
	}
}

func TestApplyManagedRBAC(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	if err := s.ApplyManagedRBAC(ctx, devPolicy()); err != nil {
		t.Fatalf("apply: %v", err)
	}

	roles, _ := s.ListRoles(ctx)
	if len(roles) != 2 {
		t.Fatalf("roles = %d, want 2", len(roles))
	}
	for _, r := range roles {
		if !r.Managed {
			t.Fatalf("role %q should be managed", r.Name)
		}
	}

	// alice was provisioned as an OIDC placeholder and granted dev.
	alice, err := s.GetUserByUsername(ctx, "alice")
	if err != nil {
		t.Fatalf("alice not created: %v", err)
	}
	if alice.Source != SourceOIDC {
		t.Fatalf("alice source = %q, want oidc", alice.Source)
	}
	perms, _ := s.PermissionsForUser(ctx, alice.ID)
	if len(perms) != 1 || perms[0].Actions != "read,write" {
		t.Fatalf("alice perms = %+v", perms)
	}

	// Group mapping resolves to readonly.
	names, _ := s.RoleNamesForGroups(ctx, []string{"/platform"})
	if len(names) != 1 || names[0] != "readonly" {
		t.Fatalf("group roles = %v", names)
	}
}

func TestApplyManagedRBACAuthoritative(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	// Seed an unmanaged role + mapping via the regular API path.
	unmanaged, err := s.CreateRole(ctx, Role{Name: "unmanaged"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AddPermission(ctx, Permission{RoleID: unmanaged.ID, RepoPattern: "*", Actions: "read"}); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateGroupMapping(ctx, "/manual", unmanaged.ID); err != nil {
		t.Fatal(err)
	}

	if err := s.ApplyManagedRBAC(ctx, devPolicy()); err != nil {
		t.Fatalf("apply 1: %v", err)
	}

	// Re-apply a policy that drops the dev role entirely.
	shrunk := devPolicy()
	shrunk.Roles = shrunk.Roles[:1] // keep only readonly
	shrunk.UserRoles = nil
	if err := s.ApplyManagedRBAC(ctx, shrunk); err != nil {
		t.Fatalf("apply 2: %v", err)
	}

	roles, _ := s.ListRoles(ctx)
	got := map[string]bool{}
	for _, r := range roles {
		got[r.Name] = true
	}
	if got["dev"] {
		t.Fatal("managed role 'dev' should be removed after policy shrink")
	}
	if !got["readonly"] {
		t.Fatal("managed role 'readonly' should remain")
	}
	// The unmanaged role and its mapping survive reconciliation untouched.
	if !got["unmanaged"] {
		t.Fatal("unmanaged role must be preserved")
	}
	mappings, _ := s.ListGroupMappings(ctx)
	var sawManual bool
	for _, m := range mappings {
		if m.GroupName == "/manual" {
			sawManual = true
			if m.Managed {
				t.Fatal("/manual mapping must stay unmanaged")
			}
		}
	}
	if !sawManual {
		t.Fatal("unmanaged group mapping must be preserved")
	}
}

func TestApplyManagedRBACClearsAllManaged(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if err := s.ApplyManagedRBAC(ctx, devPolicy()); err != nil {
		t.Fatal(err)
	}
	// An empty policy removes every managed role (and cascades grants/mappings).
	if err := s.ApplyManagedRBAC(ctx, ManagedRBAC{}); err != nil {
		t.Fatalf("apply empty: %v", err)
	}
	roles, _ := s.ListRoles(ctx)
	if len(roles) != 0 {
		t.Fatalf("managed roles should be wiped, got %+v", roles)
	}
	mappings, _ := s.ListGroupMappings(ctx)
	if len(mappings) != 0 {
		t.Fatalf("managed mappings should be wiped, got %+v", mappings)
	}
}

func TestApplyManagedRBACUnknownRole(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	// A grant referencing a role neither defined in the policy nor existing in
	// the database is rejected.
	err := s.ApplyManagedRBAC(ctx, ManagedRBAC{
		GroupRoles: []ManagedGrant{{Subject: "/x", Role: "ghost"}},
	})
	if err == nil {
		t.Fatal("expected error for grant to unknown role")
	}
}

func TestApplyManagedRBACLocalUser(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	// Pre-existing local user must not have its password overwritten.
	existing, err := s.CreateUser(ctx, User{Username: "bootstrap", PasswordHash: "original", Source: SourceLocal})
	if err != nil {
		t.Fatal(err)
	}

	d := ManagedRBAC{
		Roles: []ManagedRole{{Name: "dev", Permissions: []Permission{{RepoPattern: "*", Actions: "read"}}}},
		LocalUsers: []ManagedLocalUser{
			{Username: "ci-bot", PasswordHash: "hashed-pw"},
			{Username: "bootstrap", PasswordHash: "should-not-apply"},
		},
		UserRoles: []ManagedGrant{{Subject: "ci-bot", Role: "dev"}},
	}
	if err := s.ApplyManagedRBAC(ctx, d); err != nil {
		t.Fatalf("apply: %v", err)
	}

	bot, err := s.GetUserByUsername(ctx, "ci-bot")
	if err != nil {
		t.Fatalf("ci-bot not created: %v", err)
	}
	if bot.Source != SourceLocal || bot.PasswordHash != "hashed-pw" {
		t.Fatalf("ci-bot = %+v", bot)
	}

	again, _ := s.GetUser(ctx, existing.ID)
	if again.PasswordHash != "original" {
		t.Fatalf("existing password overwritten: %q", again.PasswordHash)
	}
}

func TestManagedFlagHelpers(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if err := s.ApplyManagedRBAC(ctx, devPolicy()); err != nil {
		t.Fatal(err)
	}

	roles, _ := s.ListRoles(ctx)
	var devID int64
	for _, r := range roles {
		if r.Name == "dev" {
			devID = r.ID
		}
	}
	if managed, err := s.RoleManaged(ctx, devID); err != nil || !managed {
		t.Fatalf("RoleManaged(dev) = %v, %v", managed, err)
	}
	if managed, _ := s.RoleManaged(ctx, 99999); managed {
		t.Fatal("missing role should report unmanaged")
	}

	perms, _ := s.ListPermissions(ctx)
	if managed, err := s.PermissionManaged(ctx, perms[0].ID); err != nil || !managed {
		t.Fatalf("PermissionManaged = %v, %v", managed, err)
	}

	mappings, _ := s.ListGroupMappings(ctx)
	if managed, err := s.GroupMappingManaged(ctx, mappings[0].ID); err != nil || !managed {
		t.Fatalf("GroupMappingManaged = %v, %v", managed, err)
	}

	alice, _ := s.GetUserByUsername(ctx, "alice")
	dev, _ := s.GetRoleByName(ctx, "dev")
	if managed, err := s.IsManagedUserRole(ctx, alice.ID, dev.ID); err != nil || !managed {
		t.Fatalf("IsManagedUserRole = %v, %v", managed, err)
	}
	if managed, _ := s.IsManagedUserRole(ctx, alice.ID, 99999); managed {
		t.Fatal("missing assignment should report unmanaged")
	}
}

func TestSyncOIDCGroupRoles(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	readonly, _ := s.CreateRole(ctx, Role{Name: "readonly"})
	security, _ := s.CreateRole(ctx, Role{Name: "security"})
	admins, _ := s.CreateRole(ctx, Role{Name: "admins"})
	if err := s.CreateGroupMapping(ctx, "/security", security.ID); err != nil {
		t.Fatalf("map security: %v", err)
	}
	if err := s.CreateGroupMapping(ctx, "/administrator", admins.ID); err != nil {
		t.Fatalf("map admin: %v", err)
	}

	u, _ := s.CreateUser(ctx, User{Username: "bob", Source: SourceOIDC})

	// An admin manually grants readonly; this interactive (managed=0) row must
	// survive every sync.
	if err := s.AssignRole(ctx, u.ID, readonly.ID); err != nil {
		t.Fatalf("manual assign: %v", err)
	}

	// First login: member of /security only.
	if err := s.SyncOIDCGroupRoles(ctx, u.ID, []string{"/security"}); err != nil {
		t.Fatalf("sync 1: %v", err)
	}
	if got := roleNames(t, s, u.ID); !sameSet(got, []string{"readonly", "security"}) {
		t.Fatalf("after sync 1 roles = %v", got)
	}
	// The synced role is treated as managed (read-only via API).
	if managed, _ := s.IsManagedUserRole(ctx, u.ID, security.ID); !managed {
		t.Fatal("synced security role should report managed")
	}
	// The manual grant stays unmanaged.
	if managed, _ := s.IsManagedUserRole(ctx, u.ID, readonly.ID); managed {
		t.Fatal("manual readonly grant should stay unmanaged")
	}

	// Second login: moved from /security to /administrator. security is revoked,
	// admins granted, manual readonly untouched.
	if err := s.SyncOIDCGroupRoles(ctx, u.ID, []string{"/administrator"}); err != nil {
		t.Fatalf("sync 2: %v", err)
	}
	if got := roleNames(t, s, u.ID); !sameSet(got, []string{"readonly", "admins"}) {
		t.Fatalf("after sync 2 roles = %v", got)
	}

	// Third login: no group claims. All login-synced roles revoked, manual stays.
	if err := s.SyncOIDCGroupRoles(ctx, u.ID, nil); err != nil {
		t.Fatalf("sync 3: %v", err)
	}
	if got := roleNames(t, s, u.ID); !sameSet(got, []string{"readonly"}) {
		t.Fatalf("after sync 3 roles = %v", got)
	}
}

func roleNames(t *testing.T, s *Store, userID int64) []string {
	t.Helper()
	byUser, err := s.RolesByUser(context.Background())
	if err != nil {
		t.Fatalf("RolesByUser: %v", err)
	}
	var names []string
	for _, r := range byUser[userID] {
		names = append(names, r.Name)
	}
	return names
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	m := map[string]int{}
	for _, x := range a {
		m[x]++
	}
	for _, x := range b {
		m[x]--
	}
	for _, v := range m {
		if v != 0 {
			return false
		}
	}
	return true
}
