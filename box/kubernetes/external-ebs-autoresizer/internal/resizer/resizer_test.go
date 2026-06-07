package resizer

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/scripts"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestTargetSize(t *testing.T) {
	tests := []struct {
		current int32
		grow    int
		want    int32
	}{
		{100, 10, 110},
		{105, 10, 116}, // 115.5 -> ceil 116
		{8, 10, 9},     // 8.8 -> 9
		{1, 10, 2},     // 1.1 -> ceil 2, but also min current+1
		{10, 5, 11},    // 10.5 -> 11
		{200, 50, 300},
	}
	for _, tt := range tests {
		if got := TargetSize(tt.current, tt.grow); got != tt.want {
			t.Errorf("TargetSize(%d, %d) = %d, want %d", tt.current, tt.grow, got, tt.want)
		}
	}
}

func TestParseUsagePercent(t *testing.T) {
	valid := map[string]int{"73\n": 73, " 80% ": 80, "0": 0, "100": 100}
	for in, want := range valid {
		got, err := parseUsagePercent(in)
		if err != nil || got != want {
			t.Errorf("parseUsagePercent(%q) = (%d, %v), want (%d, nil)", in, got, err, want)
		}
	}
	for _, in := range []string{"", "abc", "150", "-5"} {
		if _, err := parseUsagePercent(in); err == nil {
			t.Errorf("parseUsagePercent(%q) = nil error, want error", in)
		}
	}
}

// fakeEC2 implements resizer.EC2API.
type fakeEC2 struct {
	instances   []awsx.Instance
	lastMod     *awsx.VolumeModification
	modifyCalls []int32
	modifyErr   error
	waitErr     error
	describeErr error
}

func (f *fakeEC2) DescribeTargetInstances(_ context.Context, _ []awsx.TagFilter) ([]awsx.Instance, error) {
	return f.instances, f.describeErr
}
func (f *fakeEC2) ModifyVolume(_ context.Context, _ string, sizeGiB int32) error {
	f.modifyCalls = append(f.modifyCalls, sizeGiB)
	return f.modifyErr
}
func (f *fakeEC2) DescribeLastModification(_ context.Context, _ string) (*awsx.VolumeModification, error) {
	return f.lastMod, nil
}
func (f *fakeEC2) WaitForModification(_ context.Context, _ string, _ time.Duration) error {
	return f.waitErr
}

// fakeSSM implements resizer.SSMAPI, returning usage for measure and ok for resize.
type fakeSSM struct {
	usage     int
	runErr    error
	resizeOut string
}

func (f *fakeSSM) RunScript(_ context.Context, _, script string, _ time.Duration) (awsx.CommandResult, error) {
	if f.runErr != nil {
		return awsx.CommandResult{}, f.runErr
	}
	if script == scripts.MeasureRootFS {
		return awsx.CommandResult{Status: "Success", Stdout: itoa(f.usage)}, nil
	}
	return awsx.CommandResult{Status: "Success", Stdout: f.resizeOut}, nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

type fakeRecorder struct {
	resizeSuccess int
	resizeFail    int
	errors        []string
}

func (r *fakeRecorder) ObserveUsage(string, float64) {}
func (r *fakeRecorder) ObserveResize(success bool) {
	if success {
		r.resizeSuccess++
	} else {
		r.resizeFail++
	}
}
func (r *fakeRecorder) ObserveError(stage string) { r.errors = append(r.errors, stage) }

// fakeEmitter records the reasons of emitted Kubernetes Events.
type fakeEmitter struct {
	reasons []string
}

func (e *fakeEmitter) Eventf(_, reason, _ string, _ ...any) {
	e.reasons = append(e.reasons, reason)
}

func baseConfig() *config.Config {
	return &config.Config{
		TagFilters:            []config.TagFilter{{Key: "App", Value: "web"}},
		UsageThresholdPercent: 80,
		GrowPercent:           10,
		MaxVolumeSizeGiB:      1000,
		SSMCommandTimeout:     time.Second,
		VolumeModifyTimeout:   time.Second,
	}
}

func sampleInstance() awsx.Instance {
	return awsx.Instance{
		ID: "i-123", Name: "web-1",
		RootDeviceName: "/dev/xvda", RootVolumeID: "vol-123", RootVolumeSizeGiB: 100,
	}
}

func newResizer(t *testing.T, cfg *config.Config, ec2 EC2API, ssm SSMAPI, rec Recorder) *Resizer {
	t.Helper()
	return New(cfg, ec2, ssm, rec, nil, discardLogger())
}

func TestReconcileBelowThreshold(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	ssm := &fakeSSM{usage: 50}
	rec := &fakeRecorder{}
	r := newResizer(t, baseConfig(), ec2, ssm, rec)

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifyCalls) != 0 {
		t.Errorf("ModifyVolume called %d times, want 0", len(ec2.modifyCalls))
	}
}

func TestReconcileTriggersResize(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	ssm := &fakeSSM{usage: 85}
	rec := &fakeRecorder{}
	r := newResizer(t, baseConfig(), ec2, ssm, rec)

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifyCalls) != 1 || ec2.modifyCalls[0] != 110 {
		t.Errorf("modifyCalls = %v, want [110]", ec2.modifyCalls)
	}
	if rec.resizeSuccess != 1 {
		t.Errorf("resizeSuccess = %d, want 1", rec.resizeSuccess)
	}
}

func TestReconcileDryRun(t *testing.T) {
	cfg := baseConfig()
	cfg.DryRun = true
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	ssm := &fakeSSM{usage: 95}
	r := newResizer(t, cfg, ec2, ssm, &fakeRecorder{})

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifyCalls) != 0 {
		t.Errorf("dry-run modified volume: %v", ec2.modifyCalls)
	}
}

func TestReconcileCooldownSkips(t *testing.T) {
	ec2 := &fakeEC2{
		instances: []awsx.Instance{sampleInstance()},
		lastMod:   &awsx.VolumeModification{State: "completed", StartTime: time.Now().Add(-time.Hour)},
	}
	r := newResizer(t, baseConfig(), ec2, &fakeSSM{usage: 90}, &fakeRecorder{})

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifyCalls) != 0 {
		t.Errorf("cooldown should skip modify, got %v", ec2.modifyCalls)
	}
}

func TestReconcileInProgressSkips(t *testing.T) {
	ec2 := &fakeEC2{
		instances: []awsx.Instance{sampleInstance()},
		lastMod:   &awsx.VolumeModification{State: "optimizing"},
	}
	r := newResizer(t, baseConfig(), ec2, &fakeSSM{usage: 90}, &fakeRecorder{})

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifyCalls) != 0 {
		t.Errorf("in-progress modification should skip, got %v", ec2.modifyCalls)
	}
}

func TestReconcileMaxSizeSkips(t *testing.T) {
	cfg := baseConfig()
	cfg.MaxVolumeSizeGiB = 105
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	r := newResizer(t, cfg, ec2, &fakeSSM{usage: 90}, &fakeRecorder{})

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifyCalls) != 0 {
		t.Errorf("target above max should skip, got %v", ec2.modifyCalls)
	}
}

func TestReconcileNoRootVolume(t *testing.T) {
	inst := sampleInstance()
	inst.RootVolumeID = ""
	ec2 := &fakeEC2{instances: []awsx.Instance{inst}}
	r := newResizer(t, baseConfig(), ec2, &fakeSSM{usage: 90}, &fakeRecorder{})

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ec2.modifyCalls) != 0 {
		t.Errorf("no root volume should skip, got %v", ec2.modifyCalls)
	}
}

func TestReconcileDiscoverError(t *testing.T) {
	ec2 := &fakeEC2{describeErr: errors.New("boom")}
	rec := &fakeRecorder{}
	r := newResizer(t, baseConfig(), ec2, &fakeSSM{}, rec)

	if err := r.Reconcile(context.Background()); err == nil {
		t.Error("Reconcile = nil error, want discover error")
	}
	if len(rec.errors) != 1 || rec.errors[0] != "discover" {
		t.Errorf("errors = %v, want [discover]", rec.errors)
	}
}

func TestReconcileModifyError(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}, modifyErr: errors.New("nope")}
	rec := &fakeRecorder{}
	r := newResizer(t, baseConfig(), ec2, &fakeSSM{usage: 90}, rec)

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile should swallow per-instance error, got %v", err)
	}
	if rec.resizeFail != 1 {
		t.Errorf("resizeFail = %d, want 1", rec.resizeFail)
	}
}

func reasonsEqual(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestReconcileEmitsStartedAndCompletedEvents(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	ev := &fakeEmitter{}
	r := New(baseConfig(), ec2, &fakeSSM{usage: 85}, &fakeRecorder{}, ev, discardLogger())

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	want := []string{reasonResizeStarted, reasonResizeCompleted}
	if !reasonsEqual(ev.reasons, want) {
		t.Errorf("event reasons = %v, want %v", ev.reasons, want)
	}
}

func TestReconcileEmitsFailedEvent(t *testing.T) {
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}, modifyErr: errors.New("nope")}
	ev := &fakeEmitter{}
	r := New(baseConfig(), ec2, &fakeSSM{usage: 90}, &fakeRecorder{}, ev, discardLogger())

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile should swallow per-instance error, got %v", err)
	}
	want := []string{reasonResizeStarted, reasonResizeFailed}
	if !reasonsEqual(ev.reasons, want) {
		t.Errorf("event reasons = %v, want %v", ev.reasons, want)
	}
}

func TestReconcileDryRunEmitsNoEvents(t *testing.T) {
	cfg := baseConfig()
	cfg.DryRun = true
	ec2 := &fakeEC2{instances: []awsx.Instance{sampleInstance()}}
	ev := &fakeEmitter{}
	r := New(cfg, ec2, &fakeSSM{usage: 95}, &fakeRecorder{}, ev, discardLogger())

	if err := r.Reconcile(context.Background()); err != nil {
		t.Fatalf("Reconcile error: %v", err)
	}
	if len(ev.reasons) != 0 {
		t.Errorf("dry-run emitted events: %v", ev.reasons)
	}
}
