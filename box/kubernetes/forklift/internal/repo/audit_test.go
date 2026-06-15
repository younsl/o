package repo

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

func TestAuditedTrafficIsRecorded(t *testing.T) {
	m, _, store := newTestManager(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	rec := audit.NewRecorder(store, log, prometheus.NewRegistry())
	m.rec = rec
	mkRepo(t, store, "mvn-local", meta.TypeHosted, "", repoconfig.Default())
	h := mux(m)

	path := "/maven/mvn-local/com/acme/app/1.0/app-1.0.jar"

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodPut, path, strings.NewReader("JAR")))
	if w.Code != http.StatusCreated {
		t.Fatalf("put = %d", w.Code)
	}

	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("get = %d", w.Code)
	}

	// A miss must be audited too.
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/maven/mvn-local/missing.jar", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing get = %d", w.Code)
	}

	rec.Close() // flush buffered events

	logs, err := store.ListAuditLogs(context.Background(), "mvn-local", "", 10, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(logs) != 3 {
		t.Fatalf("len = %d, want 3 (%+v)", len(logs), logs)
	}
	// Newest first: 404 download, 200 download, 201 upload.
	if logs[0].Event != meta.EventDownload || logs[0].Status != http.StatusNotFound || logs[0].Path != "missing.jar" {
		t.Fatalf("miss entry = %+v", logs[0])
	}
	if logs[1].Event != meta.EventDownload || logs[1].Status != http.StatusOK {
		t.Fatalf("download entry = %+v", logs[1])
	}
	if logs[2].Event != meta.EventUpload || logs[2].Status != http.StatusCreated ||
		logs[2].Path != "com/acme/app/1.0/app-1.0.jar" || logs[2].Method != http.MethodPut {
		t.Fatalf("upload entry = %+v", logs[2])
	}
}

func TestEventForMethod(t *testing.T) {
	cases := map[string]string{
		http.MethodGet:    meta.EventDownload,
		http.MethodHead:   meta.EventDownload,
		http.MethodPut:    meta.EventUpload,
		http.MethodPost:   meta.EventUpload,
		http.MethodDelete: meta.EventDelete,
	}
	for method, want := range cases {
		if got := eventForMethod(method); got != want {
			t.Errorf("eventForMethod(%s) = %s, want %s", method, got, want)
		}
	}
}
