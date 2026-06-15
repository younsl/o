package meta

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// ManagedRBAC is the desired declarative RBAC state parsed from the chart
// policy. ApplyManagedRBAC reconciles the database to match it, owning every
// row it writes via the managed flag and leaving interactively-created
// (unmanaged) rows untouched.
type ManagedRBAC struct {
	Roles      []ManagedRole
	GroupRoles []ManagedGrant     // Keycloak group name -> role name
	UserRoles  []ManagedGrant     // username -> role name
	LocalUsers []ManagedLocalUser // local accounts to provision
}

// ManagedRole is a declaratively-defined role and its permissions.
type ManagedRole struct {
	Name        string
	Description string
	Permissions []Permission // RepoPattern + Actions; RoleID/ID/Managed ignored
}

// ManagedGrant assigns a subject (group or username) to a role by name.
type ManagedGrant struct {
	Subject string
	Role    string
}

// ManagedLocalUser is a local (password) account to provision. PasswordHash is
// applied only when the user is first created; an existing account's password
// is never overwritten by reconciliation.
type ManagedLocalUser struct {
	Username     string
	PasswordHash string
	Email        string
}

// ApplyManagedRBAC reconciles the database to the desired declarative state in
// a single transaction. It is authoritative for managed rows: roles, grants and
// group mappings present in the database with managed=1 but absent from the
// desired state are removed. Unmanaged rows are never touched, except that a
// grant or mapping duplicating a desired one is adopted (managed=1). Users are
// never deleted; removing a user from the policy only strips its managed roles.
func (s *Store) ApplyManagedRBAC(ctx context.Context, d ManagedRBAC) error {
	tx, err := s.h().BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit

	now := nowRFC3339()

	// 1. Ensure users exist. Local accounts get a password on creation; subjects
	//    referenced only by a user grant are provisioned as OIDC placeholders so
	//    the assignment resolves before the user's first login.
	if err := ensureManagedUsers(ctx, tx, d, now); err != nil {
		return err
	}

	// 2. Upsert desired roles, then drop managed roles no longer desired (cascade
	//    removes their permissions, grants and group mappings).
	roleID := map[string]int64{}
	names := make([]string, 0, len(d.Roles))
	for _, r := range d.Roles {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO roles(name, description, created_at, managed) VALUES(?, ?, ?, 1)
             ON CONFLICT(name) DO UPDATE SET description = excluded.description, managed = 1`,
			r.Name, r.Description, now); err != nil {
			return fmt.Errorf("upsert role %q: %w", r.Name, err)
		}
		var id int64
		if err := tx.QueryRowContext(ctx, `SELECT id FROM roles WHERE name = ?`, r.Name).Scan(&id); err != nil {
			return err
		}
		roleID[r.Name] = id
		names = append(names, r.Name)
	}
	if err := deleteManagedRolesExcept(ctx, tx, names); err != nil {
		return err
	}

	// 3. Rebuild managed permissions.
	if _, err := tx.ExecContext(ctx, `DELETE FROM role_permissions WHERE managed = 1`); err != nil {
		return err
	}
	for _, r := range d.Roles {
		for _, p := range r.Permissions {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO role_permissions(role_id, repo_pattern, actions, managed) VALUES(?, ?, ?, 1)`,
				roleID[r.Name], p.RepoPattern, p.Actions); err != nil {
				return fmt.Errorf("add permission for role %q: %w", r.Name, err)
			}
		}
	}

	// 4. Rebuild managed user-role assignments.
	if _, err := tx.ExecContext(ctx, `DELETE FROM user_roles WHERE managed = 1`); err != nil {
		return err
	}
	for _, g := range d.UserRoles {
		uid, err := lookupUserID(ctx, tx, g.Subject)
		if err != nil {
			return err
		}
		rid, err := lookupRoleID(ctx, tx, roleID, g.Role)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO user_roles(user_id, role_id, managed) VALUES(?, ?, 1)
             ON CONFLICT(user_id, role_id) DO UPDATE SET managed = 1`, uid, rid); err != nil {
			return fmt.Errorf("assign role %q to %q: %w", g.Role, g.Subject, err)
		}
	}

	// 5. Rebuild managed group mappings.
	if _, err := tx.ExecContext(ctx, `DELETE FROM oidc_group_mappings WHERE managed = 1`); err != nil {
		return err
	}
	for _, g := range d.GroupRoles {
		rid, err := lookupRoleID(ctx, tx, roleID, g.Role)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO oidc_group_mappings(group_name, role_id, managed) VALUES(?, ?, 1)
             ON CONFLICT(group_name) DO UPDATE SET role_id = excluded.role_id, managed = 1`,
			g.Subject, rid); err != nil {
			return fmt.Errorf("map group %q to role %q: %w", g.Subject, g.Role, err)
		}
	}

	return tx.Commit()
}

func ensureManagedUsers(ctx context.Context, tx *sql.Tx, d ManagedRBAC, now string) error {
	// Local accounts first so a username appearing in both lists is created as a
	// local (password) user rather than an OIDC placeholder.
	for _, u := range d.LocalUsers {
		if err := ensureUser(ctx, tx, u.Username, u.PasswordHash, u.Email, SourceLocal, now); err != nil {
			return err
		}
	}
	for _, g := range d.UserRoles {
		if err := ensureUser(ctx, tx, g.Subject, "", "", SourceOIDC, now); err != nil {
			return err
		}
	}
	return nil
}

// ensureUser inserts a managed user if absent. An existing user (managed or not)
// is left as-is: its password, source and email are never overwritten.
func ensureUser(ctx context.Context, tx *sql.Tx, username, passwordHash, email, source, now string) error {
	var id int64
	err := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE username = ?`, username).Scan(&id)
	if err == nil {
		return nil
	}
	if err != sql.ErrNoRows {
		return err
	}
	_, err = tx.ExecContext(ctx,
		`INSERT INTO users(username, password_hash, source, email, disabled, created_at, updated_at, managed)
         VALUES(?, ?, ?, ?, 0, ?, ?, 1)`,
		username, passwordHash, source, email, now, now)
	return err
}

func lookupUserID(ctx context.Context, tx *sql.Tx, username string) (int64, error) {
	var id int64
	if err := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE username = ?`, username).Scan(&id); err != nil {
		return 0, fmt.Errorf("resolve user %q: %w", username, err)
	}
	return id, nil
}

func lookupRoleID(ctx context.Context, tx *sql.Tx, cache map[string]int64, name string) (int64, error) {
	if id, ok := cache[name]; ok {
		return id, nil
	}
	var id int64
	if err := tx.QueryRowContext(ctx, `SELECT id FROM roles WHERE name = ?`, name).Scan(&id); err != nil {
		return 0, fmt.Errorf("grant references unknown role %q: %w", name, err)
	}
	cache[name] = id
	return id, nil
}

func deleteManagedRolesExcept(ctx context.Context, tx *sql.Tx, keep []string) error {
	if len(keep) == 0 {
		_, err := tx.ExecContext(ctx, `DELETE FROM roles WHERE managed = 1`)
		return err
	}
	q := `DELETE FROM roles WHERE managed = 1 AND name NOT IN (` + placeholders(len(keep)) + `)`
	args := make([]any, len(keep))
	for i, n := range keep {
		args[i] = n
	}
	_, err := tx.ExecContext(ctx, q, args...)
	return err
}

func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// RoleManaged reports whether a role is managed by the declarative policy.
func (s *Store) RoleManaged(ctx context.Context, id int64) (bool, error) {
	return s.managedFlag(ctx, `SELECT managed FROM roles WHERE id = ?`, id)
}

// PermissionManaged reports whether a permission is managed.
func (s *Store) PermissionManaged(ctx context.Context, id int64) (bool, error) {
	return s.managedFlag(ctx, `SELECT managed FROM role_permissions WHERE id = ?`, id)
}

// GroupMappingManaged reports whether a group mapping is managed.
func (s *Store) GroupMappingManaged(ctx context.Context, id int64) (bool, error) {
	return s.managedFlag(ctx, `SELECT managed FROM oidc_group_mappings WHERE id = ?`, id)
}

func (s *Store) managedFlag(ctx context.Context, query string, id int64) (bool, error) {
	var managed int
	err := s.h().QueryRowContext(ctx, query, id).Scan(&managed)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return managed != 0, nil
}

// IsManagedUserRole reports whether a user's role assignment is managed by the
// declarative policy (and therefore read-only via the API).
func (s *Store) IsManagedUserRole(ctx context.Context, userID, roleID int64) (bool, error) {
	var managed int
	err := s.h().QueryRowContext(ctx,
		`SELECT managed FROM user_roles WHERE user_id = ? AND role_id = ?`, userID, roleID).Scan(&managed)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return managed != 0, nil
}
