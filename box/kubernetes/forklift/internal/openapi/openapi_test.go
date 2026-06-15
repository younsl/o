package openapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestRegisterServesSpecAndDocs(t *testing.T) {
	r := chi.NewRouter()
	Register(r)

	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/openapi.yaml", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "openapi: 3.1.0") {
		t.Fatalf("spec = %d body[:20]=%q", rec.Code, rec.Body.String()[:20])
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/yaml" {
		t.Fatalf("content-type = %q", ct)
	}

	rec = httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api-docs", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "api-reference") {
		t.Fatalf("docs = %d", rec.Code)
	}
}

func TestSpecParses(t *testing.T) {
	if len(Spec()) == 0 || !strings.Contains(string(Spec()), "/api/v1/repositories") {
		t.Fatal("spec missing expected paths")
	}
}
