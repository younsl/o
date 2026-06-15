package webui

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSPAFallback(t *testing.T) {
	h := Handler()

	// Root serves index.html.
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<div id=\"root\">") {
		t.Fatalf("root = %d body=%q", rec.Code, rec.Body.String())
	}

	// Unknown client-side route falls back to index.html (history API).
	rec = httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodGet, "/repositories/42", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "<div id=\"root\">") {
		t.Fatalf("deep link = %d", rec.Code)
	}
}
