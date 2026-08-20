package awsx

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/smithy-go"
)

// fakeEC2 records the requests it receives and returns canned responses.
type fakeEC2 struct {
	describeOut *ec2.DescribeVpnConnectionsOutput
	describeErr error
	describeIn  []*ec2.DescribeVpnConnectionsInput

	statusOut map[string]*types.MaintenanceDetails
	statusErr error

	replaceIn  []*ec2.ReplaceVpnTunnelInput
	replaceErr error
}

func (f *fakeEC2) DescribeVpnConnections(_ context.Context, in *ec2.DescribeVpnConnectionsInput, _ ...func(*ec2.Options)) (*ec2.DescribeVpnConnectionsOutput, error) {
	f.describeIn = append(f.describeIn, in)
	if f.describeErr != nil {
		return nil, f.describeErr
	}
	return f.describeOut, nil
}

func (f *fakeEC2) GetVpnTunnelReplacementStatus(_ context.Context, in *ec2.GetVpnTunnelReplacementStatusInput, _ ...func(*ec2.Options)) (*ec2.GetVpnTunnelReplacementStatusOutput, error) {
	if f.statusErr != nil {
		return nil, f.statusErr
	}
	return &ec2.GetVpnTunnelReplacementStatusOutput{
		VpnConnectionId:           in.VpnConnectionId,
		VpnTunnelOutsideIpAddress: in.VpnTunnelOutsideIpAddress,
		MaintenanceDetails:        f.statusOut[aws.ToString(in.VpnTunnelOutsideIpAddress)],
	}, nil
}

func (f *fakeEC2) ReplaceVpnTunnel(_ context.Context, in *ec2.ReplaceVpnTunnelInput, _ ...func(*ec2.Options)) (*ec2.ReplaceVpnTunnelOutput, error) {
	f.replaceIn = append(f.replaceIn, in)
	if f.replaceErr != nil {
		return nil, f.replaceErr
	}
	return &ec2.ReplaceVpnTunnelOutput{Return: aws.Bool(true)}, nil
}

func lastStatusChange() time.Time {
	return time.Date(2026, 7, 21, 1, 0, 0, 0, time.UTC)
}

func sampleConnection() types.VpnConnection {
	return types.VpnConnection{
		VpnConnectionId:   aws.String("vpn-0123456789abcdef0"),
		State:             types.VpnStateAvailable,
		CustomerGatewayId: aws.String("cgw-abc"),
		TransitGatewayId:  aws.String("tgw-xyz"),
		Options:           &types.VpnConnectionOptions{StaticRoutesOnly: aws.Bool(false)},
		Tags: []types.Tag{
			{Key: aws.String("Name"), Value: aws.String("prod-dc")},
			{Key: aws.String("managed"), Value: aws.String("true")},
		},
		VgwTelemetry: []types.VgwTelemetry{
			// Deliberately out of order to exercise the stable sort.
			{
				OutsideIpAddress:   aws.String("203.0.113.20"),
				Status:             types.TelemetryStatusDown,
				StatusMessage:      aws.String("IPSEC IS DOWN"),
				AcceptedRouteCount: aws.Int32(0),
				LastStatusChange:   aws.Time(lastStatusChange()),
			},
			{
				OutsideIpAddress:   aws.String("203.0.113.10"),
				Status:             types.TelemetryStatusUp,
				AcceptedRouteCount: aws.Int32(7),
				LastStatusChange:   aws.Time(lastStatusChange()),
			},
		},
	}
}

func TestDiscoverConvertsAndSorts(t *testing.T) {
	fake := &fakeEC2{describeOut: &ec2.DescribeVpnConnectionsOutput{
		VpnConnections: []types.VpnConnection{sampleConnection()},
	}}
	client := NewWithAPI(fake)

	conns, err := client.Discover(context.Background(), DiscoverInput{
		TagFilters: []TagFilter{{Key: "managed", Value: "true"}, {Key: "team"}},
	})
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}
	if len(conns) != 1 {
		t.Fatalf("expected 1 connection, got %d", len(conns))
	}

	conn := conns[0]
	if conn.Name != "prod-dc" {
		t.Fatalf("Name = %q, want prod-dc (from the Name tag)", conn.Name)
	}
	if conn.Label() != "prod-dc (vpn-0123456789abcdef0)" {
		t.Fatalf("Label() = %q", conn.Label())
	}
	if conn.State != "available" {
		t.Fatalf("State = %q, want available", conn.State)
	}
	if conn.StaticRoutesOnly {
		t.Fatal("StaticRoutesOnly should be false")
	}
	if len(conn.Tunnels) != 2 {
		t.Fatalf("expected 2 tunnels, got %d", len(conn.Tunnels))
	}
	// Sorted by outside IP so logs, metrics, and Slack messages stay stable.
	if conn.Tunnels[0].OutsideIP != "203.0.113.10" {
		t.Fatalf("tunnels are not sorted by outside IP: %s first", conn.Tunnels[0].OutsideIP)
	}
	if !conn.Tunnels[0].Up || conn.Tunnels[0].AcceptedRoutes != 7 {
		t.Fatalf("tunnel 0 = %+v, want UP with 7 routes", conn.Tunnels[0])
	}
	if conn.Tunnels[1].Up || conn.Tunnels[1].StatusMessage != "IPSEC IS DOWN" {
		t.Fatalf("tunnel 1 = %+v, want DOWN with the AWS status message", conn.Tunnels[1])
	}

	// Only available connections are asked for, and a valueless tag filter
	// becomes a tag-key filter rather than a tag:Key= match on the empty string.
	filters := fake.describeIn[0].Filters
	if !hasFilter(filters, "state", "available") {
		t.Fatalf("expected a state=available filter, got %+v", filters)
	}
	if !hasFilter(filters, "tag:managed", "true") {
		t.Fatalf("expected a tag:managed=true filter, got %+v", filters)
	}
	if !hasFilter(filters, "tag-key", "team") {
		t.Fatalf("a filter with no value should become tag-key, got %+v", filters)
	}
}

func TestDiscoverHonoursExcludeIDs(t *testing.T) {
	fake := &fakeEC2{describeOut: &ec2.DescribeVpnConnectionsOutput{
		VpnConnections: []types.VpnConnection{sampleConnection()},
	}}
	conns, err := NewWithAPI(fake).Discover(context.Background(), DiscoverInput{
		ExcludeIDs: []string{"vpn-0123456789abcdef0"},
	})
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}
	if len(conns) != 0 {
		t.Fatalf("excluded connection was returned: %+v", conns)
	}
}

func TestDescribeReportsMissingConnection(t *testing.T) {
	fake := &fakeEC2{describeOut: &ec2.DescribeVpnConnectionsOutput{}}
	if _, err := NewWithAPI(fake).Describe(context.Background(), "vpn-missing"); err == nil {
		t.Fatal("Describe should fail when the connection is not returned")
	}
}

func TestMaintenanceStatusMapsPendingMaintenance(t *testing.T) {
	deadline := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	applied := time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC)
	fake := &fakeEC2{statusOut: map[string]*types.MaintenanceDetails{
		"203.0.113.10": {
			PendingMaintenance:          aws.String("AVAILABLE"),
			MaintenanceAutoAppliedAfter: aws.Time(deadline),
			LastMaintenanceApplied:      aws.Time(applied),
		},
		"203.0.113.20": {PendingMaintenance: aws.String("NOT_AVAILABLE")},
	}}
	client := NewWithAPI(fake)

	pending, err := client.MaintenanceStatus(context.Background(), "vpn-a", "203.0.113.10")
	if err != nil {
		t.Fatalf("MaintenanceStatus returned error: %v", err)
	}
	if !pending.Pending {
		t.Fatal("AVAILABLE must map to Pending")
	}
	if !pending.AutoAppliedAfter.Equal(deadline) || !pending.LastApplied.Equal(applied) {
		t.Fatalf("timestamps not mapped: %+v", pending)
	}

	none, err := client.MaintenanceStatus(context.Background(), "vpn-a", "203.0.113.20")
	if err != nil {
		t.Fatalf("MaintenanceStatus returned error: %v", err)
	}
	if none.Pending {
		t.Fatal("NOT_AVAILABLE must not map to Pending")
	}
}

// AWS omits MaintenanceDetails entirely for some tunnels; that must read as "no
// pending maintenance", not panic.
func TestMaintenanceStatusHandlesMissingDetails(t *testing.T) {
	fake := &fakeEC2{statusOut: map[string]*types.MaintenanceDetails{}}
	got, err := NewWithAPI(fake).MaintenanceStatus(context.Background(), "vpn-a", "203.0.113.10")
	if err != nil {
		t.Fatalf("MaintenanceStatus returned error: %v", err)
	}
	if got.Pending || !got.AutoAppliedAfter.IsZero() {
		t.Fatalf("expected an empty Maintenance, got %+v", got)
	}
}

func TestStatusesCoversEveryTunnel(t *testing.T) {
	fake := &fakeEC2{
		describeOut: &ec2.DescribeVpnConnectionsOutput{VpnConnections: []types.VpnConnection{sampleConnection()}},
		statusOut: map[string]*types.MaintenanceDetails{
			"203.0.113.10": {PendingMaintenance: aws.String("AVAILABLE")},
		},
	}
	client := NewWithAPI(fake)
	conn, err := client.Describe(context.Background(), "vpn-0123456789abcdef0")
	if err != nil {
		t.Fatalf("Describe returned error: %v", err)
	}

	statuses, err := client.Statuses(context.Background(), conn)
	if err != nil {
		t.Fatalf("Statuses returned error: %v", err)
	}
	if len(statuses) != 2 {
		t.Fatalf("expected a status per tunnel, got %d", len(statuses))
	}
	if !statuses[0].Maintenance.Pending || statuses[1].Maintenance.Pending {
		t.Fatalf("pending maintenance mapped to the wrong tunnel: %+v", statuses)
	}
}

func TestReplaceRequestsPendingMaintenance(t *testing.T) {
	fake := &fakeEC2{}
	if err := NewWithAPI(fake).Replace(context.Background(), "vpn-a", "203.0.113.10", false); err != nil {
		t.Fatalf("Replace returned error: %v", err)
	}
	if len(fake.replaceIn) != 1 {
		t.Fatalf("expected exactly one ReplaceVpnTunnel call, got %d", len(fake.replaceIn))
	}
	in := fake.replaceIn[0]
	// Without ApplyPendingMaintenance the call would not trigger the queued
	// endpoint maintenance, which is the entire point of the operation.
	if !aws.ToBool(in.ApplyPendingMaintenance) {
		t.Fatal("ApplyPendingMaintenance must be set")
	}
	if aws.ToBool(in.DryRun) {
		t.Fatal("DryRun must be false for a real replacement")
	}
}

// AWS signals a successful dry run by returning the DryRunOperation error, so
// success arrives as an error and has to be translated back.
func TestReplaceTranslatesDryRunSuccess(t *testing.T) {
	fake := &fakeEC2{replaceErr: &smithy.GenericAPIError{Code: "DryRunOperation", Message: "Request would have succeeded"}}
	err := NewWithAPI(fake).Replace(context.Background(), "vpn-a", "203.0.113.10", true)
	if !errors.Is(err, ErrDryRunSucceeded) {
		t.Fatalf("Replace error = %v, want ErrDryRunSucceeded", err)
	}
	if !aws.ToBool(fake.replaceIn[0].DryRun) {
		t.Fatal("DryRun must be set on a dry-run call")
	}
}

func TestReplacePropagatesRealErrors(t *testing.T) {
	fake := &fakeEC2{replaceErr: &smithy.GenericAPIError{Code: "UnauthorizedOperation", Message: "denied"}}
	err := NewWithAPI(fake).Replace(context.Background(), "vpn-a", "203.0.113.10", false)
	if err == nil {
		t.Fatal("Replace should return the AWS error")
	}
	if errors.Is(err, ErrDryRunSucceeded) {
		t.Fatal("a permission failure must not be reported as a successful dry run")
	}
}

func TestPeerRequiresExactlyTwoTunnels(t *testing.T) {
	two := Connection{Tunnels: []Tunnel{{OutsideIP: "1.1.1.1"}, {OutsideIP: "2.2.2.2"}}}
	peer, ok := two.Peer("1.1.1.1")
	if !ok || peer.OutsideIP != "2.2.2.2" {
		t.Fatalf("Peer = (%+v, %t), want tunnel 2.2.2.2", peer, ok)
	}

	one := Connection{Tunnels: []Tunnel{{OutsideIP: "1.1.1.1"}}}
	if _, ok := one.Peer("1.1.1.1"); ok {
		t.Fatal("a single-tunnel connection has no peer")
	}
	three := Connection{Tunnels: []Tunnel{{OutsideIP: "1.1.1.1"}, {OutsideIP: "2.2.2.2"}, {OutsideIP: "3.3.3.3"}}}
	if _, ok := three.Peer("1.1.1.1"); ok {
		t.Fatal("an unexpected tunnel count must not resolve a peer")
	}
}

func TestLabelFallsBackToTheID(t *testing.T) {
	if got := (Connection{ID: "vpn-a"}).Label(); got != "vpn-a" {
		t.Fatalf("Label() = %q, want the raw ID when there is no Name tag", got)
	}
}

func TestTunnelLookup(t *testing.T) {
	conn := Connection{Tunnels: []Tunnel{{OutsideIP: "1.1.1.1", Up: true}}}
	if tunnel, ok := conn.Tunnel("1.1.1.1"); !ok || !tunnel.Up {
		t.Fatalf("Tunnel = (%+v, %t)", tunnel, ok)
	}
	if _, ok := conn.Tunnel("9.9.9.9"); ok {
		t.Fatal("an unknown outside IP must not resolve")
	}
}

func TestStableForTreatsUnknownAsUnstable(t *testing.T) {
	now := time.Date(2026, 7, 21, 3, 0, 0, 0, time.UTC)
	known := Tunnel{LastStatusChange: now.Add(-90 * time.Minute)}
	if got, want := known.StableFor(now), 90*time.Minute; got != want {
		t.Fatalf("StableFor = %s, want %s", got, want)
	}
	// A zero timestamp must not read as "stable since the epoch", which would let
	// a tunnel of unknown age pass the stability check.
	if got := (Tunnel{}).StableFor(now); got != 0 {
		t.Fatalf("StableFor with no reported change = %s, want 0", got)
	}
}

func TestDeadlineIn(t *testing.T) {
	now := time.Date(2026, 7, 21, 3, 0, 0, 0, time.UTC)
	future := Maintenance{AutoAppliedAfter: now.Add(5 * time.Hour)}
	if got, want := future.DeadlineIn(now), 5*time.Hour; got != want {
		t.Fatalf("DeadlineIn = %s, want %s", got, want)
	}
	past := Maintenance{AutoAppliedAfter: now.Add(-time.Hour)}
	if got := past.DeadlineIn(now); got != 0 {
		t.Fatalf("an elapsed deadline should report 0, got %s", got)
	}
	if got := (Maintenance{}).DeadlineIn(now); got != 0 {
		t.Fatalf("an unpublished deadline should report 0, got %s", got)
	}
}

func hasFilter(filters []types.Filter, name, value string) bool {
	for _, f := range filters {
		if aws.ToString(f.Name) != name {
			continue
		}
		if slices.Contains(f.Values, value) {
			return true
		}
	}
	return false
}
