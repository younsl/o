package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

func newAuditTestServer(t *testing.T) (*httptest.Server, *audit.Recorder) {
	t.Helper()
	store, err := meta.Open(context.Background(), filepath.Join(t.TempDir(), "api-audit.db"))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(store, log, auth.Options{SessionSecret: []byte("test-secret-test-secret-test-secret")})
	if err := authSvc.BootstrapAdmin(context.Background(), adminUser, adminPass); err != nil {
		t.Fatal(err)
	}
	rec := audit.NewRecorder(store, log, prometheus.NewRegistry())
	h := New(store, authSvc, log, rec)
	srv := httptest.NewServer(authSvc.Middleware(h.Routes()))
	t.Cleanup(srv.Close)
	return srv, rec
}

type auditLogList struct {
	Count int64         `json:"count"`
	Logs  []auditLogDTO `json:"logs"`
}

func getAuditLogs(t *testing.T, srv *httptest.Server, repoID int64, query string) auditLogList {
	t.Helper()
	resp := adminDo(t, http.MethodGet, fmt.Sprintf("%s/repositories/%d/audit-logs%s", srv.URL, repoID, query), "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("audit-logs status = %d body=%s", resp.StatusCode, b)
	}
	var out auditLogList
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func TestRepositoryLifecycleIsAudited(t *testing.T) {
	srv, rec := newAuditTestServer(t)

	// Create.
	body := `{"name":"npm-local","format":"npm","type":"hosted"}`
	resp := adminDo(t, http.MethodPost, srv.URL+"/repositories", body)
	if resp.StatusCode != http.StatusCreated {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("create = %d body=%s", resp.StatusCode, b)
	}
	var created repositoryDTO
	json.NewDecoder(resp.Body).Decode(&created)
	resp.Body.Close()

	// Update.
	upd := `{"upstream_url":"","config":` + mustJSON(t, created.Config) + `}`
	resp = adminDo(t, http.MethodPut, fmt.Sprintf("%s/repositories/%d", srv.URL, created.ID), upd)
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("update = %d body=%s", resp.StatusCode, b)
	}
	resp.Body.Close()

	rec.Close() // flush async events before asserting

	list := getAuditLogs(t, srv, created.ID, "")
	if list.Count != 2 || len(list.Logs) != 2 {
		t.Fatalf("count = %d logs=%d, want 2", list.Count, len(list.Logs))
	}
	// Newest first.
	if list.Logs[0].Event != meta.EventRepoUpdate || list.Logs[1].Event != meta.EventRepoCreate {
		t.Fatalf("events = %s, %s", list.Logs[0].Event, list.Logs[1].Event)
	}
	if list.Logs[1].Username != adminUser || list.Logs[1].Status != http.StatusCreated {
		t.Fatalf("create entry = %+v", list.Logs[1])
	}

	// Event filter and pagination params.
	filtered := getAuditLogs(t, srv, created.ID, "?event=repo.create&limit=1&offset=0")
	if filtered.Count != 1 || len(filtered.Logs) != 1 || filtered.Logs[0].Event != meta.EventRepoCreate {
		t.Fatalf("filtered = %+v", filtered)
	}
}

func TestAuditLogsRepoNotFound(t *testing.T) {
	srv, rec := newAuditTestServer(t)
	defer rec.Close()
	resp := adminDo(t, http.MethodGet, srv.URL+"/repositories/9999/audit-logs", "")
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
