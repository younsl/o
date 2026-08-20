package awsx

import (
	"context"
	"log/slog"
	"slices"
	"sync"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// GatewayAPI reads the Name tags of the gateways a VPN connection attaches to.
// DescribeVpnConnections returns their IDs only, and an approver reading a card at
// 02:00 recognizes "prod-tgw", not "tgw-0abcdef1234567890".
type GatewayAPI interface {
	DescribeTransitGateways(context.Context, *ec2.DescribeTransitGatewaysInput, ...func(*ec2.Options)) (*ec2.DescribeTransitGatewaysOutput, error)
	DescribeVpnGateways(context.Context, *ec2.DescribeVpnGatewaysInput, ...func(*ec2.Options)) (*ec2.DescribeVpnGatewaysOutput, error)
	DescribeCustomerGateways(context.Context, *ec2.DescribeCustomerGatewaysInput, ...func(*ec2.Options)) (*ec2.DescribeCustomerGatewaysOutput, error)
}

// gatewayNames caches gateway ID to Name tag.
//
// Every ID that was looked up is cached, including the ones that resolved to nothing,
// so a gateway without a Name tag and a missing IAM permission both cost one call per
// process rather than one per reconcile pass. The price is that renaming a gateway
// takes effect on the next restart, which is the right trade for a label.
type gatewayNames struct {
	mu     sync.Mutex
	byID   map[string]string
	warned bool
}

func newGatewayNames() *gatewayNames { return &gatewayNames{byID: map[string]string{}} }

// resolveGatewayNames fills in the Name tags of every gateway the connections
// reference. Names are cosmetic, so a failure degrades to the bare ID rather than
// failing discovery: refusing to manage a VPN connection because a label could not be
// read would be the worse outcome.
func (c *Client) resolveGatewayNames(ctx context.Context, conns []Connection) {
	if c.gateways == nil || c.gwAPI == nil {
		return
	}

	var transit, vpn, customer []string
	for _, conn := range conns {
		transit = appendUnresolved(c.gateways, transit, conn.TransitGatewayID)
		vpn = appendUnresolved(c.gateways, vpn, conn.VpnGatewayID)
		customer = appendUnresolved(c.gateways, customer, conn.CustomerGatewayID)
	}

	if len(transit) > 0 {
		out, err := c.gwAPI.DescribeTransitGateways(ctx, &ec2.DescribeTransitGatewaysInput{TransitGatewayIds: transit})
		if err != nil {
			c.gateways.miss("ec2:DescribeTransitGateways", transit, err)
		} else {
			for _, tgw := range out.TransitGateways {
				c.gateways.set(aws.ToString(tgw.TransitGatewayId), nameTag(tgw.Tags))
			}
			c.gateways.fill(transit)
		}
	}
	if len(vpn) > 0 {
		out, err := c.gwAPI.DescribeVpnGateways(ctx, &ec2.DescribeVpnGatewaysInput{VpnGatewayIds: vpn})
		if err != nil {
			c.gateways.miss("ec2:DescribeVpnGateways", vpn, err)
		} else {
			for _, vgw := range out.VpnGateways {
				c.gateways.set(aws.ToString(vgw.VpnGatewayId), nameTag(vgw.Tags))
			}
			c.gateways.fill(vpn)
		}
	}
	if len(customer) > 0 {
		out, err := c.gwAPI.DescribeCustomerGateways(ctx, &ec2.DescribeCustomerGatewaysInput{CustomerGatewayIds: customer})
		if err != nil {
			c.gateways.miss("ec2:DescribeCustomerGateways", customer, err)
		} else {
			for _, cgw := range out.CustomerGateways {
				c.gateways.set(aws.ToString(cgw.CustomerGatewayId), nameTag(cgw.Tags))
			}
			c.gateways.fill(customer)
		}
	}

	for i := range conns {
		conns[i].TransitGatewayName = c.gateways.get(conns[i].TransitGatewayID)
		conns[i].VpnGatewayName = c.gateways.get(conns[i].VpnGatewayID)
		conns[i].CustomerGatewayName = c.gateways.get(conns[i].CustomerGatewayID)
	}
}

// appendUnresolved adds an ID that is worth a lookup: non-empty, not already cached,
// and not already queued in this batch.
func appendUnresolved(cache *gatewayNames, ids []string, id string) []string {
	if id == "" || cache.known(id) {
		return ids
	}
	if slices.Contains(ids, id) {
		return ids
	}
	return append(ids, id)
}

func (g *gatewayNames) known(id string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	_, ok := g.byID[id]
	return ok
}

func (g *gatewayNames) get(id string) string {
	if id == "" {
		return ""
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.byID[id]
}

func (g *gatewayNames) set(id, name string) {
	if id == "" {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.byID[id] = name
}

// fill marks every requested ID as looked up, so a gateway the call did not return,
// or one with no Name tag, is not asked for again.
func (g *gatewayNames) fill(ids []string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, id := range ids {
		if _, ok := g.byID[id]; !ok {
			g.byID[id] = ""
		}
	}
}

// miss records a failed lookup and warns once. Warning per pass would turn a missing
// optional permission into a log flood.
func (g *gatewayNames) miss(action string, ids []string, err error) {
	g.mu.Lock()
	warn := !g.warned
	g.warned = true
	for _, id := range ids {
		g.byID[id] = ""
	}
	g.mu.Unlock()

	if warn {
		slog.Warn("could not read gateway Name tags; notifications will show gateway IDs only",
			"action", action, "error", err,
			"hint", "grant "+action+" to name the gateways on the approval card")
	}
}

func nameTag(tags []types.Tag) string {
	for _, t := range tags {
		if aws.ToString(t.Key) == "Name" {
			return aws.ToString(t.Value)
		}
	}
	return ""
}
