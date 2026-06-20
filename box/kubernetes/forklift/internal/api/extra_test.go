package api

import (
	"net/http"
	"testing"
)

func TestTokenCreateValidation(t *testing.T) {
	srv := newTestServer(t)

	valid := func(field, value string) string {
		body := map[string]string{
			"name":        `"t1"`,
			"description": `"ci token"`,
			"scopes":      `[{"repo_pattern":"*","actions":["read"]}]`,
			"expires_in":  `"720h"`,
		}
		if value == "" {
			delete(body, field)
		} else if field != "" {
			body[field] = value
		}
		out := "{"
		first := true
		for k, v := range body {
			if !first {
				out += ","
			}
			out += `"` + k + `":` + v
			first = false
		}
		return out + "}"
	}

	// All required fields present.
	resp := adminDo(t, http.MethodPost, srv.URL+"/tokens", valid("", ""))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("valid create = %d", resp.StatusCode)
	}
	resp.Body.Close()

	cases := map[string]string{
		"missing name":          valid("name", ""),
		"missing description":   valid("description", ""),
		"missing scopes":        valid("scopes", ""),
		"empty scopes":          valid("scopes", `[]`),
		"scope without pattern": valid("scopes", `[{"repo_pattern":"","actions":["read"]}]`),
		"scope without actions": valid("scopes", `[{"repo_pattern":"*","actions":[]}]`),
		"invalid scope action":  valid("scopes", `[{"repo_pattern":"*","actions":["admin"]}]`),
		"missing expires_in":    valid("expires_in", ""),
		"invalid expires_in":    valid("expires_in", `"banana"`),
		"negative expires_in":   valid("expires_in", `"-1h"`),
		"expires_in over 1y":    valid("expires_in", `"8761h"`),
	}
	for name, body := range cases {
		resp := adminDo(t, http.MethodPost, srv.URL+"/tokens", body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s = %d, want 400", name, resp.StatusCode)
		}
		resp.Body.Close()
	}

	// One year exactly is allowed.
	resp = adminDo(t, http.MethodPost, srv.URL+"/tokens", valid("expires_in", `"8760h"`))
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("one year expiry = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestRoleAndUserErrors(t *testing.T) {
	srv := newTestServer(t)

	// Duplicate role.
	adminDo(t, http.MethodPost, srv.URL+"/roles", `{"name":"dup"}`).Body.Close()
	resp := adminDo(t, http.MethodPost, srv.URL+"/roles", `{"name":"dup"}`)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("dup role = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Empty role name.
	resp = adminDo(t, http.MethodPost, srv.URL+"/roles", `{"name":""}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty role = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Missing user fields.
	resp = adminDo(t, http.MethodPost, srv.URL+"/users", `{"username":"x"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing password = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Delete non-existent user.
	resp = adminDo(t, http.MethodDelete, srv.URL+"/users/9999", "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("delete missing user = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestRoleAssignmentAndDeletion(t *testing.T) {
	srv := newTestServer(t)

	// Create user and role.
	resp := adminDo(t, http.MethodPost, srv.URL+"/users", `{"username":"u1","password":"pw"}`)
	var user map[string]any
	decode(t, resp, &user)
	uid := itoa(int64(user["id"].(float64)))

	resp = adminDo(t, http.MethodPost, srv.URL+"/roles", `{"name":"r1"}`)
	var role map[string]any
	decode(t, resp, &role)
	rid := itoa(int64(role["id"].(float64)))

	// Assign then remove the role.
	adminDo(t, http.MethodPost, srv.URL+"/users/"+uid+"/roles", `{"role_id":`+rid+`}`).Body.Close()
	resp = adminDo(t, http.MethodDelete, srv.URL+"/users/"+uid+"/roles/"+rid, "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("remove role = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Delete the role.
	resp = adminDo(t, http.MethodDelete, srv.URL+"/roles/"+rid, "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete role = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestGroupMappingDeletion(t *testing.T) {
	srv := newTestServer(t)
	resp := adminDo(t, http.MethodPost, srv.URL+"/roles", `{"name":"gm"}`)
	var role map[string]any
	decode(t, resp, &role)
	rid := itoa(int64(role["id"].(float64)))
	adminDo(t, http.MethodPost, srv.URL+"/group-mappings", `{"group_name":"g","role_id":`+rid+`}`).Body.Close()

	resp = adminDo(t, http.MethodGet, srv.URL+"/group-mappings", "")
	var ms []map[string]any
	decode(t, resp, &ms)
	id := itoa(int64(ms[0]["ID"].(float64)))
	resp = adminDo(t, http.MethodDelete, srv.URL+"/group-mappings/"+id, "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete mapping = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestUpdateRepositoryBadConfig(t *testing.T) {
	srv := newTestServer(t)
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories", `{"name":"r","format":"go","type":"hosted"}`)
	var created repositoryDTO
	decode(t, resp, &created)

	// Invalid eviction value -> 400.
	resp = adminDo(t, http.MethodPut, srv.URL+"/repositories/"+itoa(created.ID),
		`{"config":{"cache":{"eviction":"fifo"}}}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad config = %d", resp.StatusCode)
	}
	resp.Body.Close()

	// Update non-existent repo -> 404.
	resp = adminDo(t, http.MethodPut, srv.URL+"/repositories/99999", `{"config":{}}`)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("update missing = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

// TestUpdateProxyRequiresUpstream guards against the PUT full-replace foot-gun:
// omitting upstream_url must not silently zero out a proxy's upstream.
func TestUpdateProxyRequiresUpstream(t *testing.T) {
	srv := newTestServer(t)
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"px","format":"npm","type":"proxy","upstream_url":"https://registry.npmjs.org"}`)
	var created repositoryDTO
	decode(t, resp, &created)

	// PUT with config only (no upstream_url) must be rejected, not accepted.
	resp = adminDo(t, http.MethodPut, srv.URL+"/repositories/"+itoa(created.ID),
		`{"config":{"cache":{"enabled":true}}}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("proxy update without upstream_url = %d, want 400", resp.StatusCode)
	}
	resp.Body.Close()

	// The upstream must still be intact.
	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/"+itoa(created.ID), "")
	var got repositoryDTO
	decode(t, resp, &got)
	if got.UpstreamURL != "https://registry.npmjs.org" {
		t.Fatalf("upstream_url = %q, want it unchanged", got.UpstreamURL)
	}
}

// TestRepositoryNamesForNonAdmin verifies the token-autocomplete endpoint:
// any authenticated user may list repository names even though the full
// repositories list is admin-only.
func TestRepositoryNamesForNonAdmin(t *testing.T) {
	srv := newTestServer(t)
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"npm-proxy","format":"npm","type":"proxy","upstream_url":"https://registry.npmjs.org"}`)
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()

	// A role-less local user (authenticated, not admin).
	resp = adminDo(t, http.MethodPost, srv.URL+"/users", `{"username":"dev1","password":"pw123456"}`)
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()

	// /repository-names: allowed, returns the name.
	resp = userDo(t, "dev1", "pw123456", http.MethodGet, srv.URL+"/repository-names", "")
	mustStatus(t, resp, http.StatusOK)
	var names []repositoryNameDTO
	decode(t, resp, &names)
	if len(names) != 1 || names[0].Name != "npm-proxy" || names[0].Format != "npm" {
		t.Fatalf("unexpected names: %+v", names)
	}

	// /repositories: authenticated users may list, but the filter returns only
	// repositories they can read — a role-less user sees an empty list.
	resp = userDo(t, "dev1", "pw123456", http.MethodGet, srv.URL+"/repositories", "")
	mustStatus(t, resp, http.StatusOK)
	var visible []repositoryListItemDTO
	decode(t, resp, &visible)
	if len(visible) != 0 {
		t.Fatalf("role-less user should see no repositories, got %+v", visible)
	}
}

func TestGetRepositoryNotFound(t *testing.T) {
	srv := newTestServer(t)
	resp := adminDo(t, http.MethodGet, srv.URL+"/repositories/424242", "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("missing repo = %d", resp.StatusCode)
	}
	resp.Body.Close()

	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/notanint", "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("bad id = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestListArtifactsEndpoint(t *testing.T) {
	srv := newTestServer(t)
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories", `{"name":"r","format":"npm","type":"proxy","upstream_url":"https://registry.npmjs.org"}`)
	var created repositoryDTO
	decode(t, resp, &created)

	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/"+itoa(created.ID)+"/artifacts", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("artifacts = %d", resp.StatusCode)
	}
	var out map[string]any
	decode(t, resp, &out)
	if out["count"].(float64) != 0 {
		t.Fatalf("count = %v, want 0", out["count"])
	}
	if _, ok := out["artifacts"]; !ok {
		t.Fatal("missing artifacts field")
	}
}

func TestUpstreamHealth(t *testing.T) {
	srv := newTestServer(t)

	// Local repo -> not applicable.
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories", `{"name":"loc","format":"go","type":"hosted"}`)
	var loc repositoryDTO
	decode(t, resp, &loc)
	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/"+itoa(loc.ID)+"/upstream-health", "")
	var hl map[string]any
	decode(t, resp, &hl)
	if hl["applicable"] != false {
		t.Fatalf("local applicable = %v, want false", hl["applicable"])
	}

	// Proxy pointing at the test server itself -> reachable.
	resp = adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"px","format":"maven","type":"proxy","upstream_url":"`+srv.URL+`"}`)
	var px repositoryDTO
	decode(t, resp, &px)
	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/"+itoa(px.ID)+"/upstream-health", "")
	var hp map[string]any
	decode(t, resp, &hp)
	if hp["applicable"] != true || hp["reachable"] != true {
		t.Fatalf("proxy health = %+v, want reachable", hp)
	}
}

func TestCheckUpstream(t *testing.T) {
	srv := newTestServer(t)

	// Reachable: probe the test server itself.
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories/check-upstream",
		`{"url":"`+srv.URL+`"}`)
	var ok map[string]any
	decode(t, resp, &ok)
	if ok["applicable"] != true || ok["reachable"] != true {
		t.Fatalf("check = %+v, want reachable", ok)
	}

	// Invalid scheme/host -> reachable false with an error, still HTTP 200.
	resp = adminDo(t, http.MethodPost, srv.URL+"/repositories/check-upstream", `{"url":"not-a-url"}`)
	var bad map[string]any
	decode(t, resp, &bad)
	if bad["reachable"] != false || bad["error"] == nil {
		t.Fatalf("invalid url check = %+v, want reachable=false with error", bad)
	}

	// Empty url -> 400.
	resp = adminDo(t, http.MethodPost, srv.URL+"/repositories/check-upstream", `{"url":""}`)
	mustStatus(t, resp, http.StatusBadRequest)
	resp.Body.Close()
}

func TestLogoutClearsSession(t *testing.T) {
	srv := newTestServer(t)
	resp, err := http.Post(srv.URL+"/logout", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("logout = %d, want 204", resp.StatusCode)
	}
	cleared := false
	for _, c := range resp.Cookies() {
		if c.Name == "forklift_session" && c.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatalf("session cookie not cleared: %+v", resp.Cookies())
	}
}

func TestRepositoryPermissions(t *testing.T) {
	srv := newTestServer(t)

	// A proxy repo and a role granting read on a matching pattern.
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"maven-central","format":"maven","type":"proxy","upstream_url":"https://repo1.maven.org/maven2"}`)
	var repo repositoryDTO
	decode(t, resp, &repo)
	resp = adminDo(t, http.MethodPost, srv.URL+"/roles",
		`{"name":"maven-readers","permissions":[{"repo_pattern":"maven-*","actions":["read"]}]}`)
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()

	// The matching role appears for this repo.
	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/"+itoa(repo.ID)+"/permissions", "")
	mustStatus(t, resp, http.StatusOK)
	var perms []repoPermissionDTO
	decode(t, resp, &perms)
	found := false
	for _, p := range perms {
		if p.Role == "maven-readers" && p.Pattern == "maven-*" && len(p.Actions) == 1 && p.Actions[0] == "read" {
			found = true
		}
	}
	if !found {
		t.Fatalf("maven-readers not matched for maven-central: %+v", perms)
	}

	// A non-matching repo does not list it.
	resp = adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"npm-proxy","format":"npm","type":"proxy","upstream_url":"https://registry.npmjs.org"}`)
	var npm repositoryDTO
	decode(t, resp, &npm)
	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/"+itoa(npm.ID)+"/permissions", "")
	decode(t, resp, &perms)
	for _, p := range perms {
		if p.Role == "maven-readers" {
			t.Fatalf("maven-* must not match npm-proxy: %+v", perms)
		}
	}
}

func TestRepositoryTokens(t *testing.T) {
	srv := newTestServer(t)
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"maven-central","format":"maven","type":"proxy","upstream_url":"https://repo1.maven.org/maven2"}`)
	var repo repositoryDTO
	decode(t, resp, &repo)

	// Admin (self) creates a scoped token matching the repo.
	resp = adminDo(t, http.MethodPost, srv.URL+"/tokens",
		`{"name":"ci","description":"ci","scopes":[{"repo_pattern":"maven-*","actions":["read"]}],"expires_in":"720h"}`)
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()

	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/"+itoa(repo.ID)+"/tokens", "")
	mustStatus(t, resp, http.StatusOK)
	var toks []repoTokenDTO
	decode(t, resp, &toks)
	found := false
	for _, tk := range toks {
		if tk.Name == "ci" && tk.Pattern == "maven-*" && !tk.Unscoped && len(tk.Actions) == 1 && tk.Actions[0] == "read" {
			found = true
		}
	}
	if !found {
		t.Fatalf("scoped token not listed for maven-central: %+v", toks)
	}

	// Non-matching repo excludes the scoped token.
	resp = adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"npm-proxy","format":"npm","type":"proxy","upstream_url":"https://registry.npmjs.org"}`)
	var npm repositoryDTO
	decode(t, resp, &npm)
	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/"+itoa(npm.ID)+"/tokens", "")
	decode(t, resp, &toks)
	for _, tk := range toks {
		if tk.Name == "ci" && !tk.Unscoped {
			t.Fatalf("maven-* scoped token must not match npm-proxy: %+v", toks)
		}
	}
}
