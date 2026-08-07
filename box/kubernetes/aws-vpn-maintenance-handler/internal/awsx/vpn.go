package awsx

import (
	"context"
	"fmt"
	"slices"
	"sort"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// TagFilter is a tag key/value pair scoping the managed connections. An empty
// Value matches any value for that key.
type TagFilter struct {
	Key   string
	Value string
}

// DiscoverInput scopes a discovery pass.
type DiscoverInput struct {
	// TagFilters are ANDed by the EC2 API: every listed tag must be present.
	TagFilters []TagFilter
	// ExcludeIDs are dropped after the call, since EC2 filters cannot negate.
	ExcludeIDs []string
}

// Discover returns the managed connections in state "available", sorted by ID for
// stable output. DescribeVpnConnections is not paginated, so there is no token loop.
func (c *Client) Discover(ctx context.Context, in DiscoverInput) ([]Connection, error) {
	filters := []types.Filter{{
		// Deleted connections linger in the API; this keeps them out entirely.
		Name:   aws.String("state"),
		Values: []string{"available"},
	}}
	for _, f := range in.TagFilters {
		if f.Value == "" {
			filters = append(filters, types.Filter{
				Name:   aws.String("tag-key"),
				Values: []string{f.Key},
			})
			continue
		}
		filters = append(filters, types.Filter{
			Name:   aws.String("tag:" + f.Key),
			Values: []string{f.Value},
		})
	}

	out, err := c.api.DescribeVpnConnections(ctx, &ec2.DescribeVpnConnectionsInput{Filters: filters})
	if err != nil {
		return nil, fmt.Errorf("describe vpn connections: %w", err)
	}

	conns := make([]Connection, 0, len(out.VpnConnections))
	for _, v := range out.VpnConnections {
		id := aws.ToString(v.VpnConnectionId)
		if id == "" || slices.Contains(in.ExcludeIDs, id) {
			continue
		}
		conns = append(conns, convertConnection(v))
	}
	sort.Slice(conns, func(i, j int) bool { return conns[i].ID < conns[j].ID })
	c.resolveGatewayNames(ctx, conns)
	return conns, nil
}

// Describe returns one connection by ID. Verification uses it to keep the poll cheap
// and avoid re-evaluating tags mid-replacement.
func (c *Client) Describe(ctx context.Context, id string) (Connection, error) {
	out, err := c.api.DescribeVpnConnections(ctx, &ec2.DescribeVpnConnectionsInput{
		VpnConnectionIds: []string{id},
	})
	if err != nil {
		return Connection{}, fmt.Errorf("describe vpn connection %s: %w", id, err)
	}
	if len(out.VpnConnections) == 0 {
		return Connection{}, fmt.Errorf("vpn connection %s not found", id)
	}
	conn := convertConnection(out.VpnConnections[0])
	// Cached after the first pass, so re-describing during verification costs
	// nothing extra.
	single := []Connection{conn}
	c.resolveGatewayNames(ctx, single)
	return single[0], nil
}

func convertConnection(v types.VpnConnection) Connection {
	conn := Connection{
		ID:                aws.ToString(v.VpnConnectionId),
		State:             string(v.State),
		CustomerGatewayID: aws.ToString(v.CustomerGatewayId),
		TransitGatewayID:  aws.ToString(v.TransitGatewayId),
		VpnGatewayID:      aws.ToString(v.VpnGatewayId),
	}
	// Tunnel endpoint lifecycle control is a per-tunnel option, so it is keyed by
	// outside IP and merged into the telemetry below.
	lifecycle := map[string]bool{}
	if v.Options != nil {
		conn.StaticRoutesOnly = aws.ToBool(v.Options.StaticRoutesOnly)
		for _, opt := range v.Options.TunnelOptions {
			if ip := aws.ToString(opt.OutsideIpAddress); ip != "" {
				lifecycle[ip] = aws.ToBool(opt.EnableTunnelLifecycleControl)
			}
		}
	}
	for _, t := range v.Tags {
		if aws.ToString(t.Key) == "Name" {
			conn.Name = aws.ToString(t.Value)
			break
		}
	}

	conn.Tunnels = make([]Tunnel, 0, len(v.VgwTelemetry))
	for _, tel := range v.VgwTelemetry {
		ip := aws.ToString(tel.OutsideIpAddress)
		tunnel := Tunnel{
			OutsideIP:        ip,
			Up:               tel.Status == types.TelemetryStatusUp,
			StatusMessage:    aws.ToString(tel.StatusMessage),
			AcceptedRoutes:   aws.ToInt32(tel.AcceptedRouteCount),
			LifecycleControl: lifecycle[ip],
		}
		if tel.LastStatusChange != nil {
			tunnel.LastStatusChange = *tel.LastStatusChange
		}
		conn.Tunnels = append(conn.Tunnels, tunnel)
	}
	// Stable order for logs, metric labels, and Slack messages.
	sort.Slice(conn.Tunnels, func(i, j int) bool { return conn.Tunnels[i].OutsideIP < conn.Tunnels[j].OutsideIP })
	return conn
}
