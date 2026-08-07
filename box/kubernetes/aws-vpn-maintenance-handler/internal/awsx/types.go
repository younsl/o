package awsx

import "time"

// Tunnel is one IPsec tunnel of a VPN connection, from the VgwTelemetry field of
// DescribeVpnConnections.
type Tunnel struct {
	// OutsideIP is the AWS-side public IP, and the tunnel's only stable
	// identifier: every maintenance API takes it as input.
	OutsideIP string
	// Up reports TelemetryStatus == UP (IKE and IPsec established).
	Up bool
	// StatusMessage is the AWS-provided reason when the tunnel is DOWN.
	StatusMessage string
	// AcceptedRoutes is the BGP route count from the customer gateway. Always 0
	// on static-routes-only connections, where it means nothing.
	AcceptedRoutes int32
	// LastStatusChange is when IKE, IPsec, or BGP status last flipped, used to
	// reject a flapping peer.
	LastStatusChange time.Time
	// LifecycleControl reports EnableTunnelLifecycleControl on the tunnel option.
	// Without it AWS never offers pending maintenance for early application and
	// ReplaceVpnTunnel cannot be used, so the tunnel is permanently ineligible
	// until someone enables it with ModifyVpnTunnelOptions.
	LifecycleControl bool
}

// StableFor reports how long the tunnel has held its status. An unreported
// LastStatusChange yields 0, which callers read as "not known to be stable".
func (t Tunnel) StableFor(now time.Time) time.Duration {
	if t.LastStatusChange.IsZero() {
		return 0
	}
	return now.Sub(t.LastStatusChange)
}

// Connection is a VPN connection reduced to the fields that decide whether one of
// its tunnels may be replaced.
type Connection struct {
	ID string
	// Name is the Name tag, for logs and Slack. Empty when untagged.
	Name string
	// State is "available", "pending", "deleting", or "deleted". Only
	// "available" is eligible.
	State string
	// StaticRoutesOnly disables the route-count check, since such connections
	// never report accepted routes.
	StaticRoutesOnly bool
	// Gateway IDs, for context in notifications. TransitGatewayID and
	// VpnGatewayID are mutually exclusive.
	CustomerGatewayID string
	TransitGatewayID  string
	VpnGatewayID      string
	// Gateway Name tags, resolved separately because DescribeVpnConnections returns
	// the IDs only. Empty when the gateway carries no Name tag or the describe call
	// is not permitted, in which case notifications fall back to the bare ID.
	CustomerGatewayName string
	TransitGatewayName  string
	VpnGatewayName      string
	// Tunnels holds the telemetry entries, normally exactly two.
	Tunnels []Tunnel
}

// Label returns "name (id)" when a Name tag exists, otherwise the raw ID.
func (c Connection) Label() string {
	if c.Name == "" {
		return c.ID
	}
	return c.Name + " (" + c.ID + ")"
}

// Tunnel returns the tunnel with the given outside IP.
func (c Connection) Tunnel(outsideIP string) (Tunnel, bool) {
	for _, t := range c.Tunnels {
		if t.OutsideIP == outsideIP {
			return t, true
		}
	}
	return Tunnel{}, false
}

// Peer returns the other tunnel, reporting false unless there are exactly two.
// That case is itself a reason to refuse: nothing to fail over to.
func (c Connection) Peer(outsideIP string) (Tunnel, bool) {
	if len(c.Tunnels) != 2 {
		return Tunnel{}, false
	}
	for _, t := range c.Tunnels {
		if t.OutsideIP != outsideIP {
			return t, true
		}
	}
	return Tunnel{}, false
}

// Maintenance is one tunnel's pending endpoint maintenance, from
// GetVpnTunnelReplacementStatus.
type Maintenance struct {
	// Pending is true when PendingMaintenance is "AVAILABLE", meaning
	// ReplaceVpnTunnel will actually do something.
	Pending bool
	// AutoAppliedAfter is when AWS starts applying the maintenance itself, at a
	// time of its choosing. Owning it means acting before this.
	AutoAppliedAfter time.Time
	// LastApplied is when maintenance was last applied to this tunnel.
	LastApplied time.Time
}

// DeadlineIn returns the time left before AWS applies the maintenance itself, or 0
// when unknown or elapsed.
func (m Maintenance) DeadlineIn(now time.Time) time.Duration {
	if m.AutoAppliedAfter.IsZero() {
		return 0
	}
	d := m.AutoAppliedAfter.Sub(now)
	if d < 0 {
		return 0
	}
	return d
}

// TunnelStatus pairs a tunnel with its maintenance state.
type TunnelStatus struct {
	Tunnel      Tunnel
	Maintenance Maintenance
}
