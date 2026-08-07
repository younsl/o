package throughput

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/nodes"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/promql"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/recstore"
)

// prefix is the fixed annotation key prefix; it is a constant in the package
// rather than a setting, so the tests assert against the same constant.
const prefix = AnnotationPrefix

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

type fakeNodes struct {
	list     []nodes.Node
	listErr  error
	selector string
	patches  []patch
	patchErr error
}

type patch struct {
	node   string
	set    map[string]string
	remove []string
}

func (f *fakeNodes) List(_ context.Context, selector string) ([]nodes.Node, error) {
	f.selector = selector
	return f.list, f.listErr
}

func (f *fakeNodes) Annotate(_ context.Context, name string, set map[string]string, remove []string) error {
	if f.patchErr != nil {
		return f.patchErr
	}
	f.patches = append(f.patches, patch{node: name, set: maps.Clone(set), remove: slices.Clone(remove)})
	return nil
}

// patchFor returns the recorded patch for a node, or nil when it was not
// patched.
func (f *fakeNodes) patchFor(node string) *patch {
	for i := range f.patches {
		if f.patches[i].node == node {
			return &f.patches[i]
		}
	}
	return nil
}

type fakeProm struct {
	// byQuery maps a substring of the query to its result, so a test declares
	// "the peak query returns this" without repeating the whole expression.
	byQuery map[string][]promql.Sample
	err     error
	queries []string
}

func (f *fakeProm) Query(_ context.Context, query string) ([]promql.Sample, error) {
	f.queries = append(f.queries, query)
	if f.err != nil {
		return nil, f.err
	}
	for fragment, samples := range f.byQuery {
		if strings.Contains(query, fragment) {
			return samples, nil
		}
	}
	return nil, nil
}

type fakeEC2 struct {
	volumes    map[string][]awsx.Volume
	volumesErr error
	caps       map[string]awsx.EBSCaps
	capsErr    error
}

func (f *fakeEC2) DescribeAttachedVolumes(_ context.Context, _ []string) (map[string][]awsx.Volume, error) {
	return f.volumes, f.volumesErr
}

func (f *fakeEC2) DescribeInstanceTypeEBSCaps(_ context.Context, _ []string) (map[string]awsx.EBSCaps, error) {
	return f.caps, f.capsErr
}

type fakeRecorder struct {
	resets    int
	gauges    []gauge
	actions   []string
	reasons   []string
	errStages []string
}

type gauge struct {
	node                            string
	current, peak, recommendedMiBps float64
}

func (f *fakeRecorder) ResetNodeThroughput() { f.resets++ }
func (f *fakeRecorder) ObserveNodeThroughput(node, _, _ string, current, peak, recommended float64) {
	f.gauges = append(f.gauges, gauge{node: node, current: current, peak: peak, recommendedMiBps: recommended})
}
func (f *fakeRecorder) ObserveRecommendation(action, reason string) {
	f.actions = append(f.actions, action)
	f.reasons = append(f.reasons, reason)
}
func (f *fakeRecorder) ObserveError(stage string) { f.errStages = append(f.errStages, stage) }

type nodeEvent struct {
	node, uid, eventType, reason, message string
}

type fakeEvents struct {
	events []nodeEvent
}

func (f *fakeEvents) NodeEventf(name, uid, eventType, reason, messageFmt string, args ...any) {
	f.events = append(f.events, nodeEvent{
		node: name, uid: uid, eventType: eventType, reason: reason,
		message: fmt.Sprintf(messageFmt, args...),
	})
}

// testConfig is the recommender config the tests share: a 7d window, whose
// derived minimum sample count the fixtures then have to satisfy.
func testConfig() Config {
	return Config{
		MetricNodeNameLabel: "node",
		Lookback:            "7d",
		LookbackDuration:    7 * 24 * time.Hour,
	}
}

// gp3Node builds a node with one attached gp3 volume.
func gp3Node(name, instanceID, instanceType string, annotations map[string]string) nodes.Node {
	return nodes.Node{
		Name: name, InstanceID: instanceID, InstanceType: instanceType, Annotations: annotations,
	}
}

func newTestRecommender(t *testing.T, cfg Config, n *fakeNodes, p *fakeProm, e *fakeEC2, r *fakeRecorder) *Recommender {
	t.Helper()
	return newTestRecommenderWithEvents(t, cfg, n, p, e, r, nil)
}

func newTestRecommenderWithEvents(t *testing.T, cfg Config, n *fakeNodes, p *fakeProm, e *fakeEC2, r *fakeRecorder, ev NodeEventEmitter) *Recommender {
	t.Helper()
	rec := New(cfg, n, p, e, r, ev, nil, discardLogger())
	// A fixed clock keeps throughput-observed-at deterministic and lets the staleness refresh
	// and the node age filter be exercised without waiting.
	rec.now = testNow
	return rec
}

// testNow is the fixed clock every test recommender runs on.
func testNow() time.Time { return time.Date(2026, 7, 31, 4, 12, 7, 0, time.UTC) }

// annotatedNode is old enough to query and already carries exactly what a pass
// measuring a 200 MiB/s peak would write, so its outcome is "unchanged".
func annotatedNode() nodes.Node {
	n := agedNode("ip-1", "i-1", 30*24*time.Hour)
	n.Annotations = map[string]string{
		prefix + "/volume-id":                        "vol-1",
		prefix + "/throughput-current-mibps":         "125",
		prefix + "/throughput-observed-peak-mibps":   "200.0",
		prefix + "/throughput-utilization-percent":   "160.0",
		prefix + "/throughput-recommended-mibps":     "375",
		prefix + "/iops-current":                     "3000",
		prefix + "/iops-recommended":                 "3000",
		prefix + "/throughput-recommendation":        ActionIncrease,
		prefix + "/throughput-recommendation-reason": ReasonAboveProvisioned,
		prefix + "/throughput-observation-window":    "7d/p99",
		prefix + "/throughput-observation-samples":   "10080",
		prefix + "/throughput-observed-at":           "2026-07-31T03:00:00Z",
	}
	return n
}

func TestReconcileAnnotatesAnIncrease(t *testing.T) {
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-10-0-1-5", "i-1", "m5.4xlarge", nil)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 200}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 10080}},
	}}
	e := &fakeEC2{
		volumes: map[string][]awsx.Volume{"i-1": {{
			ID: "vol-1", Type: "gp3", InstanceID: "i-1", Device: "/dev/xvda",
			ThroughputMiBps: 125, IOPS: 3000, SizeGiB: 100,
		}}},
		caps: map[string]awsx.EBSCaps{"m5.4xlarge": {BaselineMBps: 593.75, MaximumMBps: 1250}},
	}
	r := &fakeRecorder{}

	count, err := newTestRecommender(t, testConfig(), n, p, e, r).Reconcile(context.Background())
	if err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if count != 1 {
		t.Errorf("nodes considered = %d, want 1", count)
	}

	got := n.patchFor("ip-10-0-1-5")
	if got == nil {
		t.Fatal("node was not annotated")
	}
	want := map[string]string{
		prefix + "/volume-id":                        "vol-1",
		prefix + "/throughput-current-mibps":         "125",
		prefix + "/throughput-observed-peak-mibps":   "200.0",
		prefix + "/throughput-utilization-percent":   "160.0",
		prefix + "/throughput-recommended-mibps":     "375",
		prefix + "/iops-current":                     "3000",
		prefix + "/iops-recommended":                 "3000",
		prefix + "/throughput-recommendation":        ActionIncrease,
		prefix + "/throughput-recommendation-reason": ReasonAboveProvisioned,
		prefix + "/throughput-observation-window":    "7d/p99",
		prefix + "/throughput-observation-samples":   "10080",
		prefix + "/throughput-observed-at":           "2026-07-31T04:12:07Z",
	}
	if !maps.Equal(got.set, want) {
		t.Errorf("annotations =\n%v\nwant\n%v", got.set, want)
	}
	if len(got.remove) != 0 {
		t.Errorf("removed keys = %v, want none", got.remove)
	}
	if r.resets != 1 {
		t.Errorf("gauge resets = %d, want 1", r.resets)
	}
	if len(r.gauges) != 1 || r.gauges[0].peak != 200 || r.gauges[0].recommendedMiBps != 375 {
		t.Errorf("gauges = %+v, want one node at peak 200 recommending 375", r.gauges)
	}
	if len(r.actions) != 1 || r.actions[0] != ActionIncrease {
		t.Errorf("recorded actions = %v, want [%s]", r.actions, ActionIncrease)
	}
}

func TestReconcileOmitsUtilizationWhenThePeakIsNotANumber(t *testing.T) {
	// A NaN peak is missing data, not idleness. Publishing "NaN" as a utilization
	// percentage would read like a broken volume rather than a broken query, so the
	// key is left off entirely and queued for removal.
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-10-0-1-5", "i-1", "m5.4xlarge", nil)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: math.NaN()}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{"i-1": {{
		ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000,
	}}}}

	if _, err := newTestRecommender(t, testConfig(), n, p, e, &fakeRecorder{}).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	got := n.patchFor("ip-10-0-1-5")
	if got == nil {
		t.Fatal("node was not annotated")
	}
	if v, ok := got.set[prefix+"/throughput-utilization-percent"]; ok {
		t.Errorf("utilization = %q, want the key omitted", v)
	}
	if !slices.Contains(got.remove, prefix+"/throughput-utilization-percent") {
		t.Errorf("utilization key was not queued for removal; removed = %v", got.remove)
	}
}

func TestReconcileSkipsThePatchWhenNothingChanged(t *testing.T) {
	// The annotations already on the node are exactly what this pass computes,
	// with a fresh throughput-observed-at, so no write is due. Without this the recommender
	// would rewrite every node's annotations on every pass, churning etcd and the
	// resourceVersion of every Node in the cluster for no new information.
	existing := map[string]string{
		prefix + "/volume-id":                        "vol-1",
		prefix + "/throughput-current-mibps":         "125",
		prefix + "/throughput-observed-peak-mibps":   "50.0",
		prefix + "/throughput-utilization-percent":   "40.0",
		prefix + "/throughput-recommended-mibps":     "125",
		prefix + "/iops-current":                     "3000",
		prefix + "/iops-recommended":                 "3000",
		prefix + "/throughput-recommendation":        ActionNone,
		prefix + "/throughput-recommendation-reason": ReasonFits,
		prefix + "/throughput-observation-window":    "7d/p99",
		prefix + "/throughput-observation-samples":   "10080",
		prefix + "/throughput-observed-at":           "2026-07-31T03:00:00Z",
	}
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-10-0-1-5", "i-1", "m5.4xlarge", existing)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 50}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{"i-1": {{
		ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000,
	}}}}

	if _, err := newTestRecommender(t, testConfig(), n, p, e, &fakeRecorder{}).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if len(n.patches) != 0 {
		t.Errorf("patches = %v, want none", n.patches)
	}
}

func TestReconcileRefreshesStaleAnnotationsUnchanged(t *testing.T) {
	// Same values, but throughput-observed-at is older than the refresh interval. A timestamp
	// left frozen would leave an operator unable to tell a steady recommendation
	// from a stopped recommender.
	existing := map[string]string{
		prefix + "/volume-id":                        "vol-1",
		prefix + "/throughput-current-mibps":         "125",
		prefix + "/throughput-observed-peak-mibps":   "50.0",
		prefix + "/throughput-utilization-percent":   "40.0",
		prefix + "/throughput-recommended-mibps":     "125",
		prefix + "/iops-current":                     "3000",
		prefix + "/iops-recommended":                 "3000",
		prefix + "/throughput-recommendation":        ActionNone,
		prefix + "/throughput-recommendation-reason": ReasonFits,
		prefix + "/throughput-observation-window":    "7d/p99",
		prefix + "/throughput-observation-samples":   "10080",
		prefix + "/throughput-observed-at":           "2026-07-28T04:12:07Z",
	}
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-10-0-1-5", "i-1", "m5.4xlarge", existing)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 50}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{"i-1": {{
		ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000,
	}}}}

	if _, err := newTestRecommender(t, testConfig(), n, p, e, &fakeRecorder{}).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	got := n.patchFor("ip-10-0-1-5")
	if got == nil {
		t.Fatal("stale annotations were not refreshed")
	}
	if got.set[prefix+"/throughput-observed-at"] != "2026-07-31T04:12:07Z" {
		t.Errorf("throughput-observed-at = %q, want the current time", got.set[prefix+"/throughput-observed-at"])
	}
}

func TestReconcileRemovesStaleNumbersWhenANodeBecomesUnevaluable(t *testing.T) {
	// The node previously carried a full recommendation; its volume has since been
	// detached. Leaving the last numbers behind would present a stale
	// recommendation as a current one.
	existing := map[string]string{
		prefix + "/volume-id":                        "vol-1",
		prefix + "/throughput-current-mibps":         "125",
		prefix + "/throughput-observed-peak-mibps":   "200.0",
		prefix + "/throughput-utilization-percent":   "160.0",
		prefix + "/throughput-recommended-mibps":     "375",
		prefix + "/iops-current":                     "3000",
		prefix + "/iops-recommended":                 "3000",
		prefix + "/throughput-recommendation":        ActionIncrease,
		prefix + "/throughput-recommendation-reason": ReasonAboveProvisioned,
		prefix + "/throughput-observation-window":    "7d/p99",
		prefix + "/throughput-observation-samples":   "10080",
		prefix + "/throughput-observed-at":           "2026-07-31T03:00:00Z",
	}
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-10-0-1-5", "i-1", "m5.4xlarge", existing)}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{}}

	if _, err := newTestRecommender(t, testConfig(), n, &fakeProm{}, e, &fakeRecorder{}).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	got := n.patchFor("ip-10-0-1-5")
	if got == nil {
		t.Fatal("node was not re-annotated")
	}
	if got.set[prefix+"/throughput-recommendation"] != ActionUnknown || got.set[prefix+"/throughput-recommendation-reason"] != ReasonNoVolume {
		t.Errorf("recommendation = %q/%q, want %q/%q",
			got.set[prefix+"/throughput-recommendation"], got.set[prefix+"/throughput-recommendation-reason"], ActionUnknown, ReasonNoVolume)
	}
	for _, key := range []string{"volume-id", "throughput-current-mibps", "throughput-recommended-mibps", "iops-recommended", "throughput-utilization-percent", "throughput-observation-samples"} {
		if !slices.Contains(got.remove, prefix+"/"+key) {
			t.Errorf("key %q was not removed; removed = %v", key, got.remove)
		}
	}
}

func TestReconcileBlockedReasons(t *testing.T) {
	tests := []struct {
		name       string
		node       nodes.Node
		volumes    map[string][]awsx.Volume
		samples    []promql.Sample
		wantReason string
		wantPatch  bool
	}{
		{
			name:       "a node with no providerID is not annotated at all",
			node:       gp3Node("virtual-1", "", "", nil),
			wantReason: ReasonNotEC2Node,
			wantPatch:  false,
		},
		{
			name:       "a node with no attached volume reports why",
			node:       gp3Node("ip-1", "i-1", "m5.large", nil),
			volumes:    map[string][]awsx.Volume{},
			wantReason: ReasonNoVolume,
			wantPatch:  true,
		},
		{
			name: "a node with two volumes is left alone rather than guessed at",
			node: gp3Node("ip-1", "i-1", "m5.large", nil),
			volumes: map[string][]awsx.Volume{"i-1": {
				{ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000},
				{ID: "vol-2", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000},
			}},
			wantReason: ReasonMultipleVolumes,
			wantPatch:  true,
		},
		{
			name: "a node the query returned no series for reports missing metrics",
			node: gp3Node("ip-1", "i-1", "m5.large", nil),
			volumes: map[string][]awsx.Volume{"i-1": {
				{ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000},
			}},
			samples:    nil,
			wantReason: ReasonNoMetrics,
			wantPatch:  true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			n := &fakeNodes{list: []nodes.Node{tt.node}}
			p := &fakeProm{byQuery: map[string][]promql.Sample{"quantile_over_time": tt.samples}}
			e := &fakeEC2{volumes: tt.volumes}
			r := &fakeRecorder{}

			if _, err := newTestRecommender(t, testConfig(), n, p, e, r).Reconcile(context.Background()); err != nil {
				t.Fatalf("Reconcile() error = %v", err)
			}
			if len(r.reasons) != 1 || r.reasons[0] != tt.wantReason {
				t.Fatalf("recorded reasons = %v, want [%s]", r.reasons, tt.wantReason)
			}
			got := n.patchFor(tt.node.Name)
			if tt.wantPatch != (got != nil) {
				t.Fatalf("patched = %v, want %v", got != nil, tt.wantPatch)
			}
			// A blocked node has no measured throughput, so no gauge may claim one.
			if len(r.gauges) != 0 {
				t.Errorf("gauges = %+v, want none for a blocked node", r.gauges)
			}
		})
	}
}

func TestReconcileDryRunWritesNothing(t *testing.T) {
	cfg := testConfig()
	cfg.DryRun = true
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-1", "i-1", "m5.4xlarge", nil)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-1"}, Value: 900}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-1"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{"i-1": {{
		ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000,
	}}}}
	r := &fakeRecorder{}

	if _, err := newTestRecommender(t, cfg, n, p, e, r).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if len(n.patches) != 0 {
		t.Errorf("patches = %v, want none in dry-run", n.patches)
	}
	// The recommendation is still computed and reported, which is the whole point
	// of a dry run.
	if len(r.actions) != 1 || r.actions[0] != ActionIncrease {
		t.Errorf("actions = %v, want [%s]", r.actions, ActionIncrease)
	}
}

func TestReconcileErrors(t *testing.T) {
	sentinel := errors.New("boom")
	tests := []struct {
		name      string
		nodes     *fakeNodes
		prom      *fakeProm
		ec2       *fakeEC2
		wantStage string
	}{
		{
			name:      "listing nodes",
			nodes:     &fakeNodes{listErr: sentinel},
			prom:      &fakeProm{},
			ec2:       &fakeEC2{},
			wantStage: "node_list",
		},
		{
			name:      "querying metrics",
			nodes:     &fakeNodes{list: []nodes.Node{gp3Node("ip-1", "i-1", "m5.large", nil)}},
			prom:      &fakeProm{err: sentinel},
			ec2:       &fakeEC2{},
			wantStage: "query_peak",
		},
		{
			name:      "describing volumes",
			nodes:     &fakeNodes{list: []nodes.Node{gp3Node("ip-1", "i-1", "m5.large", nil)}},
			prom:      &fakeProm{},
			ec2:       &fakeEC2{volumesErr: sentinel},
			wantStage: "describe_volumes",
		},
		{
			name:      "describing instance types",
			nodes:     &fakeNodes{list: []nodes.Node{gp3Node("ip-1", "i-1", "m5.large", nil)}},
			prom:      &fakeProm{},
			ec2:       &fakeEC2{capsErr: sentinel},
			wantStage: "describe_instance_types",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := &fakeRecorder{}
			_, err := newTestRecommender(t, testConfig(), tt.nodes, tt.prom, tt.ec2, r).Reconcile(context.Background())
			if !errors.Is(err, sentinel) {
				t.Fatalf("Reconcile() error = %v, want %v", err, sentinel)
			}
			if !slices.Contains(r.errStages, tt.wantStage) {
				t.Errorf("error stages = %v, want to contain %q", r.errStages, tt.wantStage)
			}
			if len(tt.nodes.patches) != 0 {
				t.Errorf("patches = %v, want none after a gather failure", tt.nodes.patches)
			}
		})
	}
}

func TestReconcileAnnotateFailureDoesNotAbortThePass(t *testing.T) {
	n := &fakeNodes{
		list: []nodes.Node{
			gp3Node("ip-1", "i-1", "m5.4xlarge", nil),
			gp3Node("ip-2", "i-2", "m5.4xlarge", nil),
		},
		patchErr: errors.New("conflict"),
	}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {
			{Labels: map[string]string{"node": "ip-1"}, Value: 400},
			{Labels: map[string]string{"node": "ip-2"}, Value: 400},
		},
		"count_over_time": {
			{Labels: map[string]string{"node": "ip-1"}, Value: 10080},
			{Labels: map[string]string{"node": "ip-2"}, Value: 10080},
		},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{
		"i-1": {{ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000}},
		"i-2": {{ID: "vol-2", Type: "gp3", InstanceID: "i-2", ThroughputMiBps: 125, IOPS: 3000}},
	}}
	r := &fakeRecorder{}

	count, err := newTestRecommender(t, testConfig(), n, p, e, r).Reconcile(context.Background())
	if err != nil {
		t.Fatalf("Reconcile() error = %v, want nil: a per-node failure must not abort the pass", err)
	}
	if count != 2 {
		t.Errorf("nodes considered = %d, want 2", count)
	}
	if len(r.errStages) != 2 {
		t.Errorf("error stages = %v, want one per node", r.errStages)
	}
}

func TestReconcileNoNodes(t *testing.T) {
	n := &fakeNodes{}
	r := &fakeRecorder{}
	count, err := newTestRecommender(t, testConfig(), n, &fakeProm{}, &fakeEC2{}, r).Reconcile(context.Background())
	if err != nil || count != 0 {
		t.Fatalf("Reconcile() = %d, %v, want 0, nil", count, err)
	}
	if r.resets != 0 {
		t.Error("gauges were reset without any node to evaluate")
	}
}

func TestQueryByNodeDropsSeriesWithoutTheNodeLabel(t *testing.T) {
	// A cluster whose node exporter is not relabelled carries the node name in
	// "instance", not "node". Attributing such a series to some other node would
	// be worse than dropping it, so it is dropped and warned about.
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-1", "i-1", "m5.4xlarge", nil)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"instance": "10.0.1.5:9100"}, Value: 400}},
		"count_over_time":    {{Labels: map[string]string{"instance": "10.0.1.5:9100"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{"i-1": {{
		ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000,
	}}}}
	r := &fakeRecorder{}

	if _, err := newTestRecommender(t, testConfig(), n, p, e, r).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if len(r.reasons) != 1 || r.reasons[0] != ReasonNoMetrics {
		t.Errorf("reasons = %v, want [%s]", r.reasons, ReasonNoMetrics)
	}
}

func TestReconcileCappedByInstanceBandwidth(t *testing.T) {
	// An m5.large cannot drive the throughput its volume could provision, so the
	// recommendation must stop at the instance ceiling and say so.
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-1", "i-1", "m5.large", nil)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-1"}, Value: 900}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-1"}, Value: 10080}},
	}}
	e := &fakeEC2{
		volumes: map[string][]awsx.Volume{"i-1": {{
			ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000,
		}}},
		caps: map[string]awsx.EBSCaps{"m5.large": {BaselineMBps: 81.25, MaximumMBps: 593.75}},
	}
	r := &fakeRecorder{}

	if _, err := newTestRecommender(t, testConfig(), n, p, e, r).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	got := n.patchFor("ip-1")
	if got == nil {
		t.Fatal("node was not annotated")
	}
	if got.set[prefix+"/throughput-recommendation-reason"] != ReasonInstanceBandwidthCap {
		t.Errorf("reason = %q, want %q", got.set[prefix+"/throughput-recommendation-reason"], ReasonInstanceBandwidthCap)
	}
	if got.set[prefix+"/throughput-recommended-mibps"] != "566" {
		t.Errorf("recommended = %q, want 566 (593.75 MB/s in MiB/s)", got.set[prefix+"/throughput-recommended-mibps"])
	}
}

func TestReconcileEmitsAMeasurementStartedEventPerNode(t *testing.T) {
	// The Event goes on the Node so the measurement is visible in
	// kubectl describe node without reading the controller's logs.
	list := []nodes.Node{
		{Name: "ip-1", UID: "uid-1", InstanceID: "i-1", InstanceType: "m5.large"},
		{Name: "ip-2", UID: "uid-2", InstanceID: "i-2", InstanceType: "m5.large"},
		// Not EC2-backed, and still measured: the Event marks the start of the
		// evaluation, before anything is known about the node's volume.
		{Name: "virtual-1", UID: "uid-3"},
	}
	n := &fakeNodes{list: list}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-1"}, Value: 200}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-1"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{"i-1": {{
		ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000,
	}}}}
	ev := &fakeEvents{}

	rec := newTestRecommenderWithEvents(t, testConfig(), n, p, e, &fakeRecorder{}, ev)
	if _, err := rec.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}

	if len(ev.events) != 3 {
		t.Fatalf("events = %d, want one per node", len(ev.events))
	}
	got := ev.events[0]
	if got.node != "ip-1" || got.uid != "uid-1" {
		t.Errorf("event target = %s/%s, want ip-1/uid-1", got.node, got.uid)
	}
	if got.reason != reasonMeasurementStarted {
		t.Errorf("reason = %q, want %q", got.reason, reasonMeasurementStarted)
	}
	if got.eventType != "Normal" {
		t.Errorf("type = %q, want Normal", got.eventType)
	}
	// The message has to say the window it measures and that nothing is modified,
	// since an Event on a Node otherwise reads like an action was taken.
	if !strings.Contains(got.message, "7d/p99") || !strings.Contains(got.message, "no volume is modified") {
		t.Errorf("message = %q, want the window and the read-only note", got.message)
	}
}

func TestReconcileWithoutAnEventEmitter(t *testing.T) {
	// Events are auxiliary: running outside a cluster, or with the emitter
	// unavailable, must not stop recommendations.
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-1", "i-1", "m5.large", nil)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-1"}, Value: 200}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-1"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{"i-1": {{
		ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000,
	}}}}

	if _, err := newTestRecommender(t, testConfig(), n, p, e, &fakeRecorder{}).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if n.patchFor("ip-1") == nil {
		t.Error("node was not annotated without an event emitter")
	}
}

// agedNode builds a node created age ago, so the age pre-filter can be exercised
// against the fixed test clock.
func agedNode(name, instanceID string, age time.Duration) nodes.Node {
	return nodes.Node{
		Name: name, UID: "uid-" + name, InstanceID: instanceID, InstanceType: "m5.large",
		CreatedAt: testNow().Add(-age),
	}
}

func TestReconcileSkipsQueryingNodesTooYoungToHaveHistory(t *testing.T) {
	// A node created an hour ago cannot hold 30% of a 7d window, so querying a
	// multi-day range for it can only ever return insufficient_samples. The
	// observation query is the most expensive thing the addon does, so it is not
	// asked at all.
	list := []nodes.Node{
		agedNode("old", "i-1", 30*24*time.Hour),
		agedNode("young", "i-2", time.Hour),
	}
	n := &fakeNodes{list: list}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "old"}, Value: 200}},
		"count_over_time":    {{Labels: map[string]string{"node": "old"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{
		"i-1": {{ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000}},
		"i-2": {{ID: "vol-2", Type: "gp3", InstanceID: "i-2", ThroughputMiBps: 125, IOPS: 3000}},
	}}
	r := &fakeRecorder{}

	if _, err := newTestRecommender(t, testConfig(), n, p, e, r).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}

	// The young node's name must not appear in either query.
	for _, q := range p.queries {
		if strings.Contains(q, "young") {
			t.Errorf("query %s carries the young node, want it excluded", q)
		}
		if !strings.Contains(q, "old") {
			t.Errorf("query %s dropped the eligible node", q)
		}
	}

	// It is still reported, with the reason naming its age rather than a missing
	// scrape, which would send an operator after a problem that does not exist.
	got := n.patchFor("young")
	if got == nil {
		t.Fatal("young node was not annotated")
	}
	if got.set[prefix+"/throughput-recommendation-reason"] != ReasonNodeTooYoung {
		t.Errorf("reason = %q, want %q", got.set[prefix+"/throughput-recommendation-reason"], ReasonNodeTooYoung)
	}
	// Its volume is known, so the current provisioning is still reported.
	if got.set[prefix+"/volume-id"] != "vol-2" {
		t.Errorf("volume = %q, want vol-2", got.set[prefix+"/volume-id"])
	}
	// No measured peak may be claimed for a node that was never queried.
	if _, ok := got.set[prefix+"/throughput-observed-peak-mibps"]; ok {
		t.Error("young node reports an observed peak it was never measured for")
	}
	if n.patchFor("old") == nil {
		t.Error("eligible node was not annotated")
	}
}

func TestReconcileIssuesNoQueryWhenEveryNodeIsTooYoung(t *testing.T) {
	// With no eligible node there is nothing to ask, and an unscoped query would
	// read every series the backend holds. A brand-new cluster must cost nothing.
	n := &fakeNodes{list: []nodes.Node{agedNode("young", "i-1", time.Minute)}}
	p := &fakeProm{}

	if _, err := newTestRecommender(t, testConfig(), n, p, &fakeEC2{}, &fakeRecorder{}).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if len(p.queries) != 0 {
		t.Errorf("queries = %v, want none", p.queries)
	}
}

func TestReconcileQueriesNodesWithNoCreationTimestamp(t *testing.T) {
	// An unknown age is not evidence of youth. Treating it as young would silently
	// drop the node from every pass.
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-1", "i-1", "m5.large", nil)}}
	p := &fakeProm{}

	if _, err := newTestRecommender(t, testConfig(), n, p, &fakeEC2{}, &fakeRecorder{}).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if len(p.queries) != 2 {
		t.Errorf("queries = %d, want the node queried", len(p.queries))
	}
}

func TestMinNodeAgeMatchesTheSampleGate(t *testing.T) {
	// The age gate has to be derived from the same fraction as the sample gate, or
	// it would drop nodes that could have passed. 30% of 7d is about 2 days.
	cfg := testConfig()
	if got, want := cfg.minNodeAge(), 50*time.Hour+24*time.Minute; got < want-time.Hour || got > want+time.Hour {
		t.Errorf("minNodeAge() = %s, want about %s (30%% of 7d)", got, want)
	}
	// A node exactly at the threshold has enough window to reach minSamples.
	if float64(cfg.minNodeAge())/float64(time.Minute) < float64(cfg.settings().MinSamples) {
		t.Errorf("minNodeAge() = %s holds fewer than %d 1m points",
			cfg.minNodeAge(), cfg.settings().MinSamples)
	}
}

func TestReconcileLogsEachNodeAnnotationOutcome(t *testing.T) {
	tests := []struct {
		name        string
		node        nodes.Node
		patchErr    error
		dryRun      bool
		wantOutcome string
		wantLevel   string
	}{
		{
			name:        "a written patch is logged at info with the values",
			node:        agedNode("ip-1", "i-1", 30*24*time.Hour),
			wantOutcome: "written",
			wantLevel:   "INFO",
		},
		{
			name:        "a dry run says what it would have written",
			node:        agedNode("ip-1", "i-1", 30*24*time.Hour),
			dryRun:      true,
			wantOutcome: "dry_run",
			wantLevel:   "INFO",
		},
		{
			name:        "a failure is logged at error",
			node:        agedNode("ip-1", "i-1", 30*24*time.Hour),
			patchErr:    errors.New("conflict"),
			wantOutcome: "failed",
			wantLevel:   "ERROR",
		},
		{
			// Almost every node is unchanged on every pass, so info would bury the
			// writes.
			name:        "an unchanged node is logged at debug",
			node:        annotatedNode(),
			wantOutcome: "unchanged",
			wantLevel:   "DEBUG",
		},
		{
			name:        "a non-EC2 node is logged at debug as out of scope",
			node:        nodes.Node{Name: "virtual-1"},
			wantOutcome: "not_applicable",
			wantLevel:   "DEBUG",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var logged strings.Builder
			cfg := testConfig()
			cfg.DryRun = tt.dryRun
			n := &fakeNodes{list: []nodes.Node{tt.node}, patchErr: tt.patchErr}
			p := &fakeProm{byQuery: map[string][]promql.Sample{
				"quantile_over_time": {{Labels: map[string]string{"node": tt.node.Name}, Value: 200}},
				"count_over_time":    {{Labels: map[string]string{"node": tt.node.Name}, Value: 10080}},
			}}
			e := &fakeEC2{volumes: map[string][]awsx.Volume{
				"i-1": {{ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000}},
			}}

			rec := New(cfg, n, p, e, &fakeRecorder{}, nil, nil,
				slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug})))
			rec.now = testNow

			if _, err := rec.Reconcile(context.Background()); err != nil {
				t.Fatalf("Reconcile() error = %v", err)
			}

			out := logged.String()
			if !strings.Contains(out, `outcome=`+tt.wantOutcome) {
				t.Errorf("log = %q, want outcome=%s", out, tt.wantOutcome)
			}
			if !strings.Contains(out, "level="+tt.wantLevel) {
				t.Errorf("log = %q, want level %s", out, tt.wantLevel)
			}
			// Every per-node line has to name the node, or a pass over hundreds of
			// nodes is unreadable.
			if !strings.Contains(out, "node="+tt.node.Name) {
				t.Errorf("log = %q, want the node named", out)
			}
		})
	}
}

// fakeSink records the hand-off calls a Reconcile pass makes.
type fakeSink struct {
	published map[string]recstore.Entry
	deleted   []string
	retained  []map[string]struct{}
}

func newFakeSink() *fakeSink {
	return &fakeSink{published: make(map[string]recstore.Entry)}
}

func (f *fakeSink) Publish(volumeID string, e recstore.Entry) { f.published[volumeID] = e }
func (f *fakeSink) Delete(volumeID string)                    { f.deleted = append(f.deleted, volumeID) }
func (f *fakeSink) Retain(keep map[string]struct{})           { f.retained = append(f.retained, keep) }

func newSinkRecommender(t *testing.T, n *fakeNodes, p *fakeProm, e *fakeEC2, sink RecommendationSink) *Recommender {
	t.Helper()
	rec := New(testConfig(), n, p, e, &fakeRecorder{}, nil, sink, discardLogger())
	rec.now = testNow
	return rec
}

func TestReconcileHandsOffDecisionsToTheSink(t *testing.T) {
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-10-0-1-5", "i-1", "m5.4xlarge", nil)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 200}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{"i-1": {{
		ID: "vol-1", Type: "gp3", InstanceID: "i-1", ThroughputMiBps: 125, IOPS: 3000,
	}}}}
	sink := newFakeSink()

	if _, err := newSinkRecommender(t, n, p, e, sink).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}

	got, ok := sink.published["vol-1"]
	if !ok {
		t.Fatalf("published = %v, want an entry for vol-1", sink.published)
	}
	want := recstore.Entry{
		NodeName: "ip-10-0-1-5", Action: ActionIncrease,
		ThroughputMiBps: 375, IOPS: 3000, CurrentMiBps: 125, CurrentIOPS: 3000,
		ObservedAt: testNow(),
	}
	if got != want {
		t.Errorf("published entry = %+v, want %+v", got, want)
	}
	if len(sink.retained) != 1 {
		t.Fatalf("Retain called %d times, want 1", len(sink.retained))
	}
	if _, ok := sink.retained[0]["vol-1"]; !ok || len(sink.retained[0]) != 1 {
		t.Errorf("retained = %v, want exactly {vol-1}", sink.retained[0])
	}
}

func TestReconcileDeletesUndecidableVolumesFromTheSink(t *testing.T) {
	// The node's volume is known but its type is unsupported, so the decision is
	// unknown: any previously published recommendation for it must be deleted.
	n := &fakeNodes{list: []nodes.Node{gp3Node("ip-10-0-1-5", "i-1", "m5.4xlarge", nil)}}
	p := &fakeProm{byQuery: map[string][]promql.Sample{
		"quantile_over_time": {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 200}},
		"count_over_time":    {{Labels: map[string]string{"node": "ip-10-0-1-5"}, Value: 10080}},
	}}
	e := &fakeEC2{volumes: map[string][]awsx.Volume{"i-1": {{
		ID: "vol-1", Type: "gp2", InstanceID: "i-1",
	}}}}
	sink := newFakeSink()

	if _, err := newSinkRecommender(t, n, p, e, sink).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}

	if len(sink.published) != 0 {
		t.Errorf("published = %v, want none for an undecidable volume", sink.published)
	}
	if !slices.Contains(sink.deleted, "vol-1") {
		t.Errorf("deleted = %v, want vol-1 deleted", sink.deleted)
	}
	// The volume still exists, so the sweep must keep it (the Delete above is
	// what removed the entry, not the sweep).
	if len(sink.retained) != 1 {
		t.Fatalf("Retain called %d times, want 1", len(sink.retained))
	}
	if _, ok := sink.retained[0]["vol-1"]; !ok {
		t.Errorf("retained = %v, want vol-1 kept", sink.retained[0])
	}
}

func TestReconcileEmptiesTheSinkWhenNoNodesExist(t *testing.T) {
	sink := newFakeSink()
	n := &fakeNodes{}
	p := &fakeProm{}
	e := &fakeEC2{}

	if _, err := newSinkRecommender(t, n, p, e, sink).Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile() error = %v", err)
	}
	if len(sink.retained) != 1 || len(sink.retained[0]) != 0 {
		t.Errorf("retained = %v, want one empty sweep", sink.retained)
	}
}
