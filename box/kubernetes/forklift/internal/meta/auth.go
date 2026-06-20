package meta

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// --- Users ---

// CreateUser inserts a user.
func (s *Store) CreateUser(ctx context.Context, u User) (User, error) {
	now := nowRFC3339()
	if u.Source == "" {
		u.Source = SourceLocal
	}
	res, err := s.h().ExecContext(ctx,
		`INSERT INTO users(username, password_hash, source, email, disabled, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
		u.Username, u.PasswordHash, u.Source, u.Email, boolToInt(u.Disabled), now, now)
	if err != nil {
		return User{}, err
	}
	id, _ := res.LastInsertId()
	return s.GetUser(ctx, id)
}

// EnsureUser upserts an OIDC user by username, returning the stored row. It is
// used at login to keep a local record of external identities.
func (s *Store) EnsureUser(ctx context.Context, username, email, source string) (User, error) {
	if u, err := s.GetUserByUsername(ctx, username); err == nil {
		return u, nil
	} else if !errors.Is(err, ErrNotFound) {
		return User{}, err
	}
	return s.CreateUser(ctx, User{Username: username, Email: email, Source: source})
}

// GetUser returns a user by ID.
func (s *Store) GetUser(ctx context.Context, id int64) (User, error) {
	return scanUser(s.h().QueryRowContext(ctx,
		`SELECT id, username, password_hash, source, email, disabled, created_at, updated_at, last_login_at, lockout_enabled, failed_login_count, locked_at FROM users WHERE id = ?`, id))
}

// GetUserByUsername returns a user by username.
func (s *Store) GetUserByUsername(ctx context.Context, username string) (User, error) {
	return scanUser(s.h().QueryRowContext(ctx,
		`SELECT id, username, password_hash, source, email, disabled, created_at, updated_at, last_login_at, lockout_enabled, failed_login_count, locked_at FROM users WHERE username = ?`, username))
}

// ListUsers returns all users ordered by username.
func (s *Store) ListUsers(ctx context.Context) ([]User, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT id, username, password_hash, source, email, disabled, created_at, updated_at, last_login_at, lockout_enabled, failed_login_count, locked_at FROM users ORDER BY username`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []User
	for rows.Next() {
		u, err := scanUserRows(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetPassword updates a user's password hash.
func (s *Store) SetPassword(ctx context.Context, id int64, hash string) error {
	res, err := s.h().ExecContext(ctx,
		`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, hash, nowRFC3339(), id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// TouchLastLogin records a successful interactive login. It deliberately does
// not bump updated_at, which tracks profile changes.
func (s *Store) TouchLastLogin(ctx context.Context, id int64) error {
	res, err := s.h().ExecContext(ctx,
		`UPDATE users SET last_login_at = ? WHERE id = ?`, nowRFC3339(), id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// SetUserDisabled toggles a user's disabled flag.
func (s *Store) SetUserDisabled(ctx context.Context, id int64, disabled bool) error {
	res, err := s.h().ExecContext(ctx,
		`UPDATE users SET disabled = ?, updated_at = ? WHERE id = ?`, boolToInt(disabled), nowRFC3339(), id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// SetLockoutEnabled toggles a user's failed-password lockout. Disabling it also
// clears any accumulated failure count and unlocks the account, so turning the
// feature off can never leave someone stuck locked out.
func (s *Store) SetLockoutEnabled(ctx context.Context, id int64, enabled bool) error {
	var res sql.Result
	var err error
	if enabled {
		res, err = s.h().ExecContext(ctx,
			`UPDATE users SET lockout_enabled = 1, updated_at = ? WHERE id = ?`,
			nowRFC3339(), id)
	} else {
		res, err = s.h().ExecContext(ctx,
			`UPDATE users SET lockout_enabled = 0, failed_login_count = 0, locked_at = '', updated_at = ? WHERE id = ?`,
			nowRFC3339(), id)
	}
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// RegisterFailedLogin records one failed local-password attempt. When the
// account opted into lockout and the running count reaches threshold, it sets
// locked_at (idempotent: an already-locked account keeps its original time).
func (s *Store) RegisterFailedLogin(ctx context.Context, id int64, threshold int) error {
	res, err := s.h().ExecContext(ctx,
		`UPDATE users
		    SET failed_login_count = failed_login_count + 1,
		        locked_at = CASE
		            WHEN lockout_enabled = 1 AND failed_login_count + 1 >= ? AND locked_at = ''
		                THEN ? ELSE locked_at END,
		        updated_at = ?
		  WHERE id = ?`,
		threshold, nowRFC3339(), nowRFC3339(), id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// ResetFailedLogin clears the failure count and unlocks the account. Called on a
// successful login and by an admin unlock action.
func (s *Store) ResetFailedLogin(ctx context.Context, id int64) error {
	res, err := s.h().ExecContext(ctx,
		`UPDATE users SET failed_login_count = 0, locked_at = '', updated_at = ? WHERE id = ?`,
		nowRFC3339(), id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// DeleteUser removes a user (cascading to roles and tokens).
func (s *Store) DeleteUser(ctx context.Context, id int64) error {
	res, err := s.h().ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// --- Roles & permissions ---

// CreateRole inserts a role.
func (s *Store) CreateRole(ctx context.Context, r Role) (Role, error) {
	res, err := s.h().ExecContext(ctx,
		`INSERT INTO roles(name, description, created_at) VALUES(?, ?, ?)`,
		r.Name, r.Description, nowRFC3339())
	if err != nil {
		return Role{}, err
	}
	id, _ := res.LastInsertId()
	r.ID = id
	return r, nil
}

// GetRoleByName returns a role by name.
func (s *Store) GetRoleByName(ctx context.Context, name string) (Role, error) {
	var r Role
	var created string
	var managed int
	err := s.h().QueryRowContext(ctx,
		`SELECT id, name, description, created_at, managed FROM roles WHERE name = ?`, name).
		Scan(&r.ID, &r.Name, &r.Description, &created, &managed)
	if errors.Is(err, sql.ErrNoRows) {
		return Role{}, ErrNotFound
	}
	if err != nil {
		return Role{}, err
	}
	r.CreatedAt = parseTime(created)
	r.Managed = managed != 0
	return r, nil
}

// ListRoles returns all roles.
func (s *Store) ListRoles(ctx context.Context) ([]Role, error) {
	rows, err := s.h().QueryContext(ctx, `SELECT id, name, description, created_at, managed FROM roles ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Role
	for rows.Next() {
		var r Role
		var created string
		var managed int
		if err := rows.Scan(&r.ID, &r.Name, &r.Description, &created, &managed); err != nil {
			return nil, err
		}
		r.CreatedAt = parseTime(created)
		r.Managed = managed != 0
		out = append(out, r)
	}
	return out, rows.Err()
}

// DeleteRole removes a role.
func (s *Store) DeleteRole(ctx context.Context, id int64) error {
	res, err := s.h().ExecContext(ctx, `DELETE FROM roles WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// AddPermission grants actions on a repo pattern to a role.
func (s *Store) AddPermission(ctx context.Context, p Permission) (Permission, error) {
	res, err := s.h().ExecContext(ctx,
		`INSERT INTO role_permissions(role_id, repo_pattern, actions) VALUES(?, ?, ?)`,
		p.RoleID, p.RepoPattern, p.Actions)
	if err != nil {
		return Permission{}, err
	}
	id, _ := res.LastInsertId()
	p.ID = id
	return p, nil
}

// ListPermissions returns every role permission (grouped by role in the API).
func (s *Store) ListPermissions(ctx context.Context) ([]Permission, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT id, role_id, repo_pattern, actions, managed FROM role_permissions ORDER BY id`)
	if err != nil {
		return nil, err
	}
	return scanPermissions(rows)
}

// DeletePermission removes one permission from a role.
func (s *Store) DeletePermission(ctx context.Context, roleID, id int64) error {
	res, err := s.h().ExecContext(ctx,
		`DELETE FROM role_permissions WHERE id = ? AND role_id = ?`, id, roleID)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// RolesByUser returns every user's assigned roles in one query, keyed by user
// ID. Used by the admin user list.
func (s *Store) RolesByUser(ctx context.Context) (map[int64][]Role, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT ur.user_id, r.id, r.name, r.description, r.created_at
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id ORDER BY r.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]Role{}
	for rows.Next() {
		var userID int64
		var r Role
		var created string
		if err := rows.Scan(&userID, &r.ID, &r.Name, &r.Description, &created); err != nil {
			return nil, err
		}
		r.CreatedAt = parseTime(created)
		out[userID] = append(out[userID], r)
	}
	return out, rows.Err()
}

// AssignRole grants a role to a user.
func (s *Store) AssignRole(ctx context.Context, userID, roleID int64) error {
	_, err := s.h().ExecContext(ctx,
		`INSERT INTO user_roles(user_id, role_id) VALUES(?, ?) ON CONFLICT DO NOTHING`, userID, roleID)
	return err
}

// RemoveRole revokes a role from a user.
func (s *Store) RemoveRole(ctx context.Context, userID, roleID int64) error {
	_, err := s.h().ExecContext(ctx, `DELETE FROM user_roles WHERE user_id = ? AND role_id = ?`, userID, roleID)
	return err
}

// PermissionsForUser returns the permissions granted to a user via their roles.
func (s *Store) PermissionsForUser(ctx context.Context, userID int64) ([]Permission, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT rp.id, rp.role_id, rp.repo_pattern, rp.actions, rp.managed
         FROM role_permissions rp
         JOIN user_roles ur ON ur.role_id = rp.role_id
         WHERE ur.user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	return scanPermissions(rows)
}

// PermissionsForRoleNames returns the permissions for a set of role names. It is
// used to resolve OIDC group-derived roles into permissions.
func (s *Store) PermissionsForRoleNames(ctx context.Context, names []string) ([]Permission, error) {
	if len(names) == 0 {
		return nil, nil
	}
	query := `SELECT rp.id, rp.role_id, rp.repo_pattern, rp.actions, rp.managed
              FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.name IN (`
	args := make([]any, len(names))
	for i, n := range names {
		if i > 0 {
			query += ","
		}
		query += "?"
		args[i] = n
	}
	query += ")"
	rows, err := s.h().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return scanPermissions(rows)
}

// --- OIDC group mappings ---

// CreateGroupMapping maps a group name to a role.
func (s *Store) CreateGroupMapping(ctx context.Context, groupName string, roleID int64) error {
	_, err := s.h().ExecContext(ctx,
		`INSERT INTO oidc_group_mappings(group_name, role_id) VALUES(?, ?)
         ON CONFLICT(group_name) DO UPDATE SET role_id = excluded.role_id`, groupName, roleID)
	return err
}

// ListGroupMappings returns all group-to-role mappings.
func (s *Store) ListGroupMappings(ctx context.Context) ([]GroupMapping, error) {
	rows, err := s.h().QueryContext(ctx, `SELECT id, group_name, role_id, managed FROM oidc_group_mappings ORDER BY group_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GroupMapping
	for rows.Next() {
		var g GroupMapping
		var managed int
		if err := rows.Scan(&g.ID, &g.GroupName, &g.RoleID, &managed); err != nil {
			return nil, err
		}
		g.Managed = managed != 0
		out = append(out, g)
	}
	return out, rows.Err()
}

// DeleteGroupMapping removes a mapping.
func (s *Store) DeleteGroupMapping(ctx context.Context, id int64) error {
	res, err := s.h().ExecContext(ctx, `DELETE FROM oidc_group_mappings WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// RoleNamesForGroups returns the role names mapped from the given group names.
func (s *Store) RoleNamesForGroups(ctx context.Context, groups []string) ([]string, error) {
	if len(groups) == 0 {
		return nil, nil
	}
	query := `SELECT r.name FROM oidc_group_mappings m JOIN roles r ON r.id = m.role_id WHERE m.group_name IN (`
	args := make([]any, len(groups))
	for i, g := range groups {
		if i > 0 {
			query += ","
		}
		query += "?"
		args[i] = g
	}
	query += ")"
	rows, err := s.h().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// --- Tokens (PAT) ---

// CreateToken stores a personal access token (hash only).
func (s *Store) CreateToken(ctx context.Context, t Token) (Token, error) {
	res, err := s.h().ExecContext(ctx,
		`INSERT INTO tokens(user_id, name, description, hash, scopes_json, expires_at, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?)`,
		t.UserID, t.Name, t.Description, t.Hash, t.ScopesJSON, formatTimePtr(t.ExpiresAt), nowRFC3339())
	if err != nil {
		return Token{}, err
	}
	id, _ := res.LastInsertId()
	t.ID = id
	return t, nil
}

// GetTokenByHash returns a token by its hash.
func (s *Store) GetTokenByHash(ctx context.Context, hash string) (Token, error) {
	var t Token
	var scopes string
	var expires, lastUsed sql.NullString
	var created string
	err := s.h().QueryRowContext(ctx,
		`SELECT id, user_id, name, hash, scopes_json, expires_at, last_used_at, created_at FROM tokens WHERE hash = ?`, hash).
		Scan(&t.ID, &t.UserID, &t.Name, &t.Hash, &scopes, &expires, &lastUsed, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return Token{}, ErrNotFound
	}
	if err != nil {
		return Token{}, err
	}
	t.ScopesJSON = scopes
	t.ExpiresAt = nullTimePtr(expires)
	t.LastUsedAt = nullTimePtr(lastUsed)
	t.CreatedAt = parseTime(created)
	return t, nil
}

// ListTokens returns a user's tokens (without the hash).
func (s *Store) ListTokens(ctx context.Context, userID int64) ([]Token, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT id, user_id, name, description, '' , scopes_json, expires_at, last_used_at, created_at FROM tokens WHERE user_id = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		var t Token
		var scopes string
		var expires, lastUsed sql.NullString
		var created string
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.Description, &t.Hash, &scopes, &expires, &lastUsed, &created); err != nil {
			return nil, err
		}
		t.ScopesJSON = scopes
		t.ExpiresAt = nullTimePtr(expires)
		t.LastUsedAt = nullTimePtr(lastUsed)
		t.CreatedAt = parseTime(created)
		out = append(out, t)
	}
	return out, rows.Err()
}

// ListAllTokens returns every token across users (admin views), with scopes,
// owner id and expiry, so the API can surface which tokens reach a repository.
func (s *Store) ListAllTokens(ctx context.Context) ([]Token, error) {
	rows, err := s.h().QueryContext(ctx,
		`SELECT id, user_id, name, description, '', scopes_json, expires_at, last_used_at, created_at FROM tokens ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		var t Token
		var scopes string
		var expires, lastUsed sql.NullString
		var created string
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.Description, &t.Hash, &scopes, &expires, &lastUsed, &created); err != nil {
			return nil, err
		}
		t.ScopesJSON = scopes
		t.ExpiresAt = nullTimePtr(expires)
		t.LastUsedAt = nullTimePtr(lastUsed)
		t.CreatedAt = parseTime(created)
		out = append(out, t)
	}
	return out, rows.Err()
}

// TouchToken records the last-used time of a token.
func (s *Store) TouchToken(ctx context.Context, id int64) error {
	_, err := s.h().ExecContext(ctx, `UPDATE tokens SET last_used_at = ? WHERE id = ?`, nowRFC3339(), id)
	return err
}

// DeleteToken removes a token owned by userID.
func (s *Store) DeleteToken(ctx context.Context, userID, id int64) error {
	res, err := s.h().ExecContext(ctx, `DELETE FROM tokens WHERE id = ? AND user_id = ?`, id, userID)
	if err != nil {
		return err
	}
	return ensureAffected(res)
}

// CountUsers returns the number of users (used for first-run bootstrap).
func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.h().QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

// --- scan helpers ---

func scanUser(row *sql.Row) (User, error) {
	var u User
	var disabled, lockoutEnabled int
	var created, updated, lastLogin, lockedAt string
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Source, &u.Email, &disabled, &created, &updated, &lastLogin, &lockoutEnabled, &u.FailedLoginCount, &lockedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, err
	}
	u.Disabled = disabled != 0
	u.CreatedAt = parseTime(created)
	u.UpdatedAt = parseTime(updated)
	u.LastLoginAt = parseTime(lastLogin)
	u.LockoutEnabled = lockoutEnabled != 0
	u.LockedAt = parseTime(lockedAt)
	return u, nil
}

func scanUserRows(rows *sql.Rows) (User, error) {
	var u User
	var disabled, lockoutEnabled int
	var created, updated, lastLogin, lockedAt string
	if err := rows.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.Source, &u.Email, &disabled, &created, &updated, &lastLogin, &lockoutEnabled, &u.FailedLoginCount, &lockedAt); err != nil {
		return User{}, err
	}
	u.Disabled = disabled != 0
	u.CreatedAt = parseTime(created)
	u.UpdatedAt = parseTime(updated)
	u.LastLoginAt = parseTime(lastLogin)
	u.LockoutEnabled = lockoutEnabled != 0
	u.LockedAt = parseTime(lockedAt)
	return u, nil
}

func scanPermissions(rows *sql.Rows) ([]Permission, error) {
	defer rows.Close()
	var out []Permission
	for rows.Next() {
		var p Permission
		var managed int
		if err := rows.Scan(&p.ID, &p.RoleID, &p.RepoPattern, &p.Actions, &managed); err != nil {
			return nil, err
		}
		p.Managed = managed != 0
		out = append(out, p)
	}
	return out, rows.Err()
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullTimePtr(ns sql.NullString) *time.Time {
	if !ns.Valid || ns.String == "" {
		return nil
	}
	t := parseTime(ns.String)
	return &t
}
