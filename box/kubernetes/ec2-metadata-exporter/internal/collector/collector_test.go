package collector

import (
	"context"
	"errors"
	"io"
	"log/slog"
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

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func instance(id, name, privateIP string, state ec2types.InstanceStateName) ec2types.Instance {
	inst := ec2types.Instance{
		InstanceId: aws.String(id),
		State:      &ec2types.InstanceState{Name: state},
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
				instance("i-bbb", "", "10.0.1.11", ec2types.InstanceStateNameStopped),
				instance("i-ccc", "no-ip", "", ec2types.InstanceStateNamePending),
			}}},
		},
	}}
	c := New(client, testLogger())
	c.refresh(context.Background())

	if got := testutil.ToFloat64(c.instances); got != 2 {
		t.Fatalf("instances gauge = %v, want 2", got)
	}
	if got := testutil.ToFloat64(c.info.WithLabelValues("i-aaa", "web-1", "10.0.1.10", "running")); got != 1 {
		t.Fatalf("info{i-aaa} = %v, want 1", got)
	}
	if got := testutil.ToFloat64(c.info.WithLabelValues("i-bbb", "", "10.0.1.11", "stopped")); got != 1 {
		t.Fatalf("info{i-bbb} = %v, want 1", got)
	}
	if got := testutil.CollectAndCount(c.info); got != 2 {
		t.Fatalf("info series count = %v, want 2 (instance without private IP must be skipped)", got)
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
	c := New(client, testLogger())
	c.refresh(context.Background())
	c.refresh(context.Background())

	if got := testutil.CollectAndCount(c.info); got != 1 {
		t.Fatalf("info series count = %v, want 1 after reset", got)
	}
	if got := testutil.ToFloat64(c.info.WithLabelValues("i-new", "new", "10.0.0.2", "running")); got != 1 {
		t.Fatalf("info{i-new} = %v, want 1", got)
	}
}

func TestRefreshCountsScrapeErrors(t *testing.T) {
	c := New(&fakeEC2{err: errors.New("throttled")}, testLogger())
	c.refresh(context.Background())

	if got := testutil.ToFloat64(c.scrapeErrors); got != 1 {
		t.Fatalf("scrape errors = %v, want 1", got)
	}
	if got := testutil.ToFloat64(c.lastSuccess); got != 0 {
		t.Fatalf("last success = %v, want 0 on failure", got)
	}
}

func TestRunStopsOnContextCancel(t *testing.T) {
	c := New(&fakeEC2{pages: []*ec2.DescribeInstancesOutput{{}, {}, {}, {}}}, testLogger())
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
