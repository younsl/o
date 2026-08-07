package awsx

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

type fakeSTS struct {
	arn   string
	calls int
	err   error
}

func (f *fakeSTS) GetCallerIdentity(context.Context, *sts.GetCallerIdentityInput, ...func(*sts.Options)) (*sts.GetCallerIdentityOutput, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return &sts.GetCallerIdentityOutput{
		Arn:     aws.String(f.arn),
		Account: aws.String("123456789012"),
	}, nil
}

func discoverOne() *ec2.DescribeVpnConnectionsOutput {
	return &ec2.DescribeVpnConnectionsOutput{VpnConnections: []types.VpnConnection{sampleConnection()}}
}

func TestVerifyAccessReportsTheAssumedIdentity(t *testing.T) {
	id := &fakeSTS{arn: "arn:aws:sts::123456789012:assumed-role/vpn-maintenance/pod"}
	ec2Fake := &fakeEC2{describeOut: discoverOne()}

	access, err := NewWithAPIs(ec2Fake, id).VerifyAccess(context.Background(), DiscoverInput{})
	if err != nil {
		t.Fatalf("VerifyAccess returned error: %v", err)
	}
	if access.Identity != id.arn {
		t.Fatalf("Identity = %q, want %q", access.Identity, id.arn)
	}
	if access.Account != "123456789012" {
		t.Fatalf("Account = %q", access.Account)
	}
	if len(access.Connections) != 1 {
		t.Fatalf("Connections = %d, want 1", len(access.Connections))
	}
}

// Without credentials the controller can do nothing at all, and the error has to say
// so in the terms an operator can act on rather than as a bare SDK failure.
func TestVerifyAccessFailsWithoutCredentials(t *testing.T) {
	id := &fakeSTS{err: errors.New("no EC2 IMDS role found")}

	_, err := NewWithAPIs(&fakeEC2{describeOut: discoverOne()}, id).VerifyAccess(context.Background(), DiscoverInput{})
	if !errors.Is(err, ErrNoCredentials) {
		t.Fatalf("error = %v, want it to wrap ErrNoCredentials", err)
	}
	if !strings.Contains(err.Error(), "EKS Pod Identity") {
		t.Fatalf("the error should name what is missing: %v", err)
	}
}

// A role that resolves but cannot read is the more common failure: the association
// exists and the policy is wrong.
func TestVerifyAccessFailsWhenDescribeIsDenied(t *testing.T) {
	ec2Fake := &fakeEC2{describeErr: errors.New("UnauthorizedOperation")}

	_, err := NewWithAPIs(ec2Fake, &fakeSTS{arn: "arn:aws:sts::123456789012:assumed-role/vpn/pod"}).
		VerifyAccess(context.Background(), DiscoverInput{})
	if err == nil {
		t.Fatal("a denied DescribeVpnConnections must fail the check")
	}
	if !strings.Contains(err.Error(), "ec2:DescribeVpnConnections") {
		t.Fatalf("the error should name the denied action: %v", err)
	}
}

// Maintenance status is a separate IAM action, so a policy can grant the read and
// miss this one. It must not be discovered during the first window.
func TestVerifyAccessFailsWhenMaintenanceStatusIsDenied(t *testing.T) {
	ec2Fake := &fakeEC2{describeOut: discoverOne(), statusErr: errors.New("UnauthorizedOperation")}

	_, err := NewWithAPIs(ec2Fake, &fakeSTS{arn: "arn:aws:sts::123456789012:assumed-role/vpn/pod"}).
		VerifyAccess(context.Background(), DiscoverInput{})
	if err == nil {
		t.Fatal("a denied GetVpnTunnelReplacementStatus must fail the check")
	}
	if !strings.Contains(err.Error(), "ec2:GetVpnTunnelReplacementStatus") {
		t.Fatalf("the error should name the denied action: %v", err)
	}
}

// Readable but empty is a tag-filter question, not a permission one, so it passes and
// leaves the decision to the caller.
func TestVerifyAccessAllowsAnEmptyResult(t *testing.T) {
	ec2Fake := &fakeEC2{describeOut: &ec2.DescribeVpnConnectionsOutput{}}

	access, err := NewWithAPIs(ec2Fake, &fakeSTS{arn: "arn:aws:sts::123456789012:assumed-role/vpn/pod"}).
		VerifyAccess(context.Background(), DiscoverInput{})
	if err != nil {
		t.Fatalf("an empty but readable account must not fail the check: %v", err)
	}
	if len(access.Connections) != 0 {
		t.Fatalf("Connections = %d, want 0", len(access.Connections))
	}
}

// A Client built without the STS surface cannot prove anything, and silently
// reporting success would defeat the check.
func TestVerifyAccessRefusesWithoutAnSTSClient(t *testing.T) {
	if _, err := NewWithAPI(&fakeEC2{describeOut: discoverOne()}).VerifyAccess(context.Background(), DiscoverInput{}); err == nil {
		t.Fatal("VerifyAccess without an STS client must fail")
	}
}
