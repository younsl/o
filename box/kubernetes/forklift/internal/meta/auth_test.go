package meta

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestUserCRUD(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	u, err := s.CreateUser(ctx, User{Username: "alice", PasswordHash: "h", Email: "a@x.io"})
	if err != nil {
		t.Fatal(err)
	}
	if u.Source != SourceLocal {
		t.Fatalf("default source = %q", u.Source)
	}
	if got, _ := s.GetUserByUsername(ctx, "alice"); got.ID != u.ID {
		t.Fatal("get by username mismatch")
	}
	if n, _ := s.CountUsers(ctx); n != 1 {
		t.Fatalf("count = %d", n)
	}

	if err := s.SetPassword(ctx, u.ID, "h2"); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetUser(ctx, u.ID); got.PasswordHash != "h2" {
		t.Fatal("password not updated")
	}
	if err := s.SetUserDisabled(ctx, u.ID, true); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetUser(ctx, u.ID); !got.Disabled {
		t.Fatal("not disabled")
	}

	// EnsureUser is idempotent and provisions OIDC users.
	e1, _ := s.EnsureUser(ctx, "bob", "b@x.io", SourceOIDC)
	e2, _ := s.EnsureUser(ctx, "bob", "b@x.io", SourceOIDC)
	if e1.ID != e2.ID {
		t.Fatal("EnsureUser not idempotent")
	}

	list, _ := s.ListUsers(ctx)
	if len(list) != 2 {
		t.Fatalf("list len = %d", len(list))
	}
	if err := s.DeleteUser(ctx, u.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetUser(ctx, u.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
}

func TestRolesPermissionsAssignment(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()

	u, _ := s.CreateUser(ctx, User{Username: "dev"})
	role, err := s.CreateRole(ctx, Role{Name: "writers"})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := s.GetRoleByName(ctx, "writers"); got.ID != role.ID {
		t.Fatal("role get mismatch")
	}
	if _, err := s.AddPermission(ctx, Permission{RoleID: role.ID, RepoPattern: "maven-*", Actions: "read,write"}); err != nil {
		t.Fatal(err)
	}
	if err := s.AssignRole(ctx, u.ID, role.ID); err != nil {
		t.Fatal(err)
	}
	// Idempotent assign.
	if err := s.AssignRole(ctx, u.ID, role.ID); err != nil {
		t.Fatal(err)
	}

	perms, _ := s.PermissionsForUser(ctx, u.ID)
	if len(perms) != 1 || perms[0].RepoPattern != "maven-*" {
		t.Fatalf("perms = %+v", perms)
	}
	byName, _ := s.PermissionsForRoleNames(ctx, []string{"writers"})
	if len(byName) != 1 {
		t.Fatalf("perms by name = %+v", byName)
	}
	if got, _ := s.PermissionsForRoleNames(ctx, nil); got != nil {
		t.Fatal("empty names should return nil")
	}

	if err := s.RemoveRole(ctx, u.ID, role.ID); err != nil {
		t.Fatal(err)
	}
	if perms, _ := s.PermissionsForUser(ctx, u.ID); len(perms) != 0 {
		t.Fatal("role not removed")
	}

	roles, _ := s.ListRoles(ctx)
	if len(roles) != 1 {
		t.Fatalf("roles len = %d", len(roles))
	}
	if err := s.DeleteRole(ctx, role.ID); err != nil {
		t.Fatal(err)
	}
}

func TestGroupMappings(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	role, _ := s.CreateRole(ctx, Role{Name: "platform"})

	if err := s.CreateGroupMapping(ctx, "team-platform", role.ID); err != nil {
		t.Fatal(err)
	}
	// Upsert on conflict.
	if err := s.CreateGroupMapping(ctx, "team-platform", role.ID); err != nil {
		t.Fatal(err)
	}
	names, _ := s.RoleNamesForGroups(ctx, []string{"team-platform", "unknown"})
	if len(names) != 1 || names[0] != "platform" {
		t.Fatalf("role names = %v", names)
	}
	if got, _ := s.RoleNamesForGroups(ctx, nil); got != nil {
		t.Fatal("empty groups should return nil")
	}

	list, _ := s.ListGroupMappings(ctx)
	if len(list) != 1 {
		t.Fatalf("mappings = %d", len(list))
	}
	if err := s.DeleteGroupMapping(ctx, list[0].ID); err != nil {
		t.Fatal(err)
	}
}

func TestTokens(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	u, _ := s.CreateUser(ctx, User{Username: "svc"})

	exp := time.Now().Add(time.Hour).UTC()
	tok, err := s.CreateToken(ctx, Token{UserID: u.ID, Name: "ci", Hash: "abc123", ScopesJSON: "[]", ExpiresAt: &exp})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.GetTokenByHash(ctx, "abc123")
	if err != nil || got.ID != tok.ID {
		t.Fatalf("get by hash: %v", err)
	}
	if got.ExpiresAt == nil {
		t.Fatal("expiry not persisted")
	}
	if err := s.TouchToken(ctx, tok.ID); err != nil {
		t.Fatal(err)
	}

	list, _ := s.ListTokens(ctx, u.ID)
	if len(list) != 1 || list[0].Hash != "" {
		t.Fatalf("list should omit hash: %+v", list)
	}
	if err := s.DeleteToken(ctx, u.ID, tok.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetTokenByHash(ctx, "abc123"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want not found, got %v", err)
	}
}
