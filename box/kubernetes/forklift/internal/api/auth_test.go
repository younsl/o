package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func decode(t *testing.T, resp *http.Response, v any) {
	t.Helper()
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func TestLoginAndMe(t *testing.T) {
	srv := newTestServer(t)

	// Wrong password.
	resp := postJSON(t, srv.URL+"/login", `{"username":"admin","password":"nope"}`)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("bad login = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Correct password sets a session cookie.
	resp = postJSON(t, srv.URL+"/login", `{"username":"admin","password":"adminpw"}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login = %d", resp.StatusCode)
	}
	cookies := resp.Cookies()
	resp.Body.Close()
	if len(cookies) == 0 {
		t.Fatal("expected session cookie")
	}

	// /me with the session cookie reports admin.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/me", nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	resp, _ = http.DefaultClient.Do(req)
	var me map[string]any
	decode(t, resp, &me)
	if me["authenticated"] != true || me["admin"] != true {
		t.Fatalf("me = %+v", me)
	}

	// /me anonymous.
	resp, _ = http.Get(srv.URL + "/me")
	var anon map[string]any
	decode(t, resp, &anon)
	if anon["authenticated"] != false {
		t.Fatalf("anon me = %+v", anon)
	}
}

func TestTokenLifecycle(t *testing.T) {
	srv := newTestServer(t)

	// Create a PAT as admin.
	resp := adminDo(t, http.MethodPost, srv.URL+"/tokens", `{"name":"ci","description":"ci pipeline","scopes":[{"repo_pattern":"*","actions":["read"]}],"expires_in":"720h"}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create token = %d", resp.StatusCode)
	}
	var created map[string]any
	decode(t, resp, &created)
	token, _ := created["token"].(string)
	if token == "" {
		t.Fatal("no token returned")
	}

	// Use the PAT as a Bearer credential against /me.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, _ = http.DefaultClient.Do(req)
	var me map[string]any
	decode(t, resp, &me)
	if me["authenticated"] != true || me["username"] != "admin" {
		t.Fatalf("token me = %+v", me)
	}

	// List and delete.
	resp = adminDo(t, http.MethodGet, srv.URL+"/tokens", "")
	var list []map[string]any
	decode(t, resp, &list)
	if len(list) != 1 {
		t.Fatalf("token list len = %d", len(list))
	}
	id := int64(list[0]["id"].(float64))
	resp = adminDo(t, http.MethodDelete, srv.URL+"/tokens/"+itoa(id), "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete token = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestTokenRequiresAuth(t *testing.T) {
	srv := newTestServer(t)
	resp, _ := http.Get(srv.URL + "/tokens")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anon tokens = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestUserRoleAndGroupMappingFlow(t *testing.T) {
	srv := newTestServer(t)

	// Create a user.
	resp := adminDo(t, http.MethodPost, srv.URL+"/users", `{"username":"dev","password":"devpw","email":"dev@example.com"}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create user = %d", resp.StatusCode)
	}
	var user map[string]any
	decode(t, resp, &user)
	userID := int64(user["id"].(float64))

	// Duplicate user -> conflict.
	resp = adminDo(t, http.MethodPost, srv.URL+"/users", `{"username":"dev","password":"x"}`)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("dup user = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Create a role with a permission.
	resp = adminDo(t, http.MethodPost, srv.URL+"/roles", `{"name":"maven-rw","description":"maven read/write"}`)
	var role map[string]any
	decode(t, resp, &role)
	roleID := int64(role["id"].(float64))

	resp = adminDo(t, http.MethodPost, srv.URL+"/roles/"+itoa(roleID)+"/permissions", `{"repo_pattern":"maven-*","actions":["read","write"]}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("add permission = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Invalid action rejected.
	resp = adminDo(t, http.MethodPost, srv.URL+"/roles/"+itoa(roleID)+"/permissions", `{"repo_pattern":"*","actions":["destroy"]}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("invalid action = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Assign the role to the user.
	resp = adminDo(t, http.MethodPost, srv.URL+"/users/"+itoa(userID)+"/roles", `{"role_id":`+itoa(roleID)+`}`)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("assign role = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Group mapping.
	resp = adminDo(t, http.MethodPost, srv.URL+"/group-mappings", `{"group_name":"team-x","role_id":`+itoa(roleID)+`}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create mapping = %d", resp.StatusCode)
	}
	resp.Body.Close()
	resp = adminDo(t, http.MethodGet, srv.URL+"/group-mappings", "")
	var mappings []map[string]any
	decode(t, resp, &mappings)
	if len(mappings) != 1 {
		t.Fatalf("mappings len = %d", len(mappings))
	}

	// Lists.
	resp = adminDo(t, http.MethodGet, srv.URL+"/users", "")
	var users []map[string]any
	decode(t, resp, &users)
	if len(users) != 2 { // admin + dev
		t.Fatalf("users len = %d", len(users))
	}
	resp = adminDo(t, http.MethodGet, srv.URL+"/roles", "")
	var roles []map[string]any
	decode(t, resp, &roles)
	if len(roles) < 2 { // admin (bootstrap) + maven-rw
		t.Fatalf("roles len = %d", len(roles))
	}
}

func postJSON(t *testing.T, url, body string) *http.Response {
	t.Helper()
	resp, err := http.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	return resp
}
