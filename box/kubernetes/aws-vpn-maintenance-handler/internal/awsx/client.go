// Package awsx wraps the AWS SDK with the narrow set of Site-to-Site VPN
// operations this controller needs, and centralizes credential resolution.
package awsx

import (
	"context"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

// EC2API is the subset of the EC2 SDK used here. *ec2.Client satisfies it; tests
// provide fakes.
type EC2API interface {
	DescribeVpnConnections(context.Context, *ec2.DescribeVpnConnectionsInput, ...func(*ec2.Options)) (*ec2.DescribeVpnConnectionsOutput, error)
	GetVpnTunnelReplacementStatus(context.Context, *ec2.GetVpnTunnelReplacementStatusInput, ...func(*ec2.Options)) (*ec2.GetVpnTunnelReplacementStatusOutput, error)
	ReplaceVpnTunnel(context.Context, *ec2.ReplaceVpnTunnelInput, ...func(*ec2.Options)) (*ec2.ReplaceVpnTunnelOutput, error)
}

// Client provides the VPN maintenance operations.
type Client struct {
	api EC2API
	// sts backs the startup identity check only. Nil in tests that do not need it.
	sts STSAPI
	// gwAPI reads gateway Name tags, and gateways caches them. Both nil in tests
	// that do not need names, in which case notifications show gateway IDs.
	gwAPI    GatewayAPI
	gateways *gatewayNames
}

// New builds a Client for the region. Credentials resolve via the default chain,
// in-cluster the Pod's own IRSA or EKS Pod Identity role; no role is ever assumed.
func New(ctx context.Context, region string) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}
	ec2Client := ec2.NewFromConfig(cfg)
	return &Client{
		api:      ec2Client,
		sts:      sts.NewFromConfig(cfg),
		gwAPI:    ec2Client,
		gateways: newGatewayNames(),
	}, nil
}

// NewWithAPI builds a Client over an existing EC2API, for tests.
func NewWithAPI(api EC2API) *Client { return &Client{api: api} }

// NewWithAPIs builds a Client over both SDK surfaces, for tests that exercise the
// startup access check.
func NewWithAPIs(api EC2API, id STSAPI) *Client { return &Client{api: api, sts: id} }

// NewWithGateways builds a Client that also resolves gateway Name tags, for tests.
func NewWithGateways(api EC2API, gw GatewayAPI) *Client {
	return &Client{api: api, gwAPI: gw, gateways: newGatewayNames()}
}
