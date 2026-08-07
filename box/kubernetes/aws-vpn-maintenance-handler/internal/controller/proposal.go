package controller

import (
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/planner"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/state"
)

// approvalExpiry is how long a request posted at now stays answerable: the configured
// timeout, or the window's remaining room to start a replacement when that runs out
// first.
//
// The card prints this figure, and the traffic gate often posts one late in the window,
// so the configured timeout on its own would promise an hour the request does not have.
func (c *Controller) approvalExpiry(now time.Time) time.Duration {
	return min(c.cfg.Approval.Timeout.D(), c.window.StartBudget(now))
}

// proposal maps a planner candidate to its Slack display form.
func (c *Controller) proposal(cand planner.Candidate) slackx.Proposal {
	return slackx.Proposal{
		RequestID:           cand.RequestID,
		ConnectionID:        cand.Connection.ID,
		ConnectionName:      cand.Connection.Name,
		Gateway:             gatewayOf(cand.Connection),
		GatewayName:         gatewayNameOf(cand.Connection),
		CustomerGatewayID:   cand.Connection.CustomerGatewayID,
		CustomerGatewayName: cand.Connection.CustomerGatewayName,
		Region:              c.cfg.Region,
		TunnelIP:            cand.Tunnel.OutsideIP,
		Queue:               cand.Queue,
		StableRequirement:   c.cfg.Safety.PeerMinStableFor.D(),
		PeerIP:              cand.Peer.OutsideIP,
		PeerRoutes:          cand.Peer.AcceptedRoutes,
		PeerStableFor:       cand.Peer.StableFor(time.Now()),
		StaticRoutes:        cand.Connection.StaticRoutesOnly,
		DeadlineIn:          cand.DeadlineIn,
		Deadline:            cand.Maintenance.AutoAppliedAfter,
		Escalate:            cand.Escalate,
		DryRun:              c.cfg.DryRun,
		ApprovalExpiry:      c.approvalExpiry(time.Now()),
		Window:              c.window.String(),
	}
}

// proposalFromInFlight rebuilds the display form for a replacement recovered from
// persisted state, where the original candidate is gone. Only the identifying
// fields are needed: the card it updates was already posted with the full detail.
func (c *Controller) proposalFromInFlight(conn awsx.Connection, f state.InFlight) slackx.Proposal {
	return slackx.Proposal{
		RequestID:           f.RequestID,
		ConnectionID:        conn.ID,
		ConnectionName:      conn.Name,
		Gateway:             gatewayOf(conn),
		GatewayName:         gatewayNameOf(conn),
		CustomerGatewayID:   conn.CustomerGatewayID,
		CustomerGatewayName: conn.CustomerGatewayName,
		Region:              c.cfg.Region,
		TunnelIP:            f.TunnelIP,
		Queue:               f.Queue,
		StableRequirement:   c.cfg.Safety.PeerMinStableFor.D(),
		PeerIP:              f.PeerIP,
		StaticRoutes:        conn.StaticRoutesOnly,
		DryRun:              c.cfg.DryRun,
		ApprovalExpiry:      c.cfg.Approval.Timeout.D(),
		Window:              c.window.String(),
	}
}

// gatewayOf returns whichever gateway the connection attaches to. The two are
// mutually exclusive.
func gatewayOf(conn awsx.Connection) string {
	if conn.TransitGatewayID != "" {
		return conn.TransitGatewayID
	}
	return conn.VpnGatewayID
}

// gatewayNameOf returns the Name tag of that same gateway, empty when it has none or
// the lookup was not permitted.
func gatewayNameOf(conn awsx.Connection) string {
	if conn.TransitGatewayID != "" {
		return conn.TransitGatewayName
	}
	return conn.VpnGatewayName
}
