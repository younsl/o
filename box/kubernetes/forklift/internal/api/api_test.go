package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

const adminUser, adminPass = "admin", "adminpw"

func newTestServer(t *testing.T) *httptest.Server {
	return newTestServerOpts(t, auth.Options{SessionSecret: []byte("test-secret-test-secret-test-secret")})
}

// newTestServerProtectedAdmin marks the bootstrap admin as the protected admin,
// matching production wiring where the seeded admin is exempt from lockout and
// cannot be disabled.
func newTestServerProtectedAdmin(t *testing.T) *httptest.Server {
	return newTestServerOpts(t, auth.Options{
		SessionSecret:      []byte("test-secret-test-secret-test-secret"),
		BootstrapAdminUser: adminUser,
	})
}

func newTestServerOpts(t *testing.T, opts auth.Options) *httptest.Server {
	t.Helper()
	store, err := meta.Open(context.Background(), filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(store, log, opts)
	if err := authSvc.BootstrapAdmin(context.Background(), adminUser, adminPass); err != nil {
		t.Fatal(err)
	}
	h := New(store, authSvc, log, nil)
	srv := httptest.NewServer(authSvc.Middleware(h.Routes()))
	t.Cleanup(srv.Close)
	return srv
}

// adminDo sends an authenticated (admin Basic auth) request.
func adminDo(t *testing.T, method, url, body string) *http.Response {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = bytes.NewBufferString(body)
	}
	req, err := http.NewRequest(method, url, r)
	if err != nil {
		t.Fatal(err)
	}
	req.SetBasicAuth(adminUser, adminPass)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func TestCreateAndListRepository(t *testing.T) {
	srv := newTestServer(t)

	body := `{"name":"npm-proxy","format":"npm","type":"proxy","upstream_url":"https://registry.npmjs.org","config":{"age_policy":{"enabled":true,"min_age":"3d","action":"block"}}}`
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories", body)
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("create status = %d body=%s", resp.StatusCode, b)
	}
	var created repositoryDTO
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()
	if created.ID == 0 || !created.Config.AgePolicy.Enabled {
		t.Fatalf("unexpected created repo: %+v", created)
	}

	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories", "")
	var list []repositoryDTO
	json.NewDecoder(resp.Body).Decode(&list)
	resp.Body.Close()
	if len(list) != 1 || list[0].Name != "npm-proxy" {
		t.Fatalf("list = %+v", list)
	}
}

func TestRepositoryRequiresAdmin(t *testing.T) {
	srv := newTestServer(t)
	// No credentials -> 401.
	resp, _ := http.Get(srv.URL + "/repositories")
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated = %d, want 401", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestCreateValidation(t *testing.T) {
	srv := newTestServer(t)
	cases := []string{
		`{"name":"BAD NAME","format":"npm","type":"hosted"}`,
		`{"name":"x","format":"rubygems","type":"hosted"}`,
		`{"name":"x","format":"npm","type":"weird"}`,
		`{"name":"x","format":"npm","type":"proxy"}`, // missing upstream_url
	}
	for _, c := range cases {
		resp := adminDo(t, http.MethodPost, srv.URL+"/repositories", c)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("case %s: status = %d, want 400", c, resp.StatusCode)
		}
		resp.Body.Close()
	}
}

func TestCreateDuplicateConflict(t *testing.T) {
	srv := newTestServer(t)
	body := `{"name":"dup","format":"go","type":"hosted"}`
	adminDo(t, http.MethodPost, srv.URL+"/repositories", body).Body.Close()
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories", body)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("dup status = %d, want 409", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestUpdateAndDelete(t *testing.T) {
	srv := newTestServer(t)
	body := `{"name":"cargo-proxy","format":"cargo","type":"proxy","upstream_url":"https://index.crates.io"}`
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories", body)
	var created repositoryDTO
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()

	upd := `{"upstream_url":"https://mirror.example.com","config":{"cache":{"enabled":true,"max_size_bytes":2048,"eviction":"lru"}}}`
	resp = adminDo(t, http.MethodPut, srv.URL+"/repositories/"+itoa(created.ID), upd)
	var updated repositoryDTO
	json.NewDecoder(resp.Body).Decode(&updated)
	resp.Body.Close()
	if updated.UpstreamURL != "https://mirror.example.com" || updated.Config.Cache.MaxSizeBytes != 2048 {
		t.Fatalf("update not applied: %+v", updated)
	}

	resp = adminDo(t, http.MethodDelete, srv.URL+"/repositories/"+itoa(created.ID), "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete status = %d", resp.StatusCode)
	}
	resp.Body.Close()

	resp = adminDo(t, http.MethodGet, srv.URL+"/repositories/"+itoa(created.ID), "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("get after delete status = %d", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestDeleteArtifact(t *testing.T) {
	srv, store := newTestServerWithStore(t)
	ctx := context.Background()
	id := mkProxyRepo(t, srv.URL, "npmjs")

	seed := func() {
		for _, a := range []meta.Artifact{
			{RepoID: id, Path: "lodash/-/lodash-4.17.21.tgz", Version: "4.17.21", BlobSHA256: "b1", Size: 10},
			{RepoID: id, Path: "is-odd/-/is-odd-1.0.0.tgz", Version: "1.0.0", BlobSHA256: "b2", Size: 5},
		} {
			if _, err := store.PutArtifact(ctx, a); err != nil {
				t.Fatal(err)
			}
		}
	}
	seed()

	// Single delete by path -> 204, only that artifact gone.
	resp := adminDo(t, http.MethodDelete,
		srv.URL+"/repositories/"+itoa(id)+"/artifacts?path="+url.QueryEscape("lodash/-/lodash-4.17.21.tgz"), "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("single delete status = %d, want 204", resp.StatusCode)
	}
	resp.Body.Close()
	if c, _ := store.CountArtifacts(ctx, id); c != 1 {
		t.Fatalf("count after single delete = %d, want 1", c)
	}

	// Deleting a missing path -> 404.
	resp = adminDo(t, http.MethodDelete,
		srv.URL+"/repositories/"+itoa(id)+"/artifacts?path="+url.QueryEscape("nope/-/nope-9.9.9.tgz"), "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("missing delete status = %d, want 404", resp.StatusCode)
	}
	resp.Body.Close()

	// Purge all (no path) -> 200 with deleted count, repo emptied.
	seed() // restore the one that was deleted plus the survivor stays
	resp = adminDo(t, http.MethodDelete, srv.URL+"/repositories/"+itoa(id)+"/artifacts", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("purge status = %d, want 200", resp.StatusCode)
	}
	var out struct {
		Deleted int `json:"deleted"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	resp.Body.Close()
	if out.Deleted != 2 {
		t.Fatalf("purge deleted = %d, want 2", out.Deleted)
	}
	if c, _ := store.CountArtifacts(ctx, id); c != 0 {
		t.Fatalf("count after purge = %d, want 0", c)
	}

	// Unknown repo id -> 404.
	resp = adminDo(t, http.MethodDelete, srv.URL+"/repositories/99999/artifacts", "")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown repo status = %d, want 404", resp.StatusCode)
	}
	resp.Body.Close()
}

func itoa(i int64) string {
	return strconv.FormatInt(i, 10)
}
