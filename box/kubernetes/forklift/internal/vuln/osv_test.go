package vuln

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOSVQuery(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/query" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"vulns":[
			{"id":"GHSA-aaaa","aliases":["CVE-2026-1111"],"database_specific":{"severity":"HIGH"}},
			{"id":"GHSA-bbbb","withdrawn":"2026-01-01T00:00:00Z","database_specific":{"severity":"CRITICAL"}},
			{"id":"MAL-2026-9","database_specific":{"severity":""}}
		]}`))
	}))
	defer srv.Close()

	f, err := NewOSV(srv.URL, nil).Query(context.Background(), "npm", "left-pad", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	// Two non-withdrawn advisories; the withdrawn CRITICAL one is excluded.
	if len(f.IDs) != 2 {
		t.Fatalf("ids = %v, want 2", f.IDs)
	}
	// The CVE alias is preferred over the GHSA id.
	if f.IDs[0] != "CVE-2026-1111" {
		t.Fatalf("first id = %q, want CVE alias", f.IDs[0])
	}
	// MAL- advisory forces critical even without a severity label.
	if f.Max != SevCritical {
		t.Fatalf("max severity = %v, want critical", f.Max)
	}
	// Per-severity histogram: one HIGH and one CRITICAL (withdrawn one excluded).
	if f.Counts[SevHigh] != 1 || f.Counts[SevCritical] != 1 {
		t.Fatalf("counts = %v", f.Counts)
	}
	sc := f.SeverityCounts()
	if sc["high"] != 1 || sc["critical"] != 1 || len(sc) != 2 {
		t.Fatalf("severity counts = %v", sc)
	}
}

func TestOSVQueryClean(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	f, err := NewOSV(srv.URL, nil).Query(context.Background(), "Go", "example.com/m", "v1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if len(f.IDs) != 0 || f.Max != SevNone {
		t.Fatalf("clean coordinate = %+v", f)
	}
}

func TestSeverityRoundTrip(t *testing.T) {
	for _, s := range []Severity{SevNone, SevLow, SevMedium, SevHigh, SevCritical} {
		if got := ParseSeverity(s.String()); got != s {
			t.Fatalf("round-trip %v -> %q -> %v", s, s.String(), got)
		}
	}
	if ParseSeverity("bogus") != SevNone {
		t.Fatal("unknown label should parse to none")
	}
}

func TestBucketCVSS(t *testing.T) {
	cases := map[float64]Severity{9.8: SevCritical, 7.5: SevHigh, 5.0: SevMedium, 2.0: SevLow, 0: SevNone}
	for score, want := range cases {
		if got := bucketCVSS(score); got != want {
			t.Fatalf("bucketCVSS(%v) = %v, want %v", score, got, want)
		}
	}
}

func TestQueryEmptyCoordinate(t *testing.T) {
	// No HTTP call should happen without a package name.
	f, err := NewOSV("http://invalid.example", nil).Query(context.Background(), "npm", "", "")
	if err != nil || len(f.IDs) != 0 {
		t.Fatalf("empty coordinate = %+v err=%v", f, err)
	}
}

func TestOSVQueryPackageLevel(t *testing.T) {
	// An empty version performs a package-level query: the request must omit the
	// "version" field so OSV returns advisories across all versions.
	var sawVersion bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, sawVersion = body["version"]
		_, _ = w.Write([]byte(`{"vulns":[{"id":"GHSA-pkg","database_specific":{"severity":"MODERATE"}}]}`))
	}))
	defer srv.Close()

	f, err := NewOSV(srv.URL, nil).Query(context.Background(), "npm", "express", "")
	if err != nil {
		t.Fatal(err)
	}
	if sawVersion {
		t.Fatal("package-level query must omit the version field")
	}
	if len(f.IDs) != 1 || f.Max != SevMedium {
		t.Fatalf("package-level finding = %+v", f)
	}
}
