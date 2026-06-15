package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
)

func TestVersionDenyLifecycle(t *testing.T) {
	srv := newTestServer(t)
	mkProxyRepo(t, srv.URL, "npmjs")

	// Deny one exact version.
	resp := adminDo(t, http.MethodPost, srv.URL+"/version-denies",
		`{"repo":"npmjs","package":"lodash","version":"4.17.99","reason":"IOC"}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create deny: status=%d", resp.StatusCode)
	}
	var created versionDenyDTO
	_ = json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	if created.ID == 0 || created.Version != "4.17.99" || created.CreatedBy != adminUser {
		t.Fatalf("created = %+v", created)
	}

	// Re-deny is idempotent (same row, refreshed reason).
	resp = adminDo(t, http.MethodPost, srv.URL+"/version-denies",
		`{"repo":"npmjs","package":"lodash","version":"4.17.99","reason":"CVE-2026-0001"}`)
	var again versionDenyDTO
	_ = json.NewDecoder(resp.Body).Decode(&again)
	resp.Body.Close()
	if again.ID != created.ID || again.Reason != "CVE-2026-0001" {
		t.Fatalf("re-deny = %+v, want same id", again)
	}

	// List with repo filter.
	resp = adminDo(t, http.MethodGet, srv.URL+"/version-denies?repo=npmjs", "")
	var list struct {
		Count  int64            `json:"count"`
		Denies []versionDenyDTO `json:"denies"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&list)
	resp.Body.Close()
	if list.Count != 1 || len(list.Denies) != 1 || list.Denies[0].Package != "lodash" {
		t.Fatalf("list = %+v", list)
	}

	// Remove, then verify the list is empty and double-delete 404s.
	resp = adminDo(t, http.MethodDelete, fmt.Sprintf("%s/version-denies/%d", srv.URL, created.ID), "")
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: status=%d", resp.StatusCode)
	}
	resp = adminDo(t, http.MethodDelete, fmt.Sprintf("%s/version-denies/%d", srv.URL, created.ID), "")
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("double delete: status=%d", resp.StatusCode)
	}
}

func TestVersionDenyValidation(t *testing.T) {
	srv := newTestServer(t)
	mkProxyRepo(t, srv.URL, "npmjs")

	// Hosted repos cannot hold denies.
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"npm-hosted","format":"npm","type":"hosted"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create hosted: status=%d", resp.StatusCode)
	}

	for body, want := range map[string]int{
		`{"repo":"npmjs","package":"","version":"1.0.0"}`:          http.StatusBadRequest,
		`{"repo":"npmjs","package":"lodash","version":""}`:         http.StatusBadRequest,
		`{"repo":"missing","package":"lodash","version":"1.0.0"}`:  http.StatusNotFound,
		`{"repo":"npm-hosted","package":"lodash","version":"1.0"}`: http.StatusBadRequest,
	} {
		resp := adminDo(t, http.MethodPost, srv.URL+"/version-denies", body)
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Errorf("%s: status=%d, want %d", body, resp.StatusCode, want)
		}
	}
}

func TestVersionDenyRepoDeleteCleanup(t *testing.T) {
	srv := newTestServer(t)
	id := mkProxyRepo(t, srv.URL, "npmjs")

	resp := adminDo(t, http.MethodPost, srv.URL+"/version-denies",
		`{"repo":"npmjs","package":"lodash","version":"4.17.99"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create deny: status=%d", resp.StatusCode)
	}

	// Deleting the repository must drop its denies: a recreated same-name repo
	// would otherwise inherit them.
	resp = adminDo(t, http.MethodDelete, fmt.Sprintf("%s/repositories/%d", srv.URL, id), "")
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete repo: status=%d", resp.StatusCode)
	}
	resp = adminDo(t, http.MethodGet, srv.URL+"/version-denies", "")
	var list struct {
		Count int64 `json:"count"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&list)
	resp.Body.Close()
	if list.Count != 0 {
		t.Fatalf("denies after repo delete = %d, want 0", list.Count)
	}
}

func TestValidName(t *testing.T) {
	for name, want := range map[string]bool{
		"npm-proxy":   true,
		"Npm_Proxy-2": true,
		"a":           true,
		"":            false,
		"npm proxy":   false,
		"npm.proxy":   false,
		"npm/проxy":   false,
		"한글":          false,
	} {
		if got := validName(name); got != want {
			t.Errorf("validName(%q) = %v, want %v", name, got, want)
		}
	}
	if validName(string(make([]byte, 65))) {
		t.Error("65-char name must be invalid")
	}
}

func TestNameValidationOnCreateEndpoints(t *testing.T) {
	srv := newTestServer(t)

	cases := []struct{ url, body string }{
		{"/repositories", `{"name":"bad.name","format":"npm","type":"hosted"}`},
		{"/roles", `{"name":"bad role"}`},
		{"/users", `{"username":"bad user","password":"pw"}`},
		{"/tokens", `{"name":"bad name","description":"d","scopes":[{"repo_pattern":"*","actions":["read"]}],"expires_in":"1h"}`},
	}
	for _, c := range cases {
		resp := adminDo(t, http.MethodPost, srv.URL+c.url, c.body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s %s: status=%d, want 400", c.url, c.body, resp.StatusCode)
		}
	}
}
