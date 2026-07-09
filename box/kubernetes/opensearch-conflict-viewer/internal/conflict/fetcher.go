package conflict

import (
	"context"
	"fmt"

	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/opensearch"
)

// Source is the OpenSearch surface the fetcher needs.
type Source interface {
	IndexPatterns(ctx context.Context, kibanaIndex string) ([]string, error)
	FieldCapabilities(ctx context.Context, targets string) (opensearch.FieldCaps, error)
}

// Fetcher produces snapshots by combining the Dashboards index patterns with
// one global field-capabilities call.
type Fetcher struct {
	Source      Source
	KibanaIndex string
	Targets     string
	ClusterName string
}

// Fetch runs one aggregation round trip.
func (f *Fetcher) Fetch(ctx context.Context) (Snapshot, error) {
	patterns, err := f.Source.IndexPatterns(ctx, f.KibanaIndex)
	if err != nil {
		return Snapshot{}, fmt.Errorf("index patterns: %w", err)
	}
	caps, err := f.Source.FieldCapabilities(ctx, f.Targets)
	if err != nil {
		return Snapshot{}, fmt.Errorf("field capabilities: %w", err)
	}
	snap := Aggregate(patterns, caps)
	snap.ClusterName = f.ClusterName
	return snap, nil
}
