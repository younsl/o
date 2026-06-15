package repo

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// mkGroup creates a group repository over the given members.
func mkGroup(t *testing.T, store *meta.Store, name string, members ...string) meta.Repository {
	t.Helper()
	cfg := repoconfig.Default()
	cfg.Group.Members = members
	return mkRepo(t, store, name, meta.TypeGroup, "", cfg)
}

func TestGroupServesFirstHitInOrder(t *testing.T) {
	m, _, store := newTestManager(t)
	mkRepo(t, store, "hosted-a", meta.TypeHosted, "", repoconfig.Default())
	mkRepo(t, store, "hosted-b", meta.TypeHosted, "", repoconfig.Default())
	mkGroup(t, store, "mvn-public", "hosted-a", "hosted-b")
	h := mux(m)

	// Artifact only in the second member.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut,
		"/maven/hosted-b/com/acme/lib/1.0/lib-1.0.jar", strings.NewReader("FROM-B")))
	if rec.Code != http.StatusCreated {
		t.Fatalf("put b = %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/maven/mvn-public/com/acme/lib/1.0/lib-1.0.jar", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "FROM-B" {
		t.Fatalf("group get = %d body=%q", rec.Code, rec.Body.String())
	}

	// First member shadows the second for the same path.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut,
		"/maven/hosted-a/com/acme/lib/1.0/lib-1.0.jar", strings.NewReader("FROM-A")))
	if rec.Code != http.StatusCreated {
		t.Fatalf("put a = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/maven/mvn-public/com/acme/lib/1.0/lib-1.0.jar", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "FROM-A" {
		t.Fatalf("shadowed get = %d body=%q", rec.Code, rec.Body.String())
	}

	// Miss in every member -> 404.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/maven/mvn-public/missing.jar", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("miss = %d", rec.Code)
	}
}

func TestGroupIsReadOnly(t *testing.T) {
	m, _, store := newTestManager(t)
	mkRepo(t, store, "hosted-a", meta.TypeHosted, "", repoconfig.Default())
	mkGroup(t, store, "mvn-public", "hosted-a")
	h := mux(m)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut,
		"/maven/mvn-public/com/acme/lib/1.0/lib-1.0.jar", strings.NewReader("X")))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("group put = %d, want 405", rec.Code)
	}
}

func TestGroupSkipsDeletedMember(t *testing.T) {
	m, _, store := newTestManager(t)
	mkRepo(t, store, "hosted-a", meta.TypeHosted, "", repoconfig.Default())
	mkRepo(t, store, "hosted-b", meta.TypeHosted, "", repoconfig.Default())
	mkGroup(t, store, "mvn-public", "hosted-a", "hosted-b")
	h := mux(m)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut,
		"/maven/hosted-b/com/acme/lib/1.0/lib-1.0.jar", strings.NewReader("FROM-B")))
	if rec.Code != http.StatusCreated {
		t.Fatalf("put = %d", rec.Code)
	}

	// Delete the first member; the group must skip the dangling name.
	a, err := store.GetRepositoryByName(context.Background(), "hosted-a")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteRepository(context.Background(), a.ID); err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet,
		"/maven/mvn-public/com/acme/lib/1.0/lib-1.0.jar", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "FROM-B" {
		t.Fatalf("get with dangling member = %d body=%q", rec.Code, rec.Body.String())
	}
}

func TestValidateGroupMembers(t *testing.T) {
	_, _, store := newTestManager(t)
	ctx := context.Background()
	mkRepo(t, store, "hosted-a", meta.TypeHosted, "", repoconfig.Default())
	mkGroup(t, store, "existing-group", "hosted-a")

	cases := []struct {
		name    string
		format  string
		members []string
		wantErr string
	}{
		{"valid", meta.FormatMaven, []string{"hosted-a"}, ""},
		{"empty", meta.FormatMaven, nil, "at least one member"},
		{"missing", meta.FormatMaven, []string{"nope"}, "not found"},
		{"format mismatch", meta.FormatNPM, []string{"hosted-a"}, "format mismatch"},
		{"nested group", meta.FormatMaven, []string{"existing-group"}, "nested group"},
		{"duplicate", meta.FormatMaven, []string{"hosted-a", "hosted-a"}, "duplicate"},
	}
	for _, tc := range cases {
		err := ValidateGroupMembers(ctx, store, tc.format, tc.members)
		if tc.wantErr == "" {
			if err != nil {
				t.Errorf("%s: unexpected error %v", tc.name, err)
			}
		} else if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
			t.Errorf("%s: err = %v, want containing %q", tc.name, err, tc.wantErr)
		}
	}
}
