package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
)

func decodeAs[T any](t *testing.T, resp *http.Response) T {
	t.Helper()
	defer resp.Body.Close()
	var v T
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return v
}

func mustStatus(t *testing.T, resp *http.Response, want int) {
	t.Helper()
	if resp.StatusCode != want {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("status = %d, want %d (body=%s)", resp.StatusCode, want, b)
	}
}

func TestUserAdminLifecycle(t *testing.T) {
	srv := newTestServer(t)

	// Create a user and a role with one permission.
	resp := adminDo(t, http.MethodPost, srv.URL+"/users",
		`{"username":"dev1","password":"pw123456","email":"dev1@example.com"}`)
	mustStatus(t, resp, http.StatusCreated)
	created := decodeAs[map[string]any](t, resp)
	userID := int64(created["id"].(float64))

	resp = adminDo(t, http.MethodPost, srv.URL+"/roles",
		`{"name":"readers","description":"read everything"}`)
	mustStatus(t, resp, http.StatusCreated)
	role := decodeAs[roleDTO](t, resp)

	resp = adminDo(t, http.MethodPost, fmt.Sprintf("%s/roles/%d/permissions", srv.URL, role.ID),
		`{"repo_pattern":"*","actions":["read"]}`)
	mustStatus(t, resp, http.StatusCreated)
	perm := decodeAs[permissionDTO](t, resp)

	// Assign the role; the user list must reflect it.
	resp = adminDo(t, http.MethodPost, fmt.Sprintf("%s/users/%d/roles", srv.URL, userID),
		fmt.Sprintf(`{"role_id":%d}`, role.ID))
	mustStatus(t, resp, http.StatusNoContent)
	resp.Body.Close()

	resp = adminDo(t, http.MethodGet, srv.URL+"/users", "")
	mustStatus(t, resp, http.StatusOK)
	users := decodeAs[[]userDTO](t, resp)
	var dev1 *userDTO
	for i := range users {
		if users[i].Username == "dev1" {
			dev1 = &users[i]
		}
	}
	if dev1 == nil || len(dev1.Roles) != 1 || dev1.Roles[0].Name != "readers" {
		t.Fatalf("dev1 = %+v, want role readers", dev1)
	}

	// Roles list includes the permission.
	resp = adminDo(t, http.MethodGet, srv.URL+"/roles", "")
	mustStatus(t, resp, http.StatusOK)
	roles := decodeAs[[]roleDTO](t, resp)
	var readers *roleDTO
	for i := range roles {
		if roles[i].Name == "readers" {
			readers = &roles[i]
		}
	}
	if readers == nil || len(readers.Permissions) != 1 ||
		readers.Permissions[0].RepoPattern != "*" || readers.Permissions[0].Actions[0] != "read" {
		t.Fatalf("readers = %+v", readers)
	}
	if readers.UserCount != 1 {
		t.Fatalf("readers user_count = %d, want 1", readers.UserCount)
	}

	// Disable, then re-enable, then reset the password.
	resp = adminDo(t, http.MethodPut, fmt.Sprintf("%s/users/%d", srv.URL, userID), `{"disabled":true}`)
	mustStatus(t, resp, http.StatusOK)
	if u := decodeAs[userDTO](t, resp); !u.Disabled {
		t.Fatalf("user not disabled: %+v", u)
	}
	resp = adminDo(t, http.MethodPut, fmt.Sprintf("%s/users/%d", srv.URL, userID),
		`{"disabled":false,"password":"new-pw-123"}`)
	mustStatus(t, resp, http.StatusOK)
	if u := decodeAs[userDTO](t, resp); u.Disabled {
		t.Fatalf("user still disabled: %+v", u)
	}

	// Remove the permission and the role assignment.
	resp = adminDo(t, http.MethodDelete,
		fmt.Sprintf("%s/roles/%d/permissions/%d", srv.URL, role.ID, perm.ID), "")
	mustStatus(t, resp, http.StatusNoContent)
	resp.Body.Close()
	resp = adminDo(t, http.MethodDelete,
		fmt.Sprintf("%s/users/%d/roles/%d", srv.URL, userID, role.ID), "")
	mustStatus(t, resp, http.StatusNoContent)
	resp.Body.Close()

	// Delete the user.
	resp = adminDo(t, http.MethodDelete, fmt.Sprintf("%s/users/%d", srv.URL, userID), "")
	mustStatus(t, resp, http.StatusNoContent)
	resp.Body.Close()
}

// TestCreateUserWithRoles covers assigning roles at creation time: a valid role
// is applied, and an unknown role id is rejected before the user is created.
func TestCreateUserWithRoles(t *testing.T) {
	srv := newTestServer(t)

	resp := adminDo(t, http.MethodPost, srv.URL+"/roles",
		`{"name":"readers","description":"read everything"}`)
	mustStatus(t, resp, http.StatusCreated)
	role := decodeAs[roleDTO](t, resp)

	// Create a user with the role attached.
	resp = adminDo(t, http.MethodPost, srv.URL+"/users",
		fmt.Sprintf(`{"username":"dev1","password":"pw123456","role_ids":[%d]}`, role.ID))
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()

	resp = adminDo(t, http.MethodGet, srv.URL+"/users", "")
	users := decodeAs[[]userDTO](t, resp)
	var dev1 *userDTO
	for i := range users {
		if users[i].Username == "dev1" {
			dev1 = &users[i]
		}
	}
	if dev1 == nil || len(dev1.Roles) != 1 || dev1.Roles[0].Name != "readers" {
		t.Fatalf("dev1 = %+v, want role readers at creation", dev1)
	}

	// Unknown role id is rejected, and no such user is created.
	resp = adminDo(t, http.MethodPost, srv.URL+"/users",
		`{"username":"dev2","password":"pw123456","role_ids":[99999]}`)
	mustStatus(t, resp, http.StatusBadRequest)
	resp.Body.Close()

	resp = adminDo(t, http.MethodGet, srv.URL+"/users", "")
	for _, u := range decodeAs[[]userDTO](t, resp) {
		if u.Username == "dev2" {
			t.Fatal("dev2 should not have been created with an invalid role")
		}
	}
}

// TestCreateRoleWithPermissions covers granting permissions at role creation:
// valid grants are applied, and an invalid action is rejected before the role
// is created.
func TestCreateRoleWithPermissions(t *testing.T) {
	srv := newTestServer(t)

	resp := adminDo(t, http.MethodPost, srv.URL+"/roles",
		`{"name":"maven-readers","description":"read maven","permissions":[{"repo_pattern":"maven-*","actions":["read"]}]}`)
	mustStatus(t, resp, http.StatusCreated)
	role := decodeAs[roleDTO](t, resp)
	if len(role.Permissions) != 1 || role.Permissions[0].RepoPattern != "maven-*" ||
		role.Permissions[0].Actions[0] != "read" {
		t.Fatalf("role = %+v, want one maven-* read permission", role)
	}

	// Invalid action is rejected, and no such role is created.
	resp = adminDo(t, http.MethodPost, srv.URL+"/roles",
		`{"name":"bad-role","permissions":[{"repo_pattern":"*","actions":["superuser"]}]}`)
	mustStatus(t, resp, http.StatusBadRequest)
	resp.Body.Close()

	resp = adminDo(t, http.MethodGet, srv.URL+"/roles", "")
	for _, r := range decodeAs[[]roleDTO](t, resp) {
		if r.Name == "bad-role" {
			t.Fatal("bad-role should not have been created with an invalid action")
		}
	}
}

func TestUserSelfGuards(t *testing.T) {
	srv := newTestServer(t)

	// Find the admin's own user ID.
	resp := adminDo(t, http.MethodGet, srv.URL+"/users", "")
	mustStatus(t, resp, http.StatusOK)
	users := decodeAs[[]userDTO](t, resp)
	if len(users) != 1 || users[0].Username != adminUser {
		t.Fatalf("users = %+v", users)
	}
	adminID := users[0].ID

	// Self-delete and self-disable are rejected.
	resp = adminDo(t, http.MethodDelete, fmt.Sprintf("%s/users/%d", srv.URL, adminID), "")
	mustStatus(t, resp, http.StatusBadRequest)
	resp.Body.Close()
	resp = adminDo(t, http.MethodPut, fmt.Sprintf("%s/users/%d", srv.URL, adminID), `{"disabled":true}`)
	mustStatus(t, resp, http.StatusBadRequest)
	resp.Body.Close()
}

func TestUpdateUserValidation(t *testing.T) {
	srv := newTestServer(t)

	// Unknown user -> 404.
	resp := adminDo(t, http.MethodPut, srv.URL+"/users/9999", `{"disabled":true}`)
	mustStatus(t, resp, http.StatusNotFound)
	resp.Body.Close()

	// Empty password -> 400.
	resp = adminDo(t, http.MethodPost, srv.URL+"/users",
		`{"username":"dev2","password":"pw123456"}`)
	mustStatus(t, resp, http.StatusCreated)
	created := decodeAs[map[string]any](t, resp)
	id := int64(created["id"].(float64))

	resp = adminDo(t, http.MethodPut, fmt.Sprintf("%s/users/%d", srv.URL, id), `{"password":""}`)
	mustStatus(t, resp, http.StatusBadRequest)
	resp.Body.Close()
}

func TestUserLockoutToggle(t *testing.T) {
	srv := newTestServer(t)

	resp := adminDo(t, http.MethodPost, srv.URL+"/users",
		`{"username":"lockme","password":"pw123456"}`)
	mustStatus(t, resp, http.StatusCreated)
	id := int64(decodeAs[map[string]any](t, resp)["id"].(float64))

	// New users get lockout enabled by default.
	resp = adminDo(t, http.MethodGet, srv.URL+"/users", "")
	var created *userDTO
	for _, u := range decodeAs[[]userDTO](t, resp) {
		if u.Username == "lockme" {
			cp := u
			created = &cp
		}
	}
	if created == nil || !created.LockoutEnabled {
		t.Fatalf("new user lockout default = %+v, want lockout_enabled true", created)
	}
	if created.Locked || created.Protected {
		t.Fatalf("unexpected flags: %+v", created)
	}

	// Unlock is accepted (no-op here) and disabling clears the flag.
	resp = adminDo(t, http.MethodPut, fmt.Sprintf("%s/users/%d", srv.URL, id), `{"unlock":true}`)
	mustStatus(t, resp, http.StatusOK)
	resp.Body.Close()

	resp = adminDo(t, http.MethodPut, fmt.Sprintf("%s/users/%d", srv.URL, id), `{"lockout_enabled":false}`)
	mustStatus(t, resp, http.StatusOK)
	if decodeAs[map[string]any](t, resp)["lockout_enabled"] != false {
		t.Fatal("lockout_enabled should be false after disable")
	}
}
