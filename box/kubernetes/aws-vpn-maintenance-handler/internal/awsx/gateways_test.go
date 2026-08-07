package awsx

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// fakeGateways answers the three gateway describes and counts them, so a test can
// prove the names are cached rather than re-read every pass.
type fakeGateways struct {
	transitCalls  int
	customerCalls int
	vpnCalls      int
	err           error
}

func (f *fakeGateways) DescribeTransitGateways(_ context.Context, in *ec2.DescribeTransitGatewaysInput, _ ...func(*ec2.Options)) (*ec2.DescribeTransitGatewaysOutput, error) {
	f.transitCalls++
	if f.err != nil {
		return nil, f.err
	}
	out := &ec2.DescribeTransitGatewaysOutput{}
	for _, id := range in.TransitGatewayIds {
		out.TransitGateways = append(out.TransitGateways, types.TransitGateway{
			TransitGatewayId: aws.String(id),
			Tags:             []types.Tag{{Key: aws.String("Name"), Value: aws.String("prod-tgw")}},
		})
	}
	return out, nil
}

func (f *fakeGateways) DescribeVpnGateways(_ context.Context, in *ec2.DescribeVpnGatewaysInput, _ ...func(*ec2.Options)) (*ec2.DescribeVpnGatewaysOutput, error) {
	f.vpnCalls++
	if f.err != nil {
		return nil, f.err
	}
	out := &ec2.DescribeVpnGatewaysOutput{}
	for _, id := range in.VpnGatewayIds {
		out.VpnGateways = append(out.VpnGateways, types.VpnGateway{VpnGatewayId: aws.String(id)})
	}
	return out, nil
}

func (f *fakeGateways) DescribeCustomerGateways(_ context.Context, in *ec2.DescribeCustomerGatewaysInput, _ ...func(*ec2.Options)) (*ec2.DescribeCustomerGatewaysOutput, error) {
	f.customerCalls++
	if f.err != nil {
		return nil, f.err
	}
	out := &ec2.DescribeCustomerGatewaysOutput{}
	for _, id := range in.CustomerGatewayIds {
		out.CustomerGateways = append(out.CustomerGateways, types.CustomerGateway{
			CustomerGatewayId: aws.String(id),
			Tags:              []types.Tag{{Key: aws.String("Name"), Value: aws.String("idc-router")}},
		})
	}
	return out, nil
}

// The gateway IDs mean nothing to the person reading the card at 02:00, so the Name
// tags have to come with them.
func TestDiscoverResolvesGatewayNames(t *testing.T) {
	gw := &fakeGateways{}
	client := NewWithGateways(&fakeEC2{describeOut: discoverOne()}, gw)

	conns, err := client.Discover(context.Background(), DiscoverInput{})
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}
	if conns[0].TransitGatewayName != "prod-tgw" {
		t.Fatalf("TransitGatewayName = %q, want prod-tgw", conns[0].TransitGatewayName)
	}
	if conns[0].CustomerGatewayName != "idc-router" {
		t.Fatalf("CustomerGatewayName = %q, want idc-router", conns[0].CustomerGatewayName)
	}
}

// A gateway name changes about never, and the reconcile loop runs every five minutes.
// Re-reading it every pass would be three wasted API calls a pass, forever.
func TestGatewayNamesAreCachedAcrossPasses(t *testing.T) {
	gw := &fakeGateways{}
	client := NewWithGateways(&fakeEC2{describeOut: discoverOne()}, gw)

	for range 3 {
		if _, err := client.Discover(context.Background(), DiscoverInput{}); err != nil {
			t.Fatalf("Discover returned error: %v", err)
		}
	}
	if gw.transitCalls != 1 || gw.customerCalls != 1 {
		t.Fatalf("gateway describes ran %d transit and %d customer times, want 1 each",
			gw.transitCalls, gw.customerCalls)
	}
}

// The names are a label. A missing permission must degrade to the bare ID rather than
// stop discovery, and it must not retry on every pass.
func TestGatewayNamesDegradeWhenDenied(t *testing.T) {
	gw := &fakeGateways{err: errors.New("UnauthorizedOperation")}
	client := NewWithGateways(&fakeEC2{describeOut: discoverOne()}, gw)

	conns, err := client.Discover(context.Background(), DiscoverInput{})
	if err != nil {
		t.Fatalf("a denied gateway describe must not fail discovery: %v", err)
	}
	if conns[0].TransitGatewayName != "" || conns[0].CustomerGatewayName != "" {
		t.Fatalf("names should be empty when the lookup is denied: %+v", conns[0])
	}
	if conns[0].TransitGatewayID == "" {
		t.Fatal("the gateway ID must survive so the card can still identify it")
	}

	if _, err := client.Discover(context.Background(), DiscoverInput{}); err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}
	if gw.transitCalls != 1 {
		t.Fatalf("a denied lookup ran %d times, want 1: it must not retry every pass", gw.transitCalls)
	}
}

// A Client built without the gateway surface still works, with IDs only.
func TestDiscoverWithoutTheGatewayAPI(t *testing.T) {
	conns, err := NewWithAPI(&fakeEC2{describeOut: discoverOne()}).Discover(context.Background(), DiscoverInput{})
	if err != nil {
		t.Fatalf("Discover returned error: %v", err)
	}
	if conns[0].TransitGatewayName != "" {
		t.Fatalf("TransitGatewayName = %q, want empty", conns[0].TransitGatewayName)
	}
}

// A gateway with no Name tag is cached as unnamed, so it is asked for once and then
// rendered as its ID.
func TestGatewayWithoutANameTagIsNotRetried(t *testing.T) {
	gw := &fakeGateways{}
	ec2Fake := &fakeEC2{describeOut: discoverOne()}
	ec2Fake.describeOut.VpnConnections[0].TransitGatewayId = nil
	ec2Fake.describeOut.VpnConnections[0].VpnGatewayId = aws.String("vgw-0abc")

	client := NewWithGateways(ec2Fake, gw)
	for range 2 {
		conns, err := client.Discover(context.Background(), DiscoverInput{})
		if err != nil {
			t.Fatalf("Discover returned error: %v", err)
		}
		if conns[0].VpnGatewayName != "" {
			t.Fatalf("VpnGatewayName = %q, want empty", conns[0].VpnGatewayName)
		}
	}
	if gw.vpnCalls != 1 {
		t.Fatalf("an unnamed gateway was looked up %d times, want 1", gw.vpnCalls)
	}
}
