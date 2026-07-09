package conflict

import (
	"context"
	"errors"
	"testing"

	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/opensearch"
)

func caps() opensearch.FieldCaps {
	return opensearch.FieldCaps{
		Indices: []string{
			"logs-prd.api-2026.07.01",
			"logs-prd.api-2026.07.02",
			"logs-prd.web-2026.07.01",
			"logs-dev.api-2026.07.01",
		},
		Fields: map[string]map[string]opensearch.FieldCap{
			// Conflicts between the two prd api dailies.
			"response.amount": {
				"long": {Type: "long", Indices: []string{"logs-prd.api-2026.07.01"}},
				"text": {Type: "text", Indices: []string{"logs-prd.api-2026.07.02", "logs-dev.api-2026.07.01"}},
			},
			// Single real type plus unmapped: never a conflict.
			"message": {
				"text":     {Type: "text"},
				"unmapped": {Type: "unmapped", Indices: []string{"logs-prd.web-2026.07.01"}},
			},
			// Multi-type globally, but only one type within logs-prd.api-*.
			"flag": {
				"boolean": {Type: "boolean", Indices: []string{"logs-prd.api-2026.07.01", "logs-prd.api-2026.07.02"}},
				"text":    {Type: "text", Indices: []string{"logs-dev.api-2026.07.01"}},
			},
		},
	}
}

func TestAggregateFindsConflicts(t *testing.T) {
	snap := Aggregate([]string{"logs-prd.api-*", "logs-prd.web-*", "logs-none-*"}, caps())

	if snap.PatternsTotal != 3 {
		t.Fatalf("PatternsTotal = %d, want 3", snap.PatternsTotal)
	}
	if snap.PatternsWithConflict != 1 {
		t.Fatalf("PatternsWithConflict = %d, want 1", snap.PatternsWithConflict)
	}
	if snap.ScannedIndices != 4 || snap.ScannedFields != 3 {
		t.Fatalf("Scanned = (%d, %d), want (4, 3)", snap.ScannedIndices, snap.ScannedFields)
	}

	pc, ok := snap.Result["logs-prd.api-*"]
	if !ok {
		t.Fatal("expected conflicts for logs-prd.api-*")
	}
	if pc.IndexCount != 2 {
		t.Fatalf("IndexCount = %d, want 2", pc.IndexCount)
	}
	if len(pc.Conflicts) != 1 {
		t.Fatalf("Conflicts = %v, want only response.amount", pc.Conflicts)
	}
	ti := pc.Conflicts["response.amount"]
	if len(ti["long"]) != 1 || len(ti["text"]) != 1 {
		t.Fatalf("response.amount type indices = %v, want 1 long + 1 text", ti)
	}
	if ti["text"][0] != "logs-prd.api-2026.07.02" {
		t.Fatalf("text index = %q, want the prd daily only", ti["text"][0])
	}
}

func TestAggregateTypeWithoutIndicesCoversAll(t *testing.T) {
	c := opensearch.FieldCaps{
		Indices: []string{"logs-a-1", "logs-a-2"},
		Fields: map[string]map[string]opensearch.FieldCap{
			"f": {
				// No Indices list: the type covers every scanned index.
				"object": {Type: "object"},
				"text":   {Type: "text", Indices: []string{"logs-a-2"}},
			},
		},
	}
	snap := Aggregate([]string{"logs-a-*"}, c)
	ti := snap.Result["logs-a-*"].Conflicts["f"]
	if len(ti["object"]) != 2 {
		t.Fatalf("object indices = %v, want all 2", ti["object"])
	}
}

func TestMatchPattern(t *testing.T) {
	cases := []struct {
		pattern, index string
		want           bool
	}{
		{"logs-prd.api-*", "logs-prd.api-2026.07.01", true},
		{"logs-prd.*json*", "logs-prd.api-json-log-2026.07.01", true},
		{"logs-prd.api", "logs-prd.api-2026.07.01", true}, // bare title = prefix
		{"logs-prd.api-*", "logs-dev.api-2026.07.01", false},
		{"logs-[", "logs-x", false}, // malformed pattern never matches
	}
	for _, tc := range cases {
		if got := matchPattern(tc.pattern, tc.index); got != tc.want {
			t.Errorf("matchPattern(%q, %q) = %v, want %v", tc.pattern, tc.index, got, tc.want)
		}
	}
}

type fakeSource struct {
	patterns    []string
	caps        opensearch.FieldCaps
	patternsErr error
	capsErr     error
}

func (f *fakeSource) IndexPatterns(context.Context, string) ([]string, error) {
	return f.patterns, f.patternsErr
}

func (f *fakeSource) FieldCapabilities(context.Context, string) (opensearch.FieldCaps, error) {
	return f.caps, f.capsErr
}

func TestFetcher(t *testing.T) {
	f := &Fetcher{
		Source:      &fakeSource{patterns: []string{"logs-prd.api-*"}, caps: caps()},
		KibanaIndex: ".kibana",
		Targets:     "logs-*",
		ClusterName: "unit-test",
	}
	snap, err := f.Fetch(context.Background())
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if snap.ClusterName != "unit-test" {
		t.Fatalf("ClusterName = %q, want unit-test", snap.ClusterName)
	}
	if snap.PatternsWithConflict != 1 {
		t.Fatalf("PatternsWithConflict = %d, want 1", snap.PatternsWithConflict)
	}
}

func TestFetcherErrors(t *testing.T) {
	boom := errors.New("boom")
	if _, err := (&Fetcher{Source: &fakeSource{patternsErr: boom}}).Fetch(context.Background()); err == nil {
		t.Fatal("expected index patterns error")
	}
	if _, err := (&Fetcher{Source: &fakeSource{capsErr: boom}}).Fetch(context.Background()); err == nil {
		t.Fatal("expected field capabilities error")
	}
}
