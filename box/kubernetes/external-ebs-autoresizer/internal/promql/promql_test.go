package promql

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// vectorBody is a two-series instant-query response in the shape both Prometheus
// and Mimir return.
const vectorBody = `{
  "status": "success",
  "data": {
    "resultType": "vector",
    "result": [
      {"metric": {"node": "ip-10-0-1-5"}, "value": [1769000000, "287.4218"]},
      {"metric": {"node": "ip-10-0-2-7"}, "value": [1769000000, "12"]}
    ]
  }
}`

func TestQueryVector(t *testing.T) {
	var gotPath, gotQuery, gotContentType string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotContentType = r.Header.Get("Content-Type")
		if err := r.ParseForm(); err != nil {
			t.Errorf("ParseForm() error = %v", err)
		}
		gotQuery = r.PostForm.Get("query")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(vectorBody))
	}))
	defer srv.Close()

	c := New(srv.URL, "", time.Second, nil, discardLogger())
	samples, err := c.Query(context.Background(), "up")
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if len(samples) != 2 {
		t.Fatalf("samples = %d, want 2", len(samples))
	}
	if samples[0].Labels["node"] != "ip-10-0-1-5" || samples[0].Value != 287.4218 {
		t.Errorf("samples[0] = %+v, want node ip-10-0-1-5 at 287.4218", samples[0])
	}
	if samples[1].Value != 12 {
		t.Errorf("samples[1].Value = %v, want 12", samples[1].Value)
	}
	if gotPath != queryPath {
		t.Errorf("path = %q, want %q", gotPath, queryPath)
	}
	// The query travels in a form-encoded body, not the URL, so a long generated
	// expression cannot hit a proxy's URL length limit.
	if gotQuery != "up" {
		t.Errorf("posted query = %q, want %q", gotQuery, "up")
	}
	if gotContentType != "application/x-www-form-urlencoded" {
		t.Errorf("content type = %q, want form encoding", gotContentType)
	}
}

func TestQueryScalar(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"scalar","result":[1769000000,"1"]}}`))
	}))
	defer srv.Close()

	samples, err := New(srv.URL, "", time.Second, nil, discardLogger()).Query(context.Background(), "vector(1)")
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if len(samples) != 1 || samples[0].Value != 1 {
		t.Fatalf("samples = %+v, want a single value of 1", samples)
	}
}

func TestQuerySpecialFloatValues(t *testing.T) {
	// Prometheus encodes the value as a JSON string precisely so NaN and Inf can
	// travel; decoding them as numbers would fail.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[
		  {"metric":{"node":"a"},"value":[1,"NaN"]},
		  {"metric":{"node":"b"},"value":[1,"+Inf"]}]}}`))
	}))
	defer srv.Close()

	samples, err := New(srv.URL, "", time.Second, nil, discardLogger()).Query(context.Background(), "x")
	if err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if len(samples) != 2 {
		t.Fatalf("samples = %d, want 2", len(samples))
	}
}

func TestQueryRejectedByBackend(t *testing.T) {
	// A malformed query comes back as 400 with the reason in the body; that reason
	// is the only actionable detail, so it must reach the error.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"status":"error","errorType":"bad_data","error":"invalid parameter \"query\": unexpected end of input"}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "", time.Second, nil, discardLogger()).Query(context.Background(), "sum by (")
	if err == nil {
		t.Fatal("Query() error = nil, want a rejection")
	}
	if !strings.Contains(err.Error(), "unexpected end of input") || !strings.Contains(err.Error(), "bad_data") {
		t.Errorf("error = %v, want it to carry the backend's reason and error type", err)
	}
}

func TestQueryServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream unavailable"))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "", time.Second, nil, discardLogger()).Query(context.Background(), "up")
	if err == nil || !strings.Contains(err.Error(), "upstream unavailable") {
		t.Errorf("error = %v, want the response body included", err)
	}
}

func TestQueryUnsupportedResultType(t *testing.T) {
	// A matrix means the caller asked a range question of an instant endpoint.
	// Accepting it would mean recommending from a partially read result.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "", time.Second, nil, discardLogger()).Query(context.Background(), "up[5m]")
	if err == nil || !strings.Contains(err.Error(), "unsupported result type") {
		t.Errorf("error = %v, want an unsupported result type error", err)
	}
}

func TestQueryMalformedSample(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1]}]}}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "", time.Second, nil, discardLogger()).Query(context.Background(), "up")
	if err == nil || !strings.Contains(err.Error(), "malformed sample") {
		t.Errorf("error = %v, want a malformed sample error", err)
	}
}

func TestQueryUnparseableValue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1,"abc"]}]}}`))
	}))
	defer srv.Close()

	_, err := New(srv.URL, "", time.Second, nil, discardLogger()).Query(context.Background(), "up")
	if err == nil || !strings.Contains(err.Error(), "parse sample value") {
		t.Errorf("error = %v, want a value parse error", err)
	}
}

func TestQueryUnreachableBackend(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := srv.URL
	srv.Close()

	_, err := New(url, "", 100*time.Millisecond, nil, discardLogger()).Query(context.Background(), "up")
	if err == nil {
		t.Fatal("Query() error = nil, want a connection failure")
	}
}

func TestPreflightPinsTheMimirPrefix(t *testing.T) {
	// A bare Mimir gateway URL serves the API under /prometheus. Probing means the
	// same prometheusUrl works whether it points at Prometheus or at Mimir.
	var paths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path != "/prometheus"+queryPath {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"scalar","result":[1,"1"]}}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "", time.Second, nil, discardLogger())
	endpoint, status, _, err := c.Preflight(context.Background())
	if err != nil {
		t.Fatalf("Preflight() error = %v", err)
	}
	if status != http.StatusOK {
		t.Errorf("status = %d, want 200", status)
	}
	if endpoint != srv.URL+"/prometheus"+queryPath {
		t.Errorf("endpoint = %q, want the /prometheus prefix", endpoint)
	}
	if len(paths) != 2 || paths[0] != queryPath {
		t.Errorf("probed paths = %v, want the bare path first", paths)
	}
	// Every later query must reuse the pinned prefix rather than probing again.
	if _, err := c.Query(context.Background(), "up"); err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if got := paths[len(paths)-1]; got != "/prometheus"+queryPath {
		t.Errorf("query path = %q, want the pinned prefix", got)
	}
}

func TestPreflightPrometheusNeedsNoPrefix(t *testing.T) {
	var probes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		probes++
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"scalar","result":[1,"1"]}}`))
	}))
	defer srv.Close()

	endpoint, _, _, err := New(srv.URL, "", time.Second, nil, discardLogger()).Preflight(context.Background())
	if err != nil {
		t.Fatalf("Preflight() error = %v", err)
	}
	if endpoint != srv.URL+queryPath {
		t.Errorf("endpoint = %q, want no prefix", endpoint)
	}
	if probes != 1 {
		t.Errorf("probes = %d, want 1: the first candidate answered", probes)
	}
}

func TestPreflightDoesNotTreatAuthFailureAsAWrongPath(t *testing.T) {
	// Retrying other prefixes on a 401 would report "no API found" for what is
	// really a credentials problem, sending the operator after the wrong bug.
	var probes int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		probes++
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte("no tenant"))
	}))
	defer srv.Close()

	_, status, _, err := New(srv.URL, "", time.Second, nil, discardLogger()).Preflight(context.Background())
	if err == nil {
		t.Fatal("Preflight() error = nil, want the 401 reported")
	}
	if status != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", status)
	}
	if probes != 1 {
		t.Errorf("probes = %d, want 1: a 401 is not a path problem", probes)
	}
}

func TestPreflightNoAPIFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	_, _, _, err := New(srv.URL, "", time.Second, nil, discardLogger()).Preflight(context.Background())
	if err == nil || !strings.Contains(err.Error(), "no Prometheus-compatible API found") {
		t.Errorf("error = %v, want a no-API-found error", err)
	}
}

func TestTenantAndCustomHeaders(t *testing.T) {
	var gotTenant, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTenant = r.Header.Get(tenantHeader)
		gotAuth = r.Header.Get("Authorization")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "team-a", time.Second, map[string]string{"Authorization": "Bearer t"}, discardLogger())
	if _, err := c.Query(context.Background(), "up"); err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if gotTenant != "team-a" {
		t.Errorf("%s = %q, want team-a", tenantHeader, gotTenant)
	}
	if gotAuth != "Bearer t" {
		t.Errorf("Authorization = %q, want the custom header", gotAuth)
	}
}

func TestCustomHeaderOverridesTheTenantHeader(t *testing.T) {
	var gotTenant string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotTenant = r.Header.Get(tenantHeader)
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"vector","result":[]}}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "team-a", time.Second, map[string]string{tenantHeader: "team-b"}, discardLogger())
	if _, err := c.Query(context.Background(), "up"); err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if gotTenant != "team-b" {
		t.Errorf("%s = %q, want the explicit header to win", tenantHeader, gotTenant)
	}
}

func TestNewNormalizesTheBaseURLAndDefaults(t *testing.T) {
	c := New("http://mimir:8080/prometheus/", "", 0, nil, nil)
	if c.base != "http://mimir:8080/prometheus" {
		t.Errorf("base = %q, want the trailing slash trimmed", c.base)
	}
	if c.httpClient.Timeout != 30*time.Second {
		t.Errorf("timeout = %s, want the 30s default", c.httpClient.Timeout)
	}
	if c.logger == nil {
		t.Error("logger = nil, want the default logger")
	}
	if got := c.Endpoint(); got != "http://mimir:8080/prometheus"+queryPath {
		t.Errorf("Endpoint() = %q, want the unprefixed candidate before preflight", got)
	}
}

func TestQueryHonoursContextCancellation(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := New(srv.URL, "", time.Second, nil, discardLogger()).Query(ctx, "up")
	if err == nil {
		t.Fatal("Query() error = nil, want the cancellation surfaced")
	}
}

func TestQueryLogsBackendWarnings(t *testing.T) {
	// Mimir returns warnings for a query that hit a per-tenant limit, which changes
	// what the result means; swallowing them would hide a truncated read.
	var logged strings.Builder
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"success","warnings":["chunks limit reached"],"data":{"resultType":"vector","result":[]}}`))
	}))
	defer srv.Close()

	logger := slog.New(slog.NewTextHandler(&logged, nil))
	if _, err := New(srv.URL, "", time.Second, nil, logger).Query(context.Background(), "up"); err != nil {
		t.Fatalf("Query() error = %v", err)
	}
	if !strings.Contains(logged.String(), "chunks limit reached") {
		t.Errorf("log = %q, want the backend warning logged", logged.String())
	}
}
