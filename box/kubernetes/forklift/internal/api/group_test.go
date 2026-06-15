package api

import (
	"fmt"
	"net/http"
	"testing"
)

func TestCreateGroupRepository(t *testing.T) {
	srv := newTestServer(t)

	// Members first.
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"maven-hosted","format":"maven","type":"hosted"}`)
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()
	resp = adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"maven-central","format":"maven","type":"proxy","upstream_url":"https://repo1.maven.org/maven2"}`)
	mustStatus(t, resp, http.StatusCreated)
	resp.Body.Close()

	// Valid group.
	resp = adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"maven-public","format":"maven","type":"group",
		  "config":{"group":{"members":["maven-hosted","maven-central"]}}}`)
	mustStatus(t, resp, http.StatusCreated)
	created := decodeAs[repositoryDTO](t, resp)
	if created.Type != "group" || len(created.Config.Group.Members) != 2 {
		t.Fatalf("created = %+v", created)
	}

	// Invalid groups.
	for name, body := range map[string]string{
		"no members":      `{"name":"g1","format":"maven","type":"group"}`,
		"missing member":  `{"name":"g2","format":"maven","type":"group","config":{"group":{"members":["nope"]}}}`,
		"format mismatch": `{"name":"g3","format":"npm","type":"group","config":{"group":{"members":["maven-hosted"]}}}`,
		"nested group":    `{"name":"g4","format":"maven","type":"group","config":{"group":{"members":["maven-public"]}}}`,
	} {
		resp = adminDo(t, http.MethodPost, srv.URL+"/repositories", body)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400", name, resp.StatusCode)
		}
		resp.Body.Close()
	}

	// Members on a non-group repository are rejected.
	resp = adminDo(t, http.MethodPost, srv.URL+"/repositories",
		`{"name":"bad-local","format":"maven","type":"hosted","config":{"group":{"members":["maven-hosted"]}}}`)
	mustStatus(t, resp, http.StatusBadRequest)
	resp.Body.Close()

	// Update: reordering members is allowed, removing all is rejected.
	upd := `{"upstream_url":"","config":{"group":{"members":["maven-central","maven-hosted"]}}}`
	resp = adminDo(t, http.MethodPut, fmt.Sprintf("%s/repositories/%d", srv.URL, created.ID), upd)
	mustStatus(t, resp, http.StatusOK)
	updated := decodeAs[repositoryDTO](t, resp)
	if updated.Config.Group.Members[0] != "maven-central" {
		t.Fatalf("updated members = %v", updated.Config.Group.Members)
	}
	resp = adminDo(t, http.MethodPut, fmt.Sprintf("%s/repositories/%d", srv.URL, created.ID),
		`{"upstream_url":"","config":{"group":{"members":[]}}}`)
	mustStatus(t, resp, http.StatusBadRequest)
	resp.Body.Close()
}
