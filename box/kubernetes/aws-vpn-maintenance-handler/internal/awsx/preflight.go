package awsx

import (
	"context"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// STSAPI is the subset of the STS SDK used here, which is only the identity call.
type STSAPI interface {
	GetCallerIdentity(context.Context, *sts.GetCallerIdentityInput, ...func(*sts.Options)) (*sts.GetCallerIdentityOutput, error)
}

// Access is what the startup check learned about this Pod's AWS access.
type Access struct {
	// Identity is the assumed role's ARN, which is what tells IRSA apart from EKS
	// Pod Identity apart from a node role picked up by accident.
	Identity string
	// Account is the account the credentials resolved to.
	Account string
	// Connections are the managed connections the read call returned. Empty is a
	// tag-filter problem or an empty account, not a permission problem.
	Connections []Connection
}

// ErrNoCredentials reports that the default chain produced nothing usable. In a Pod
// that means neither IRSA nor EKS Pod Identity is wired up.
var ErrNoCredentials = errors.New("no usable AWS credentials")

// VerifyAccess proves at startup that this Pod can actually do its job, instead of
// discovering a missing permission when maintenance is first queued.
//
// The three calls mirror the three the controller depends on: credentials resolve at
// all, the managed connections are readable, and their maintenance status is
// readable. ReplaceVpnTunnel is deliberately not probed: there is no way to test it
// that does not either change something or depend on maintenance being queued right
// now, which is why dryRun exists.
func (c *Client) VerifyAccess(ctx context.Context, in DiscoverInput) (Access, error) {
	var access Access

	if c.sts == nil {
		return access, errors.New("STS client is not configured, so AWS credentials cannot be verified")
	}
	id, err := c.sts.GetCallerIdentity(ctx, &sts.GetCallerIdentityInput{})
	if err != nil {
		return access, fmt.Errorf("%w: sts:GetCallerIdentity failed, so neither IRSA nor EKS Pod Identity is "+
			"providing credentials to this Pod: %w", ErrNoCredentials, err)
	}
	access.Identity = aws.ToString(id.Arn)
	access.Account = aws.ToString(id.Account)

	conns, err := c.Discover(ctx, in)
	if err != nil {
		return access, fmt.Errorf("ec2:DescribeVpnConnections failed as %s, so managed connections cannot be "+
			"discovered: %w", access.Identity, err)
	}
	access.Connections = conns
	if len(conns) == 0 {
		// Readable but empty. Not a permission failure, and not this function's call
		// to make fatal: an account may legitimately have nothing enrolled yet.
		return access, nil
	}

	// One connection is enough to prove the permission. Probing all of them would
	// multiply API calls at startup for an answer that does not vary per connection.
	if _, err := c.Statuses(ctx, conns[0]); err != nil {
		return access, fmt.Errorf("ec2:GetVpnTunnelReplacementStatus failed for %s as %s, so pending maintenance "+
			"cannot be read: %w", conns[0].ID, access.Identity, err)
	}
	return access, nil
}
