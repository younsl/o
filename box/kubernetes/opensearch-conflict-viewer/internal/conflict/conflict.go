// Package conflict turns a global field-capabilities response into per
// index pattern mapping-conflict reports.
package conflict

import (
	"path"
	"sort"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/opensearch"
)

// TypeIndices maps a mapping type (e.g. "text", "long") to the sorted list
// of concrete indices where the field carries that type.
type TypeIndices map[string][]string

// PatternConflicts is the conflict report for one index pattern.
type PatternConflicts struct {
	IndexCount int                    `json:"index_count"`
	Conflicts  map[string]TypeIndices `json:"conflicts"`
}

// Snapshot is one full aggregation run over every index pattern.
type Snapshot struct {
	RefreshedAt          time.Time                   `json:"refreshed_at"`
	ClusterName          string                      `json:"cluster_name,omitempty"`
	PatternsTotal        int                         `json:"patterns_total"`
	PatternsWithConflict int                         `json:"patterns_with_conflicts"`
	ScannedIndices       int                         `json:"scanned_indices"`
	ScannedFields        int                         `json:"scanned_fields"`
	Result               map[string]PatternConflicts `json:"result"`
}

// Aggregate computes, for every index pattern, the fields whose mapping type
// differs between the pattern's matching indices. A field is a conflict for
// a pattern when at least two mapping types are present among the indices
// the pattern matches.
func Aggregate(patterns []string, caps opensearch.FieldCaps) Snapshot {
	// Fields with a single global type can never conflict for any pattern,
	// so only multi-type fields are candidates. OpenSearch populates the
	// per-type index list only when a field has more than one type; a type
	// entry without indices covers every scanned index.
	candidates := map[string]TypeIndices{}
	for field, types := range caps.Fields {
		real := map[string][]string{}
		for typ, fieldCap := range types {
			if typ == "unmapped" {
				continue
			}
			indices := fieldCap.Indices
			if len(indices) == 0 {
				indices = caps.Indices
			}
			real[typ] = indices
		}
		if len(real) > 1 {
			candidates[field] = real
		}
	}

	result := map[string]PatternConflicts{}
	for _, pattern := range patterns {
		matched := map[string]bool{}
		for _, index := range caps.Indices {
			if matchPattern(pattern, index) {
				matched[index] = true
			}
		}
		if len(matched) == 0 {
			continue
		}

		conflicts := map[string]TypeIndices{}
		for field, typeIndices := range candidates {
			local := TypeIndices{}
			for typ, indices := range typeIndices {
				var hit []string
				for _, index := range indices {
					if matched[index] {
						hit = append(hit, index)
					}
				}
				if len(hit) > 0 {
					sort.Strings(hit)
					local[typ] = hit
				}
			}
			if len(local) > 1 {
				conflicts[field] = local
			}
		}
		if len(conflicts) > 0 {
			result[pattern] = PatternConflicts{
				IndexCount: len(matched),
				Conflicts:  conflicts,
			}
		}
	}

	return Snapshot{
		RefreshedAt:          time.Now().UTC(),
		PatternsTotal:        len(patterns),
		PatternsWithConflict: len(result),
		ScannedIndices:       len(caps.Indices),
		ScannedFields:        len(caps.Fields),
		Result:               result,
	}
}

// matchPattern reports whether an index name matches a Dashboards index
// pattern. A pattern without a wildcard is treated as a prefix pattern, the
// way Dashboards resolves bare titles.
func matchPattern(pattern, index string) bool {
	if !strings.Contains(pattern, "*") {
		pattern += "*"
	}
	ok, err := path.Match(pattern, index)
	return err == nil && ok
}
