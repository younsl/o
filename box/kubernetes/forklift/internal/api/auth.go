package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// --- session ---

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	if h.authz == nil {
		writeError(w, http.StatusNotFound, "auth disabled")
		return
	}
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	u, err := h.authz.AuthenticateLocal(r.Context(), req.Username, req.Password)
	if err != nil {
		if errors.Is(err, auth.ErrAccountLocked) {
			writeError(w, http.StatusForbidden, "account locked: too many failed attempts, contact an administrator")
			return
		}
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	// Best-effort: a bookkeeping failure must not block the login.
	if err := h.store.TouchLastLogin(r.Context(), u.ID); err != nil {
		h.log.Warn("record last login", "user", u.Username, "err", err)
	}
	value, err := h.authz.IssueSession(u.Username, u.Source, nil)
	if err != nil {
		mapError(w, err)
		return
	}
	auth.SetSessionCookie(w, value, isSecure(r))
	writeJSON(w, http.StatusOK, map[string]string{"username": u.Username, "source": u.Source})
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	auth.ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) me(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"authenticated": true,
		"username":      p.Username,
		"source":        p.Source,
		"admin":         p.IsAdmin(),
		"approver":      p.IsAdmin() || p.CanApproveAny(),
		"auditor":       p.IsAdmin() || p.CanAuditAny(),
	})
}

// --- tokens (PAT, self-service) ---

type createTokenReq struct {
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Scopes      []auth.Scope `json:"scopes"`
	ExpiresIn   string       `json:"expires_in"` // e.g. "720h", required, at most one year
}

// maxTokenTTL caps personal access token lifetime at one year.
const maxTokenTTL = 365 * 24 * time.Hour

func (h *Handler) listTokens(w http.ResponseWriter, r *http.Request) {
	u, ok := h.currentUser(w, r)
	if !ok {
		return
	}
	tokens, err := h.store.ListTokens(r.Context(), u.ID)
	if err != nil {
		mapError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(tokens))
	for _, t := range tokens {
		out = append(out, tokenSummary(t))
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) createToken(w http.ResponseWriter, r *http.Request) {
	u, ok := h.currentUser(w, r)
	if !ok {
		return
	}
	h.issueToken(w, r, u.ID)
}

// validateTokenReq checks a create-token request and returns the parsed expiry
// and serialized scopes. A non-empty msg means the request is invalid (the
// caller should respond 400 with it).
func validateTokenReq(req createTokenReq) (expiresAt time.Time, scopesJSON, msg string) {
	if !validName(strings.TrimSpace(req.Name)) {
		return time.Time{}, "", "invalid token name: " + nameRuleMsg
	}
	if strings.TrimSpace(req.Description) == "" {
		return time.Time{}, "", "token description required"
	}
	if len(req.Scopes) == 0 {
		return time.Time{}, "", "at least one scope required"
	}
	for _, s := range req.Scopes {
		if strings.TrimSpace(s.RepoPattern) == "" {
			return time.Time{}, "", "scope repo_pattern required"
		}
		if len(s.Actions) == 0 {
			return time.Time{}, "", "scope actions required"
		}
		for _, a := range s.Actions {
			switch a {
			case auth.ActionRead, auth.ActionWrite, auth.ActionDelete:
			default:
				return time.Time{}, "", "invalid scope action: " + a
			}
		}
	}
	if req.ExpiresIn == "" {
		return time.Time{}, "", "expires_in required"
	}
	d, err := time.ParseDuration(req.ExpiresIn)
	if err != nil || d <= 0 {
		return time.Time{}, "", "invalid expires_in"
	}
	if d > maxTokenTTL {
		return time.Time{}, "", "expires_in exceeds the one year maximum"
	}
	b, _ := json.Marshal(req.Scopes)
	return time.Now().Add(d), string(b), ""
}

// issueToken validates the request body and creates a personal access token
// owned by userID, returning the plaintext exactly once. It is shared by the
// self-service create (current user) and the admin create (a target user).
// Token scopes only ever narrow the owner's role permissions (enforced at auth
// time via Principal.Can), so an admin issuing a token cannot escalate the
// target user's effective access.
func (h *Handler) issueToken(w http.ResponseWriter, r *http.Request, userID int64) {
	var req createTokenReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	expiresAt, scopesJSON, msg := validateTokenReq(req)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	plaintext, hash, err := auth.GenerateToken()
	if err != nil {
		mapError(w, err)
		return
	}
	t, err := h.store.CreateToken(r.Context(), meta.Token{
		UserID: userID, Name: req.Name, Description: req.Description,
		Hash: hash, ScopesJSON: scopesJSON, ExpiresAt: &expiresAt,
	})
	if err != nil {
		mapError(w, err)
		return
	}
	// The plaintext is returned exactly once.
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": t.ID, "name": t.Name, "description": t.Description, "token": plaintext, "expires_at": t.ExpiresAt,
	})
}

func (h *Handler) deleteToken(w http.ResponseWriter, r *http.Request) {
	u, ok := h.currentUser(w, r)
	if !ok {
		return
	}
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if err := h.store.DeleteToken(r.Context(), u.ID, id); err != nil {
		mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- user tokens (admin/auditor) ---
//
// The per-user token endpoints let an administrator manage another user's
// personal access tokens from that user's detail page; an auditor may list them
// read-only. They reuse the user-id-keyed store methods, so a token is always
// scoped to (and deletable only within) the target user.

// tokenSummary is the list shape for a token, hash and plaintext excluded.
func tokenSummary(t meta.Token) map[string]any {
	return map[string]any{
		"id": t.ID, "name": t.Name, "description": t.Description, "scopes_json": t.ScopesJSON,
		"expires_at": t.ExpiresAt, "last_used_at": t.LastUsedAt, "created_at": t.CreatedAt,
	}
}

func (h *Handler) listUserTokens(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := h.store.GetUser(r.Context(), id); err != nil {
		mapError(w, err)
		return
	}
	tokens, err := h.store.ListTokens(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(tokens))
	for _, t := range tokens {
		out = append(out, tokenSummary(t))
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) createUserToken(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if _, err := h.store.GetUser(r.Context(), id); err != nil {
		mapError(w, err)
		return
	}
	h.issueToken(w, r, id)
}

func (h *Handler) deleteUserToken(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	tokenID, err := parseID(chi.URLParam(r, "tokenID"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid token id")
		return
	}
	if err := h.store.DeleteToken(r.Context(), id, tokenID); err != nil {
		mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- users (admin) ---

type createUserReq struct {
	Username string  `json:"username"`
	Password string  `json:"password"`
	Email    string  `json:"email"`
	RoleIDs  []int64 `json:"role_ids"`
}

type roleRefDTO struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type userDTO struct {
	ID          int64        `json:"id"`
	Username    string       `json:"username"`
	Source      string       `json:"source"`
	Email       string       `json:"email"`
	Disabled    bool         `json:"disabled"`
	CreatedAt   time.Time    `json:"created_at"`
	LastLoginAt *time.Time   `json:"last_login_at"` // null when the user has never logged in
	Roles       []roleRefDTO `json:"roles"`
	// Account lockout fields.
	LockoutEnabled bool `json:"lockout_enabled"`
	Locked         bool `json:"locked"`
	// Protected is true for the bootstrap admin, which cannot be locked out and
	// whose lockout toggle is disabled in the UI.
	Protected bool `json:"protected"`
}

func (h *Handler) toUserDTO(u meta.User, roles []meta.Role) userDTO {
	refs := make([]roleRefDTO, 0, len(roles))
	for _, r := range roles {
		refs = append(refs, roleRefDTO{ID: r.ID, Name: r.Name})
	}
	var lastLogin *time.Time
	if !u.LastLoginAt.IsZero() {
		lastLogin = &u.LastLoginAt
	}
	return userDTO{
		ID: u.ID, Username: u.Username, Source: u.Source,
		Email: u.Email, Disabled: u.Disabled, CreatedAt: u.CreatedAt,
		LastLoginAt: lastLogin, Roles: refs,
		LockoutEnabled: u.LockoutEnabled, Locked: u.Locked(),
		Protected: h.authz != nil && h.authz.IsProtectedAdmin(u.Username),
	}
}

func (h *Handler) listUsers(w http.ResponseWriter, r *http.Request) {
	users, err := h.store.ListUsers(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	rolesBy, err := h.store.RolesByUser(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	out := make([]userDTO, 0, len(users))
	for _, u := range users {
		out = append(out, h.toUserDTO(u, rolesBy[u.ID]))
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) createUser(w http.ResponseWriter, r *http.Request) {
	var req createUserReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if req.Password == "" {
		writeError(w, http.StatusBadRequest, "username and password required")
		return
	}
	if !validName(strings.TrimSpace(req.Username)) {
		writeError(w, http.StatusBadRequest, "invalid username: "+nameRuleMsg)
		return
	}
	// Validate any requested roles before creating the user so a bad role id
	// fails cleanly instead of leaving a roleless user behind.
	if len(req.RoleIDs) > 0 {
		roles, err := h.store.ListRoles(r.Context())
		if err != nil {
			mapError(w, err)
			return
		}
		valid := make(map[int64]bool, len(roles))
		for _, role := range roles {
			valid[role.ID] = true
		}
		for _, rid := range req.RoleIDs {
			if !valid[rid] {
				writeError(w, http.StatusBadRequest, "unknown role id")
				return
			}
		}
	}
	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		mapError(w, err)
		return
	}
	u, err := h.store.CreateUser(r.Context(), meta.User{
		Username: req.Username, PasswordHash: hash, Source: meta.SourceLocal, Email: req.Email,
	})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeError(w, http.StatusConflict, "username already exists")
			return
		}
		mapError(w, err)
		return
	}
	// New local accounts get failed-password lockout on by default; an admin can
	// turn it off from the user's detail page. The protected admin is exempt.
	if h.authz == nil || !h.authz.IsProtectedAdmin(u.Username) {
		if err := h.store.SetLockoutEnabled(r.Context(), u.ID, true); err != nil {
			mapError(w, err)
			return
		}
	}
	for _, rid := range req.RoleIDs {
		if err := h.store.AssignRole(r.Context(), u.ID, rid); err != nil {
			mapError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": u.ID, "username": u.Username})
}

// updateUserReq carries admin edits; nil fields are left unchanged.
type updateUserReq struct {
	Password       *string `json:"password"`
	Disabled       *bool   `json:"disabled"`
	LockoutEnabled *bool   `json:"lockout_enabled"`
	Unlock         *bool   `json:"unlock"`
}

func (h *Handler) updateUser(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req updateUserReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	target, err := h.store.GetUser(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}

	if req.Disabled != nil {
		if *req.Disabled && h.authz != nil && h.authz.IsProtectedAdmin(target.Username) {
			writeError(w, http.StatusBadRequest, "cannot disable the default admin account")
			return
		}
		if h.isSelf(r, id) && *req.Disabled {
			writeError(w, http.StatusBadRequest, "cannot disable your own account")
			return
		}
		if err := h.store.SetUserDisabled(r.Context(), id, *req.Disabled); err != nil {
			mapError(w, err)
			return
		}
	}
	if req.Password != nil {
		if target.Source != meta.SourceLocal {
			writeError(w, http.StatusBadRequest, "cannot set a password for an OIDC user")
			return
		}
		if *req.Password == "" {
			writeError(w, http.StatusBadRequest, "password must not be empty")
			return
		}
		hash, err := auth.HashPassword(*req.Password)
		if err != nil {
			mapError(w, err)
			return
		}
		if err := h.store.SetPassword(r.Context(), id, hash); err != nil {
			mapError(w, err)
			return
		}
	}
	if req.LockoutEnabled != nil {
		if *req.LockoutEnabled && target.Source != meta.SourceLocal {
			writeError(w, http.StatusBadRequest, "lockout applies only to local-password accounts")
			return
		}
		if *req.LockoutEnabled && h.authz != nil && h.authz.IsProtectedAdmin(target.Username) {
			writeError(w, http.StatusBadRequest, "cannot enable lockout for the default admin account")
			return
		}
		if err := h.store.SetLockoutEnabled(r.Context(), id, *req.LockoutEnabled); err != nil {
			mapError(w, err)
			return
		}
	}
	if req.Unlock != nil && *req.Unlock {
		if err := h.store.ResetFailedLogin(r.Context(), id); err != nil {
			mapError(w, err)
			return
		}
	}

	target, err = h.store.GetUser(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	rolesBy, err := h.store.RolesByUser(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, h.toUserDTO(target, rolesBy[id]))
}

func (h *Handler) deleteUser(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if h.isSelf(r, id) {
		writeError(w, http.StatusBadRequest, "cannot delete your own account")
		return
	}
	if err := h.store.DeleteUser(r.Context(), id); err != nil {
		mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// isSelf reports whether the request principal is the user with the given ID.
func (h *Handler) isSelf(r *http.Request, id int64) bool {
	p := auth.FromContext(r.Context())
	if p == nil {
		return false
	}
	u, err := h.store.GetUserByUsername(r.Context(), p.Username)
	return err == nil && u.ID == id
}

type assignRoleReq struct {
	RoleID int64 `json:"role_id"`
}

func (h *Handler) assignRole(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req assignRoleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := h.store.AssignRole(r.Context(), id, req.RoleID); err != nil {
		mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) removeRole(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	roleID, err := parseID(chi.URLParam(r, "roleID"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid role id")
		return
	}
	if managed, err := h.store.IsManagedUserRole(r.Context(), id, roleID); err != nil {
		mapError(w, err)
		return
	} else if managed {
		writeError(w, http.StatusConflict, managedRoleMsg)
		return
	}
	if err := h.store.RemoveRole(r.Context(), id, roleID); err != nil {
		mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- roles & permissions (admin) ---

type createRoleReq struct {
	Name        string             `json:"name"`
	Description string             `json:"description"`
	Permissions []addPermissionReq `json:"permissions"`
}

// validRoleAction reports whether a is a grantable permission action.
func validRoleAction(a string) bool {
	switch a {
	case auth.ActionRead, auth.ActionWrite, auth.ActionDelete, auth.ActionApprove, auth.ActionAudit, auth.ActionAdmin:
		return true
	}
	return false
}

// managedRoleMsg is returned when a client tries to mutate an entity owned by
// the declarative RBAC policy. Such entities are reconciled from the chart and
// are read-only via the API; change them in the chart values instead.
const managedRoleMsg = "managed by declarative RBAC policy; edit the chart values instead"

type permissionDTO struct {
	ID          int64    `json:"id"`
	RepoPattern string   `json:"repo_pattern"`
	Actions     []string `json:"actions"`
}

type roleDTO struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	CreatedAt   time.Time       `json:"created_at"`
	Managed     bool            `json:"managed"`
	Permissions []permissionDTO `json:"permissions"`
	// UserCount is how many users are assigned this role.
	UserCount int `json:"user_count"`
}

func toRoleDTO(r meta.Role, perms []meta.Permission, userCount int) roleDTO {
	out := roleDTO{
		ID: r.ID, Name: r.Name, Description: r.Description, CreatedAt: r.CreatedAt,
		Managed:     r.Managed,
		Permissions: make([]permissionDTO, 0, len(perms)),
		UserCount:   userCount,
	}
	for _, p := range perms {
		out.Permissions = append(out.Permissions, permissionDTO{
			ID: p.ID, RepoPattern: p.RepoPattern, Actions: strings.Split(p.Actions, ","),
		})
	}
	return out
}

func (h *Handler) listRoles(w http.ResponseWriter, r *http.Request) {
	roles, err := h.store.ListRoles(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	perms, err := h.store.ListPermissions(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	byRole := map[int64][]meta.Permission{}
	for _, p := range perms {
		byRole[p.RoleID] = append(byRole[p.RoleID], p)
	}
	rolesBy, err := h.store.RolesByUser(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	userCount := map[int64]int{}
	for _, urs := range rolesBy {
		for _, ur := range urs {
			userCount[ur.ID]++
		}
	}
	out := make([]roleDTO, 0, len(roles))
	for _, role := range roles {
		out = append(out, toRoleDTO(role, byRole[role.ID], userCount[role.ID]))
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) createRole(w http.ResponseWriter, r *http.Request) {
	var req createRoleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || !validName(strings.TrimSpace(req.Name)) {
		writeError(w, http.StatusBadRequest, "invalid role name: "+nameRuleMsg)
		return
	}
	// Validate any inline permissions before creating the role so a bad grant
	// fails cleanly instead of leaving a permissionless role behind.
	for _, p := range req.Permissions {
		if strings.TrimSpace(p.RepoPattern) == "" || len(p.Actions) == 0 {
			writeError(w, http.StatusBadRequest, "repo_pattern and actions required")
			return
		}
		for _, a := range p.Actions {
			if !validRoleAction(a) {
				writeError(w, http.StatusBadRequest, "invalid action: "+a)
				return
			}
		}
	}
	role, err := h.store.CreateRole(r.Context(), meta.Role{Name: req.Name, Description: req.Description})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeError(w, http.StatusConflict, "role already exists")
			return
		}
		mapError(w, err)
		return
	}
	perms := make([]meta.Permission, 0, len(req.Permissions))
	for _, p := range req.Permissions {
		added, err := h.store.AddPermission(r.Context(), meta.Permission{
			RoleID: role.ID, RepoPattern: strings.TrimSpace(p.RepoPattern), Actions: strings.Join(p.Actions, ","),
		})
		if err != nil {
			mapError(w, err)
			return
		}
		perms = append(perms, added)
	}
	// A freshly created role has no users assigned yet.
	writeJSON(w, http.StatusCreated, toRoleDTO(role, perms, 0))
}

func (h *Handler) deleteRole(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if managed, err := h.store.RoleManaged(r.Context(), id); err != nil {
		mapError(w, err)
		return
	} else if managed {
		writeError(w, http.StatusConflict, managedRoleMsg)
		return
	}
	if err := h.store.DeleteRole(r.Context(), id); err != nil {
		mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type addPermissionReq struct {
	RepoPattern string   `json:"repo_pattern"`
	Actions     []string `json:"actions"`
}

func (h *Handler) addPermission(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if managed, err := h.store.RoleManaged(r.Context(), id); err != nil {
		mapError(w, err)
		return
	} else if managed {
		writeError(w, http.StatusConflict, managedRoleMsg)
		return
	}
	var req addPermissionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RepoPattern == "" || len(req.Actions) == 0 {
		writeError(w, http.StatusBadRequest, "repo_pattern and actions required")
		return
	}
	for _, a := range req.Actions {
		if !validRoleAction(a) {
			writeError(w, http.StatusBadRequest, "invalid action: "+a)
			return
		}
	}
	p, err := h.store.AddPermission(r.Context(), meta.Permission{
		RoleID: id, RepoPattern: req.RepoPattern, Actions: strings.Join(req.Actions, ","),
	})
	if err != nil {
		mapError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, permissionDTO{
		ID: p.ID, RepoPattern: p.RepoPattern, Actions: req.Actions,
	})
}

func (h *Handler) deletePermission(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	permID, err := parseID(chi.URLParam(r, "permID"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid permission id")
		return
	}
	if managed, err := h.store.PermissionManaged(r.Context(), permID); err != nil {
		mapError(w, err)
		return
	} else if managed {
		writeError(w, http.StatusConflict, managedRoleMsg)
		return
	}
	if err := h.store.DeletePermission(r.Context(), id, permID); err != nil {
		mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// --- group mappings (admin) ---

type createGroupMappingReq struct {
	GroupName string `json:"group_name"`
	RoleID    int64  `json:"role_id"`
}

func (h *Handler) listGroupMappings(w http.ResponseWriter, r *http.Request) {
	gm, err := h.store.ListGroupMappings(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, gm)
}

func (h *Handler) createGroupMapping(w http.ResponseWriter, r *http.Request) {
	var req createGroupMappingReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.GroupName) == "" {
		writeError(w, http.StatusBadRequest, "group_name and role_id required")
		return
	}
	if err := h.store.CreateGroupMapping(r.Context(), req.GroupName, req.RoleID); err != nil {
		mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

func (h *Handler) deleteGroupMapping(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	if managed, err := h.store.GroupMappingManaged(r.Context(), id); err != nil {
		mapError(w, err)
		return
	} else if managed {
		writeError(w, http.StatusConflict, managedRoleMsg)
		return
	}
	if err := h.store.DeleteGroupMapping(r.Context(), id); err != nil {
		mapError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// currentUser loads the meta.User for the request principal.
func (h *Handler) currentUser(w http.ResponseWriter, r *http.Request) (meta.User, bool) {
	p := auth.FromContext(r.Context())
	if p == nil {
		auth.Unauthorized(w)
		return meta.User{}, false
	}
	u, err := h.store.GetUserByUsername(r.Context(), p.Username)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "unknown user")
		return meta.User{}, false
	}
	return u, true
}

func isSecure(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}
