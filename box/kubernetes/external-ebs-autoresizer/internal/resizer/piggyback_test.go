package resizer

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/recstore"
)

// piggybackConfig is baseConfig with the recommender hand-off enabled, matching
// how main wires the feature: applyOnResize on and a recommender interval to
// derive the freshness bound from.
func piggybackConfig() *config.Config {
	cfg := baseConfig()
	cfg.ThroughputRecommendation = config.ThroughputRecommendation{
		Enabled:       true,
		ApplyOnResize: true,
		Interval:      30 * time.Minute,
	}
	return cfg
}

// increaseEntry is a fresh, applicable increase recommendation for vol-123.
func increaseEntry() recstore.Entry {
	return recstore.Entry{
		NodeName:        "node-1",
		NodeUID:         "uid-1",
		Action:          recstore.ActionIncrease,
		ThroughputMiBps: 250,
		IOPS:            4000,
		CurrentMiBps:    125,
		CurrentIOPS:     3000,
		ObservedAt:      time.Now(),
	}
}

func storeWith(volumeID string, e recstore.Entry) *recstore.Store {
	s := recstore.New()
	s.Publish(volumeID, e)
	return s
}

// fakeNodeEvents records Node Events published by the resizer.
type fakeNodeEvents struct {
	nodes    []string
	uids     []string
	types    []string
	reasons  []string
	messages []string
}

func (f *fakeNodeEvents) NodeEventf(name, uid, eventType, reason, messageFmt string, args ...any) {
	f.nodes = append(f.nodes, name)
	f.uids = append(f.uids, uid)
	f.types = append(f.types, eventType)
	f.reasons = append(f.reasons, reason)
	f.messages = append(f.messages, fmt.Sprintf(messageFmt, args...))
}

func newPiggybackResizer(t *testing.T, cfg *config.Config, ec2 *fakeEC2, rec *fakeRecorder, recs RecommendationSource) *Resizer {
	t.Helper()
	return New(cfg, nil, ec2, &fakeSSM{usage: 85}, rec, nil, nil, nil, recs, nil, discardLogger())
}

func TestPiggybackApplied(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	rec := &fakeRecorder{}
	r := newPiggybackResizer(t, piggybackConfig(), ec2, rec, storeWith("vol-123", increaseEntry()))

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifySpecs) != 1 {
		t.Fatalf("ModifyVolume called %d times, want 1", len(ec2.modifySpecs))
	}
	spec := ec2.modifySpecs[0]
	if spec.SizeGiB != 110 || spec.ThroughputMiBps != 250 || spec.IOPS != 4000 {
		t.Errorf("spec = %+v, want size 110, throughput 250, iops 4000", spec)
	}
	if len(rec.throughputApplies) != 1 || rec.throughputApplies[0] != applyResultApplied {
		t.Errorf("throughputApplies = %v, want [%s]", rec.throughputApplies, applyResultApplied)
	}
	if rec.resizeSuccess != 1 {
		t.Errorf("resizeSuccess = %d, want 1", rec.resizeSuccess)
	}
}

func TestPiggybackFallsBackToSizeOnly(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}, failCombined: true}
	rec := &fakeRecorder{}
	r := newPiggybackResizer(t, piggybackConfig(), ec2, rec, storeWith("vol-123", increaseEntry()))

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifySpecs) != 2 {
		t.Fatalf("ModifyVolume called %d times, want combined then size-only", len(ec2.modifySpecs))
	}
	if ec2.modifySpecs[0].ThroughputMiBps == 0 {
		t.Error("first call should carry the throughput change")
	}
	retry := ec2.modifySpecs[1]
	if retry.SizeGiB != 110 || retry.ThroughputMiBps != 0 || retry.IOPS != 0 {
		t.Errorf("retry spec = %+v, want size-only 110", retry)
	}
	if len(rec.throughputApplies) != 1 || rec.throughputApplies[0] != applyResultFallback {
		t.Errorf("throughputApplies = %v, want [%s]", rec.throughputApplies, applyResultFallback)
	}
	// The size expansion itself must still be a success.
	if rec.resizeSuccess != 1 || rec.resizeFail != 0 {
		t.Errorf("resize success/fail = %d/%d, want 1/0", rec.resizeSuccess, rec.resizeFail)
	}
}

func TestPiggybackSkippedWhenDisabled(t *testing.T) {
	cfg := piggybackConfig()
	cfg.ThroughputRecommendation.ApplyOnResize = false
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	rec := &fakeRecorder{}
	r := newPiggybackResizer(t, cfg, ec2, rec, storeWith("vol-123", increaseEntry()))

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifySpecs) != 1 || ec2.modifySpecs[0].ThroughputMiBps != 0 {
		t.Errorf("specs = %+v, want a single size-only modification", ec2.modifySpecs)
	}
	if len(rec.throughputApplies) != 0 || len(rec.throughputApplySkips) != 0 {
		t.Errorf("applies/skips = %v/%v, want none when the feature is off", rec.throughputApplies, rec.throughputApplySkips)
	}
}

func TestPiggybackSkippedWithoutSource(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	r := newPiggybackResizer(t, piggybackConfig(), ec2, &fakeRecorder{}, nil)

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifySpecs) != 1 || ec2.modifySpecs[0].ThroughputMiBps != 0 {
		t.Errorf("specs = %+v, want a single size-only modification", ec2.modifySpecs)
	}
}

func TestPiggybackIgnoresNonIncreaseAndWrongDirection(t *testing.T) {
	tests := []struct {
		name  string
		entry recstore.Entry
	}{
		{"action none", func() recstore.Entry { e := increaseEntry(); e.Action = "none"; return e }()},
		{"action decrease", func() recstore.Entry { e := increaseEntry(); e.Action = "decrease"; return e }()},
		{"recommendation not above current", func() recstore.Entry {
			e := increaseEntry()
			e.ThroughputMiBps = e.CurrentMiBps
			return e
		}()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
			rec := &fakeRecorder{}
			r := newPiggybackResizer(t, piggybackConfig(), ec2, rec, storeWith("vol-123", tt.entry))
			if _, err := r.Reconcile(context.Background()); err != nil {
				t.Fatalf("Reconcile error: %v", err)
			}
			if len(ec2.modifySpecs) != 1 || ec2.modifySpecs[0].ThroughputMiBps != 0 {
				t.Errorf("specs = %+v, want a single size-only modification", ec2.modifySpecs)
			}
			if len(rec.throughputApplySkips) != 1 || rec.throughputApplySkips[0] != applySkipNotIncrease {
				t.Errorf("throughputApplySkips = %v, want [%s]", rec.throughputApplySkips, applySkipNotIncrease)
			}
		})
	}
}

func TestPiggybackIgnoresStaleRecommendation(t *testing.T) {
	e := increaseEntry()
	// Older than staleFactor * interval (2 * 30m), so the recommender has
	// missed more than one pass and the entry must not be applied.
	e.ObservedAt = time.Now().Add(-2 * time.Hour)
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	rec := &fakeRecorder{}
	r := newPiggybackResizer(t, piggybackConfig(), ec2, rec, storeWith("vol-123", e))

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifySpecs) != 1 || ec2.modifySpecs[0].ThroughputMiBps != 0 {
		t.Errorf("specs = %+v, want a single size-only modification", ec2.modifySpecs)
	}
	// Stale is distinguished from absent: the recommender saw this volume once,
	// so its silence since is the anomaly the metric must name.
	if len(rec.throughputApplySkips) != 1 || rec.throughputApplySkips[0] != applySkipStale {
		t.Errorf("throughputApplySkips = %v, want [%s]", rec.throughputApplySkips, applySkipStale)
	}
}

func TestPiggybackSkipWithNoRecommendation(t *testing.T) {
	// The store is live but has never seen this volume: counted as
	// skipped_no_recommendation, not as stale.
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	rec := &fakeRecorder{}
	r := newPiggybackResizer(t, piggybackConfig(), ec2, rec, recstore.New())

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(rec.throughputApplySkips) != 1 || rec.throughputApplySkips[0] != applySkipNoRecommendation {
		t.Errorf("throughputApplySkips = %v, want [%s]", rec.throughputApplySkips, applySkipNoRecommendation)
	}
}

func TestPiggybackSkipNotObservedOnDryRun(t *testing.T) {
	// A dry run spends no modification slot, so the skip must not be counted.
	cfg := piggybackConfig()
	cfg.DryRun = true
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	rec := &fakeRecorder{}
	r := newPiggybackResizer(t, cfg, ec2, rec, recstore.New())

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(rec.throughputApplies) != 0 || len(rec.throughputApplySkips) != 0 {
		t.Errorf("applies/skips = %v/%v, want none on a dry run", rec.throughputApplies, rec.throughputApplySkips)
	}
}

func TestPiggybackSuccessDescriptionMentionsThroughput(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	n := &fakeNotifier{}
	cfg := piggybackConfig()
	r := New(cfg, nil, ec2, &fakeSSM{usage: 85}, &fakeRecorder{}, nil, n, nil, storeWith("vol-123", increaseEntry()), nil, discardLogger())

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if !strings.Contains(n.lastDescription, "Throughput was raised from 125 to 250 MiB/s") {
		t.Errorf("alert description = %q, want the piggybacked throughput change mentioned", n.lastDescription)
	}
}

// newNodeEventResizer builds a resizer with both a recommendation source and a
// Node Event emitter, the full wiring main uses when the recommender is on.
func newNodeEventResizer(t *testing.T, cfg *config.Config, ec2 *fakeEC2, store RecommendationSource, ne *fakeNodeEvents) *Resizer {
	t.Helper()
	return New(cfg, nil, ec2, &fakeSSM{usage: 85}, &fakeRecorder{}, nil, nil, nil, store, ne, discardLogger())
}

func TestNodeEventOnCombinedModification(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	ne := &fakeNodeEvents{}
	r := newNodeEventResizer(t, piggybackConfig(), ec2, storeWith("vol-123", increaseEntry()), ne)

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ne.reasons) != 1 || ne.reasons[0] != reasonVolumeModified {
		t.Fatalf("node event reasons = %v, want [%s]", ne.reasons, reasonVolumeModified)
	}
	if ne.nodes[0] != "node-1" || ne.types[0] != eventTypeNormal {
		t.Errorf("event target/type = %s/%s, want node-1/Normal", ne.nodes[0], ne.types[0])
	}
	msg := ne.messages[0]
	for _, want := range []string{"vol-123", "size 100 GiB to 110 GiB", "throughput 125 to 250 MiB/s", "IOPS 3000 to 4000"} {
		if !strings.Contains(msg, want) {
			t.Errorf("event message = %q, want it to contain %q", msg, want)
		}
	}
}

func TestNodeEventOnSizeOnlyModification(t *testing.T) {
	// applyOnResize off: the recommendation is not applied, but the store still
	// knows the volume's node, so the size change alone is announced on it.
	cfg := piggybackConfig()
	cfg.ThroughputRecommendation.ApplyOnResize = false
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	ne := &fakeNodeEvents{}
	r := newNodeEventResizer(t, cfg, ec2, storeWith("vol-123", increaseEntry()), ne)

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ne.messages) != 1 {
		t.Fatalf("node events = %v, want exactly one", ne.messages)
	}
	msg := ne.messages[0]
	if !strings.Contains(msg, "size 100 GiB to 110 GiB") {
		t.Errorf("event message = %q, want the size change named", msg)
	}
	if strings.Contains(msg, "throughput") {
		t.Errorf("event message = %q, want no throughput mention on a size-only change", msg)
	}
}

func TestNodeEventOnFallbackNamesTheRejectedChange(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}, failCombined: true}
	ne := &fakeNodeEvents{}
	r := newNodeEventResizer(t, piggybackConfig(), ec2, storeWith("vol-123", increaseEntry()), ne)

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ne.reasons) != 1 || ne.reasons[0] != reasonVolumeModified {
		t.Fatalf("node event reasons = %v, want one %s", ne.reasons, reasonVolumeModified)
	}
	msg := ne.messages[0]
	if !strings.Contains(msg, "size 100 GiB to 110 GiB") {
		t.Errorf("event message = %q, want the applied size change named", msg)
	}
	if !strings.Contains(msg, "throughput increase (125 to 250 MiB/s) was rejected") {
		t.Errorf("event message = %q, want the rejected throughput change named", msg)
	}
}

func TestNodeEventOnFailureNamesAttemptedChanges(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}, waitErr: errors.New("stuck")}
	ne := &fakeNodeEvents{}
	r := newNodeEventResizer(t, piggybackConfig(), ec2, storeWith("vol-123", increaseEntry()), ne)

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ne.reasons) != 1 || ne.reasons[0] != reasonVolumeModifyFailed {
		t.Fatalf("node event reasons = %v, want [%s]", ne.reasons, reasonVolumeModifyFailed)
	}
	if ne.types[0] != eventTypeWarning {
		t.Errorf("event type = %s, want Warning", ne.types[0])
	}
	msg := ne.messages[0]
	for _, want := range []string{"vol-123", "size 100 GiB to 110 GiB", "throughput 125 to 250 MiB/s", `stage "wait"`} {
		if !strings.Contains(msg, want) {
			t.Errorf("event message = %q, want it to contain %q", msg, want)
		}
	}
}

func TestNoNodeEventWithoutNodeRef(t *testing.T) {
	// A volume the recommender has never seen (standalone instance) has no node
	// to address: the resize succeeds with Pod-side reporting only.
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	ne := &fakeNodeEvents{}
	r := newNodeEventResizer(t, piggybackConfig(), ec2, recstore.New(), ne)

	if _, err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ne.messages) != 0 {
		t.Errorf("node events = %v, want none for an unknown node", ne.messages)
	}
}
