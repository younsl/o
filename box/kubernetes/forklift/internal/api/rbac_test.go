package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// newTestServerWithStore is like newTestServer but exposes the store so tests
// can seed declaratively-managed RBAC rows.
func newTestServerWithStore(t *testing.T) (*httptest.Server, *meta.Store) {
	t.Helper()
	store, err := meta.Open(context.Background(), filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(store, log, auth.Options{SessionSecret: []byte("test-secret-test-secret-test-secret")})
	if err := authSvc.BootstrapAdmin(context.Background(), adminUser, adminPass); err != nil {
		t.Fatal(err)
	}
	h := New(store, authSvc, log, nil)
	srv := httptest.NewServer(authSvc.Middleware(h.Routes()))
	t.Cleanup(srv.Close)
	return srv, store
}

func TestManagedRBACReadOnlyViaAPI(t *testing.T) {
	srv, store := newTestServerWithStore(t)
	ctx := context.Background()

	desired := meta.ManagedRBAC{
		Roles:      []meta.ManagedRole{{Name: "readonly", Permissions: []meta.Permission{{RepoPattern: "*", Actions: "read"}}}},
		GroupRoles: []meta.ManagedGrant{{Subject: "/devs", Role: "readonly"}},
		UserRoles:  []meta.ManagedGrant{{Subject: "alice", Role: "readonly"}},
	}
	if err := store.ApplyManagedRBAC(ctx, desired); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// GET /roles exposes the managed flag and the permission ID.
	resp := adminDo(t, http.MethodGet, srv.URL+"/roles", "")
	var roles []roleDTO
	json.NewDecoder(resp.Body).Decode(&roles)
	resp.Body.Close()
	var ro roleDTO
	for _, r := range roles {
		if r.Name == "readonly" {
			ro = r
		}
	}
	if ro.ID == 0 || !ro.Managed {
		t.Fatalf("readonly role not reported as managed: %+v", roles)
	}
	if len(ro.Permissions) != 1 {
		t.Fatalf("readonly perms = %+v", ro.Permissions)
	}

	// Deleting a managed role is rejected.
	resp = adminDo(t, http.MethodDelete, srv.URL+"/roles/"+itoa(ro.ID), "")
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("delete managed role = %d, want 409", resp.StatusCode)
	}
	resp.Body.Close()

	// Adding a permission to a managed role is rejected.
	resp = adminDo(t, http.MethodPost, srv.URL+"/roles/"+itoa(ro.ID)+"/permissions", `{"repo_pattern":"*","actions":["write"]}`)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("add perm to managed role = %d, want 409", resp.StatusCode)
	}
	resp.Body.Close()

	// Deleting a managed permission is rejected.
	resp = adminDo(t, http.MethodDelete, srv.URL+"/roles/"+itoa(ro.ID)+"/permissions/"+itoa(ro.Permissions[0].ID), "")
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("delete managed perm = %d, want 409", resp.StatusCode)
	}
	resp.Body.Close()

	// Deleting a managed group mapping is rejected.
	mappings, _ := store.ListGroupMappings(ctx)
	resp = adminDo(t, http.MethodDelete, srv.URL+"/group-mappings/"+itoa(mappings[0].ID), "")
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("delete managed mapping = %d, want 409", resp.StatusCode)
	}
	resp.Body.Close()

	// Removing a managed user-role assignment is rejected.
	alice, _ := store.GetUserByUsername(ctx, "alice")
	resp = adminDo(t, http.MethodDelete, srv.URL+"/users/"+itoa(alice.ID)+"/roles/"+itoa(ro.ID), "")
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("remove managed user role = %d, want 409", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestUnmanagedRoleStillMutable(t *testing.T) {
	srv, _ := newTestServerWithStore(t)

	// A role created via the API is unmanaged and fully mutable.
	resp := adminDo(t, http.MethodPost, srv.URL+"/roles", `{"name":"manual","description":"x","permissions":[{"repo_pattern":"*","actions":["read"]}]}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create role = %d", resp.StatusCode)
	}
	var role roleDTO
	json.NewDecoder(resp.Body).Decode(&role)
	resp.Body.Close()
	if role.Managed {
		t.Fatal("API-created role must be unmanaged")
	}
	resp = adminDo(t, http.MethodDelete, srv.URL+"/roles/"+itoa(role.ID), "")
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("delete unmanaged role = %d, want 204", resp.StatusCode)
	}
	resp.Body.Close()
}
