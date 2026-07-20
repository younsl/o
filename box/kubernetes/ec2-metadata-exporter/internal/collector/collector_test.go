package collector

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

type fakeEC2 struct {
	pages []*ec2.DescribeInstancesOutput
	err   error
	calls int
}

func (f *fakeEC2) DescribeInstances(_ context.Context, _ *ec2.DescribeInstancesInput, _ ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error) {
	if f.err != nil {
		return nil, f.err
	}
	page := f.pages[f.calls]
	f.calls++
	return page, nil
}

type fakeReady struct {
	states []bool
}

func (f *fakeReady) SetReady(ready bool) {
	f.states = append(f.states, ready)
}

func (f *fakeReady) last() (bool, bool) {
	if len(f.states) == 0 {
		return false, false
	}
	return f.states[len(f.states)-1], true
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func newTestCollector(client ec2.DescribeInstancesAPIClient) *Collector {
	return New(client, testLogger(), nil)
}

func instance(id, name, privateIP string, state ec2types.InstanceStateName) ec2types.Instance {
	inst := ec2types.Instance{
		InstanceId:   aws.String(id),
		InstanceType: ec2types.InstanceTypeM5Large,
		Architecture: ec2types.ArchitectureValuesX8664,
		Placement:    &ec2types.Placement{AvailabilityZone: aws.String("ap-northeast-2a")},
		State:        &ec2types.InstanceState{Name: state},
	}
	if privateIP != "" {
		inst.PrivateIpAddress = aws.String(privateIP)
	}
	if name != "" {
		inst.Tags = []ec2types.Tag{
			{Key: aws.String("Team"), Value: aws.String("devops")},
			{Key: aws.String("Name"), Value: aws.String(name)},
		}
	}
	return inst
}

func spotInstance(id, name, privateIP string, state ec2types.InstanceStateName) ec2types.Instance {
	inst := instance(id, name, privateIP, state)
	inst.InstanceLifecycle = ec2types.InstanceLifecycleTypeSpot
	return inst
}

func TestRefreshPublishesInstanceInfo(t *testing.T) {
	client := &fakeEC2{pages: []*ec2.DescribeInstancesOutput{
		{
			Reservations: []ec2types.Reservation{{Instances: []ec2types.Instance{
				instance("i-aaa", "web-1", "10.0.1.10", ec2types.InstanceStateNameRunning),
			}}},
			NextToken: aws.String("page2"),
		},
		{
			Reservations: []ec2types.Reservation{{Instances: []ec2types.Instance{
				spotInstance("i-bbb", "", "10.0.1.11", ec2types.InstanceStateNameStopped),
				instance("i-ccc", "no-ip", "", ec2types.InstanceStateNamePending),
			}}},
		},
	}}
	c := newTestCollector(client)
	c.refresh(context.Background())

	expected := `
# HELP ec2_metadata_instance_info EC2 instance metadata. Value is always 1; labels carry the private IP, Name tag, instance type, availability zone, lifecycle (on-demand or spot), and CPU architecture.
# TYPE ec2_metadata_instance_info gauge
ec2_metadata_instance_info{architecture="x86_64",availability_zone="ap-northeast-2a",instance_id="i-aaa",instance_type="m5.large",lifecycle="on-demand",name="web-1",private_ip="10.0.1.10",state="running"} 1
ec2_metadata_instance_info{architecture="x86_64",availability_zone="ap-northeast-2a",instance_id="i-bbb",instance_type="m5.large",lifecycle="spot",name="",private_ip="10.0.1.11",state="stopped"} 1
# HELP ec2_metadata_instances Number of EC2 instances observed in the last successful scrape, by instance state.
# TYPE ec2_metadata_instances gauge
ec2_metadata_instances{state="running"} 1
ec2_metadata_instances{state="stopped"} 1
`
	if err := testutil.CollectAndCompare(c, strings.NewReader(expected),
		"ec2_metadata_instance_info", "ec2_metadata_instances"); err != nil {
		t.Fatalf("unexpected metrics (instance without private IP must be skipped): %v", err)
	}
}

func TestRefreshResetsRemovedInstances(t *testing.T) {
	client := &fakeEC2{pages: []*ec2.DescribeInstancesOutput{
		{Reservations: []ec2types.Reservation{{Instances: []ec2types.Instance{
			instance("i-old", "old", "10.0.0.1", ec2types.InstanceStateNameRunning),
		}}}},
		{Reservations: []ec2types.Reservation{{Instances: []ec2types.Instance{
			instance("i-new", "new", "10.0.0.2", ec2types.InstanceStateNameRunning),
		}}}},
	}}
	c := newTestCollector(client)
	c.refresh(context.Background())
	c.refresh(context.Background())

	expected := `
# HELP ec2_metadata_instance_info EC2 instance metadata. Value is always 1; labels carry the private IP, Name tag, instance type, availability zone, lifecycle (on-demand or spot), and CPU architecture.
# TYPE ec2_metadata_instance_info gauge
ec2_metadata_instance_info{architecture="x86_64",availability_zone="ap-northeast-2a",instance_id="i-new",instance_type="m5.large",lifecycle="on-demand",name="new",private_ip="10.0.0.2",state="running"} 1
`
	if err := testutil.CollectAndCompare(c, strings.NewReader(expected), "ec2_metadata_instance_info"); err != nil {
		t.Fatalf("old instance must be replaced by new snapshot: %v", err)
	}
}

func TestRefreshKeepsSnapshotOnFailure(t *testing.T) {
	client := &fakeEC2{pages: []*ec2.DescribeInstancesOutput{
		{Reservations: []ec2types.Reservation{{Instances: []ec2types.Instance{
			instance("i-aaa", "web-1", "10.0.1.10", ec2types.InstanceStateNameRunning),
		}}}},
	}}
	c := newTestCollector(client)
	c.refresh(context.Background())

	client.err = errors.New("throttled")
	c.refresh(context.Background())

	if got := testutil.CollectAndCount(c, "ec2_metadata_instance_info"); got != 1 {
		t.Fatalf("info series count = %v, want 1 (previous snapshot must keep serving on failure)", got)
	}
}

func TestLifecycle(t *testing.T) {
	if got := lifecycle(""); got != "on-demand" {
		t.Fatalf("lifecycle(\"\") = %q, want on-demand", got)
	}
	if got := lifecycle(ec2types.InstanceLifecycleTypeSpot); got != "spot" {
		t.Fatalf("lifecycle(spot) = %q, want spot", got)
	}
}

func TestRefreshCountsScrapeErrors(t *testing.T) {
	c := newTestCollector(&fakeEC2{err: errors.New("throttled")})
	c.refresh(context.Background())

	if got := testutil.ToFloat64(c.scrapeErrors); got != 1 {
		t.Fatalf("scrape errors = %v, want 1", got)
	}
	if got := testutil.ToFloat64(c.lastSuccess); got != 0 {
		t.Fatalf("last success = %v, want 0 on failure", got)
	}
}

func TestReadinessFollowsScrapeOutcome(t *testing.T) {
	client := &fakeEC2{err: errors.New("throttled")}
	ready := &fakeReady{}
	c := New(client, testLogger(), ready)

	c.refresh(context.Background())
	if _, ok := ready.last(); ok {
		t.Fatal("readiness must not be reported before the first successful scrape")
	}

	client.err = nil
	client.pages = []*ec2.DescribeInstancesOutput{{}}
	c.refresh(context.Background())
	if last, ok := ready.last(); !ok || !last {
		t.Fatalf("readiness after first successful scrape = %v (reported=%v), want true", last, ok)
	}
}

func TestRegistryServesAllExporterMetrics(t *testing.T) {
	c := newTestCollector(&fakeEC2{pages: []*ec2.DescribeInstancesOutput{{}}})
	c.refresh(context.Background())

	families, err := c.Registry().Gather()
	if err != nil {
		t.Fatalf("Gather() error = %v", err)
	}
	got := make(map[string]bool, len(families))
	for _, mf := range families {
		got[mf.GetName()] = true
	}
	for _, name := range []string{
		"ec2_metadata_scrape_errors_total",
		"ec2_metadata_scrape_duration_seconds",
		"ec2_metadata_last_scrape_success_timestamp_seconds",
	} {
		if !got[name] {
			t.Errorf("registry is missing %s, got %v", name, got)
		}
	}
}

type countingEC2 struct {
	calls atomic.Int32
}

func (f *countingEC2) DescribeInstances(_ context.Context, _ *ec2.DescribeInstancesInput, _ ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error) {
	f.calls.Add(1)
	return &ec2.DescribeInstancesOutput{}, nil
}

func TestRunRefreshesOnTick(t *testing.T) {
	client := &countingEC2{}
	c := newTestCollector(client)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.Run(ctx, 5*time.Millisecond)
		close(done)
	}()

	deadline := time.After(5 * time.Second)
	for client.calls.Load() < 2 {
		select {
		case <-deadline:
			cancel()
			t.Fatalf("expected at least 2 refreshes (initial + tick), got %d", client.calls.Load())
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	<-done
}

func TestRunStopsOnContextCancel(t *testing.T) {
	c := newTestCollector(&fakeEC2{pages: []*ec2.DescribeInstancesOutput{{}, {}, {}, {}}})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		c.Run(ctx, time.Hour)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after context cancel")
	}
}

func TestAvailabilityZone(t *testing.T) {
	if got := availabilityZone(nil); got != "" {
		t.Fatalf("availabilityZone(nil) = %q, want empty", got)
	}
	p := &ec2types.Placement{AvailabilityZone: aws.String("ap-northeast-2c")}
	if got := availabilityZone(p); got != "ap-northeast-2c" {
		t.Fatalf("availabilityZone = %q, want ap-northeast-2c", got)
	}
}

func TestNameTag(t *testing.T) {
	tags := []ec2types.Tag{
		{Key: aws.String("Env"), Value: aws.String("prod")},
		{Key: aws.String("Name"), Value: aws.String("api-server")},
	}
	if got := nameTag(tags); got != "api-server" {
		t.Fatalf("nameTag = %q, want %q", got, "api-server")
	}
	if got := nameTag(nil); got != "" {
		t.Fatalf("nameTag(nil) = %q, want empty", got)
	}
}
