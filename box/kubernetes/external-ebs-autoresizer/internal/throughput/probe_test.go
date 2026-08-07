package throughput

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/nodes"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/promql"
)

// probeNodes is the cluster the probe lists. The query it builds is scoped to
// these names, which is what the probe exists to prove works.
func probeNodes() []nodes.Node {
	return []nodes.Node{
		gp3Node("ip-1", "i-1", "m5.large", nil),
		gp3Node("ip-2", "i-2", "m5.large", nil),
		gp3Node("ip-3", "i-3", "m5.large", nil),
	}
}

func TestProbe(t *testing.T) {
	n := &fakeNodes{list: probeNodes()}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {
			{Labels: map[string]string{"node": "ip-1"}, Value: 42.5},
			{Labels: map[string]string{"node": "ip-2"}, Value: 287.44},
			{Labels: map[string]string{"node": "ip-3"}, Value: 12},
		},
	}}
	r := newTestRecommender(t, testConfig(), n, p, &fakeEC2{}, &fakeRecorder{})

	got, err := r.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if got.ClusterNodes != 3 || got.Series != 3 || got.Nodes != 3 || got.Dropped != 0 {
		t.Errorf("cluster/series/nodes/dropped = %d/%d/%d/%d, want 3/3/3/0",
			got.ClusterNodes, got.Series, got.Nodes, got.Dropped)
	}
	if got.MaxNode != "ip-2" || got.MaxPeakMiBps != 287.44 {
		t.Errorf("busiest node = %s at %v, want ip-2 at 287.44", got.MaxNode, got.MaxPeakMiBps)
	}
	// The probe must run the same expression the reconcile pass will, scoped to the
	// same node names, or it proves nothing about whether the recommendation works.
	if got.Query != r.query.Peak(nodeNames(probeNodes())) {
		t.Errorf("query = %q, want the peak query scoped to the cluster's nodes", got.Query)
	}
	// The presence fallback must not run when there was something to report.
	if len(p.queries) != 1 {
		t.Errorf("queries = %d, want exactly one", len(p.queries))
	}
}

func TestProbeCountsSeriesMissingTheNodeLabel(t *testing.T) {
	// Scoping by node name means a wrong node label usually yields nothing at all,
	// but a backend that carries the label on only some series still reports the gap.
	n := &fakeNodes{list: probeNodes()}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {
			{Labels: map[string]string{"node": "ip-1"}, Value: 42},
			{Labels: map[string]string{"instance": "10.0.2.7:9100"}, Value: 51},
		},
	}}
	r := newTestRecommender(t, testConfig(), n, p, &fakeEC2{}, &fakeRecorder{})

	got, err := r.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if got.Series != 2 || got.Nodes != 1 || got.Dropped != 1 {
		t.Errorf("series/nodes/dropped = %d/%d/%d, want 2/1/1", got.Series, got.Nodes, got.Dropped)
	}
}

func TestProbeFallsBackToThePresenceCheckWhenNothingMatched(t *testing.T) {
	// An empty scoped result cannot tell a missing scrape from a wrong node label,
	// because both produce zero series. The cheap presence count separates them, and
	// only runs in that case.
	n := &fakeNodes{list: probeNodes()}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"count(node_disk_read_bytes_total": {{Labels: map[string]string{}, Value: 1450}},
	}}
	r := newTestRecommender(t, testConfig(), n, p, &fakeEC2{}, &fakeRecorder{})

	got, err := r.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if got.Series != 0 {
		t.Errorf("series = %d, want 0", got.Series)
	}
	if got.BackendSeries != 1450 {
		t.Errorf("backend series = %d, want 1450: the data exists but is labelled differently", got.BackendSeries)
	}
	if len(p.queries) != 2 {
		t.Errorf("queries = %d, want the observation query plus the presence check", len(p.queries))
	}
	if !strings.HasPrefix(p.queries[1], "count(node_disk_read_bytes_total{") {
		t.Errorf("second query = %q, want the presence check", p.queries[1])
	}
}

func TestProbeReportsNoBackendSeriesWhenTheBackendIsEmpty(t *testing.T) {
	n := &fakeNodes{list: probeNodes()}
	r := newTestRecommender(t, testConfig(), n, &fakeProm{}, &fakeEC2{}, &fakeRecorder{})

	got, err := r.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if got.Series != 0 || got.BackendSeries != 0 {
		t.Errorf("series/backend = %d/%d, want 0/0: no node exporter data at all", got.Series, got.BackendSeries)
	}
}

func TestProbeIgnoresNonFiniteValuesWhenReportingThePeak(t *testing.T) {
	// A reported peak of NaN is useless in a log line an operator is meant to
	// sanity-check against a dashboard.
	n := &fakeNodes{list: probeNodes()}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {
			{Labels: map[string]string{"node": "ip-1"}, Value: math.NaN()},
			{Labels: map[string]string{"node": "ip-2"}, Value: math.Inf(1)},
			{Labels: map[string]string{"node": "ip-3"}, Value: 7},
		},
	}}
	r := newTestRecommender(t, testConfig(), n, p, &fakeEC2{}, &fakeRecorder{})

	got, err := r.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	// All three still count as nodes: they exist, their values are just unusable.
	if got.Nodes != 3 {
		t.Errorf("nodes = %d, want 3", got.Nodes)
	}
	if got.MaxNode != "ip-3" || got.MaxPeakMiBps != 7 {
		t.Errorf("busiest node = %s at %v, want ip-3 at 7", got.MaxNode, got.MaxPeakMiBps)
	}
}

func TestProbeEmptyCluster(t *testing.T) {
	// No Nodes means no query to run: an unscoped one would read every series the
	// backend holds, which is exactly what the scoping avoids.
	p := &fakeProm{}
	r := newTestRecommender(t, testConfig(), &fakeNodes{}, p, &fakeEC2{}, &fakeRecorder{})

	got, err := r.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if got.ClusterNodes != 0 || got.Series != 0 {
		t.Errorf("cluster/series = %d/%d, want 0/0", got.ClusterNodes, got.Series)
	}
	if len(p.queries) != 0 {
		t.Errorf("queries = %v, want none for an empty cluster", p.queries)
	}
}

func TestProbeNodeListError(t *testing.T) {
	sentinel := errors.New("forbidden")
	r := newTestRecommender(t, testConfig(), &fakeNodes{listErr: sentinel}, &fakeProm{}, &fakeEC2{}, &fakeRecorder{})

	if _, err := r.Probe(context.Background()); !errors.Is(err, sentinel) {
		t.Fatalf("Probe() error = %v, want %v", err, sentinel)
	}
}

func TestProbeQueryError(t *testing.T) {
	sentinel := errors.New("connection refused")
	n := &fakeNodes{list: probeNodes()}
	r := newTestRecommender(t, testConfig(), n, &fakeProm{err: sentinel}, &fakeEC2{}, &fakeRecorder{})

	got, err := r.Probe(context.Background())
	if !errors.Is(err, sentinel) {
		t.Fatalf("Probe() error = %v, want %v", err, sentinel)
	}
	// The query is still reported so the failing expression is in the log line.
	if !strings.Contains(got.Query, "quantile_over_time") {
		t.Errorf("query = %q, want it populated even on failure", got.Query)
	}
}

func TestProbeQueriesOnlyOneBatch(t *testing.T) {
	// Proving the query shape works does not require paying for the whole cluster
	// before the first reconcile pass.
	list := make([]nodes.Node, nodeBatch+50)
	for i := range list {
		list[i] = gp3Node("ip-"+string(rune('a'+i%26))+string(rune('a'+i/26)), "i-1", "m5.large", nil)
	}
	p := &fakeProm{}
	r := newTestRecommender(t, testConfig(), &fakeNodes{list: list}, p, &fakeEC2{}, &fakeRecorder{})

	got, err := r.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe() error = %v", err)
	}
	if got.ClusterNodes != nodeBatch+50 {
		t.Errorf("cluster nodes = %d, want %d", got.ClusterNodes, nodeBatch+50)
	}
	// The first batch is in the query and the node just past it is not.
	if !strings.Contains(got.Query, list[0].Name) {
		t.Errorf("query = %s, want it to carry the first node", got.Query)
	}
	if strings.Contains(got.Query, list[nodeBatch].Name) {
		t.Errorf("query carries %s, want only the first %d nodes", list[nodeBatch].Name, nodeBatch)
	}
	// The observation query plus the presence fallback, not one per batch.
	if len(p.queries) != 2 {
		t.Errorf("queries = %d, want 2", len(p.queries))
	}
}
