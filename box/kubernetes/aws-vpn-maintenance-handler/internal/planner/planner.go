// Package planner decides which tunnel, if any, may be replaced right now.
// ReplaceVpnTunnel is irreversible, so every safety rule is checked here before
// anything is proposed. No AWS calls, no state.
package planner

import (
	"fmt"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
)

// Reason is a machine-readable reason a tunnel was not proposed. The values are
// stable because they appear as a Prometheus metric label.
type Reason string

const (
	// ReasonLifecycleControlDisabled: the tunnel has EnableTunnelLifecycleControl
	// off, so AWS never offers its maintenance for early application and
	// ReplaceVpnTunnel cannot be used. Permanent until someone enables it with
	// ModifyVpnTunnelOptions, which makes it the one blocked reason that is a
	// configuration gap rather than a transient condition.
	ReasonLifecycleControlDisabled Reason = "lifecycle_control_disabled"
	// ReasonWindowClosed: window shut, or too little of it left to verify in.
	ReasonWindowClosed Reason = "window_closed"
	// ReasonNoPendingMaintenance: AWS has nothing queued. The normal case.
	ReasonNoPendingMaintenance Reason = "no_pending_maintenance"
	// ReasonConnectionUnavailable: connection state is not "available".
	ReasonConnectionUnavailable Reason = "connection_unavailable"
	// ReasonTunnelCount: not exactly two tunnels, so nothing to fail over to.
	ReasonTunnelCount Reason = "tunnel_count"
	// ReasonPeerDown: the surviving tunnel is DOWN.
	ReasonPeerDown Reason = "peer_down"
	// ReasonPeerUnstable: the surviving tunnel came UP too recently to trust.
	ReasonPeerUnstable Reason = "peer_unstable"
	// ReasonPeerNoRoutes: peer is UP but carries too few routes, so traffic
	// would blackhole.
	ReasonPeerNoRoutes Reason = "peer_no_routes"
	// ReasonCooldown: this connection had a tunnel replaced too recently.
	ReasonCooldown Reason = "cooldown"
	// ReasonReplacementInFlight: replacements are serialized, one is running.
	ReasonReplacementInFlight Reason = "replacement_in_flight"
	// ReasonAwaitingApproval: an approval is already outstanding in Slack.
	ReasonAwaitingApproval Reason = "awaiting_approval"
	// ReasonTrafficHigh: the metric store says the tunnel is not quiet enough
	// right now. Evaluated outside the planner, since it needs a network call.
	ReasonTrafficHigh Reason = "traffic_high"
)

// Blocked records a tunnel that was considered and rejected, with the reason.
type Blocked struct {
	ConnectionID string
	// ConnectionName is the Name tag, or empty. Carried because a rejection can be
	// reported to a human, who recognizes the name and not the ID.
	ConnectionName string
	TunnelIP       string
	Reason         Reason
	// Detail is the human-readable explanation for logs and Slack.
	Detail string
	// PendingMaintenance separates "nothing to do" from "held back by a rule".
	PendingMaintenance bool
	// RequestID is the same identity a candidate for this tunnel would carry, so a
	// tunnel held back and later proposed is recognizably one maintenance cycle.
	RequestID string
	// Deadline is when AWS applies the maintenance itself, zero when unpublished, and
	// DeadlineIn how long that is from now.
	Deadline   time.Time
	DeadlineIn time.Duration
}

// Candidate is a tunnel cleared by every preflight check and ready to be
// proposed for approval.
type Candidate struct {
	Connection  awsx.Connection
	Tunnel      awsx.Tunnel
	Peer        awsx.Tunnel
	Maintenance awsx.Maintenance
	// RequestID is derived from connection, tunnel, and deadline: stable across
	// restarts within one maintenance cycle, new when AWS queues new work.
	RequestID string
	// Escalate marks a candidate whose AWS auto-apply deadline is close.
	Escalate bool
	// DeadlineIn is the time left before AWS applies the maintenance itself.
	DeadlineIn time.Duration
	// Chained marks a tunnel reached by continuing from an earlier replacement on the
	// same connection rather than by a fresh proposal.
	Chained bool
	// SiblingReplacedAt is when the previous tunnel was replaced, set only when Chained.
	SiblingReplacedAt time.Time
	// Queue holds the connection's other tunnels that also have maintenance pending,
	// in replacement order. Approving this candidate authorizes the whole queue: the
	// approval is about the connection, not one of its tunnels.
	//
	// Their peer checks are deliberately not evaluated here. The tunnel that will
	// carry traffic for the next step is the one being replaced now, so its state is
	// only knowable once that step has finished, and each queued tunnel is therefore
	// re-checked in full at its own turn.
	Queue []string
}

// Label renders the candidate for logs and notifications.
func (c Candidate) Label() string {
	return fmt.Sprintf("%s tunnel %s", c.Connection.Label(), c.Tunnel.OutsideIP)
}

// Plan is the result of one evaluation pass.
type Plan struct {
	// Candidates are eligible tunnels, nearest AWS deadline first. Only the
	// first is acted on per pass, since replacements are serialized.
	Candidates []Candidate
	// Blocked holds every tunnel that was considered and rejected.
	Blocked []Blocked
}

// Held returns the blocked entries worth an operator's attention: tunnels with
// queued maintenance being held back, and tunnels permanently ineligible because
// lifecycle control is off. Tunnels with nothing queued are left out as noise.
func (p Plan) Held() []Blocked {
	held := make([]Blocked, 0, len(p.Blocked))
	for _, b := range p.Blocked {
		if b.PendingMaintenance || b.Reason == ReasonLifecycleControlDisabled {
			held = append(held, b)
		}
	}
	return held
}

// Thresholds are the safety limits applied to every candidate.
type Thresholds struct {
	// PeerMinStableFor is how long the surviving tunnel must have held UP.
	PeerMinStableFor time.Duration
	// PeerMinAcceptedRoutes is the minimum BGP route count on the surviving
	// tunnel. Ignored for static-routes-only connections.
	PeerMinAcceptedRoutes int32
	// PerConnectionCooldown blocks a repeat replacement on the same connection.
	PerConnectionCooldown time.Duration
	// ChainSiblingTunnel lets the connection's other tunnel skip the cooldown once
	// the first was replaced successfully, so a connection is finished in one window
	// rather than over two days. The peer checks still apply, so the sibling waits
	// for the freshly replaced tunnel to be UP and stable before it can proceed.
	ChainSiblingTunnel bool
	// EscalateBefore marks a candidate urgent once the AWS deadline is nearer
	// than this.
	EscalateBefore time.Duration
}

// ConnectionState is the persisted per-connection history the planner consults.
type ConnectionState struct {
	// LastReplacementAt starts the cooldown. A failed attempt sets it too.
	LastReplacementAt time.Time
	// LastTunnelIP is the tunnel that was replaced, which is what distinguishes the
	// sibling tunnel from a repeat attempt on the same one.
	LastTunnelIP string
	// LastSucceeded reports whether that replacement ended healthy. Only a healthy
	// one may be chained from: a connection that just had a bad replacement is the
	// last one that should get another.
	LastSucceeded bool
}

// Input is everything one evaluation pass needs.
type Input struct {
	Now time.Time
	// Connections are the discovered managed connections with their telemetry.
	Connections []awsx.Connection
	// Statuses maps connection ID to per-tunnel maintenance state.
	Statuses map[string][]awsx.TunnelStatus
	// WindowOpen reports whether replacements may start now.
	WindowOpen bool
	// WindowDetail explains a closed window, for the blocked reason.
	WindowDetail string
	// ReplacementInFlight is true when a replacement is already running.
	ReplacementInFlight bool
	// AwaitingApproval holds the request IDs with an outstanding Slack approval.
	AwaitingApproval map[string]bool
	// History is per-connection replacement history, keyed by connection ID.
	History    map[string]ConnectionState
	Thresholds Thresholds
}

// Evaluate walks every tunnel and returns the eligible candidates plus the reason
// each other tunnel was rejected. Checks run most-common-first so the reported
// reason is the informative one, not "window closed" for a tunnel with no work.
func Evaluate(in Input) Plan {
	var out Plan

	for _, conn := range in.Connections {
		statuses := in.Statuses[conn.ID]
		for _, st := range statuses {
			block := func(r Reason, detail string) {
				out.Blocked = append(out.Blocked, Blocked{
					ConnectionID:       conn.ID,
					ConnectionName:     conn.Name,
					TunnelIP:           st.Tunnel.OutsideIP,
					Reason:             r,
					Detail:             detail,
					PendingMaintenance: st.Maintenance.Pending,
					RequestID:          RequestID(conn.ID, st.Tunnel.OutsideIP, st.Maintenance),
					Deadline:           st.Maintenance.AutoAppliedAfter,
					DeadlineIn:         st.Maintenance.DeadlineIn(in.Now),
				})
			}

			// Checked before pending maintenance: with lifecycle control off, AWS
			// never reports maintenance as available, so this would otherwise
			// look like "nothing to do" and hide a configuration gap.
			if !st.Tunnel.LifecycleControl {
				block(ReasonLifecycleControlDisabled,
					"tunnel endpoint lifecycle control is disabled, so AWS applies maintenance on its own schedule "+
						"and it cannot be triggered early; enable it with ModifyVpnTunnelOptions "+
						"(EnableTunnelLifecycleControl) to bring this tunnel under control")
				continue
			}
			// Nothing queued is the common case, reported as its own reason.
			if !st.Maintenance.Pending {
				block(ReasonNoPendingMaintenance, "no pending tunnel endpoint maintenance")
				continue
			}
			if conn.State != "available" {
				block(ReasonConnectionUnavailable, fmt.Sprintf("vpn connection state is %q, not \"available\"", conn.State))
				continue
			}
			peer, ok := conn.Peer(st.Tunnel.OutsideIP)
			if !ok {
				block(ReasonTunnelCount, fmt.Sprintf(
					"connection reports %d tunnel(s); a replacement needs exactly 2 so traffic can fail over",
					len(conn.Tunnels)))
				continue
			}
			if !peer.Up {
				block(ReasonPeerDown, fmt.Sprintf(
					"peer tunnel %s is DOWN (%s); replacing this tunnel would drop the whole connection",
					peer.OutsideIP, peerStatusMessage(peer)))
				continue
			}
			if stable := peer.StableFor(in.Now); stable < in.Thresholds.PeerMinStableFor {
				block(ReasonPeerUnstable, fmt.Sprintf(
					"peer tunnel %s has only been stable for %s, %s required (possible flapping)",
					peer.OutsideIP, stable.Round(time.Second), in.Thresholds.PeerMinStableFor))
				continue
			}
			// Static-routes-only connections never report routes, so UP is the
			// only signal there.
			if !conn.StaticRoutesOnly && peer.AcceptedRoutes < in.Thresholds.PeerMinAcceptedRoutes {
				block(ReasonPeerNoRoutes, fmt.Sprintf(
					"peer tunnel %s is UP but accepts %d BGP route(s), %d required; traffic would blackhole",
					peer.OutsideIP, peer.AcceptedRoutes, in.Thresholds.PeerMinAcceptedRoutes))
				continue
			}
			// Chaining the sibling tunnel is what lets both tunnels of a connection
			// be finished in one window instead of a day apart. It is safe only
			// because the peer checks above already ran against the just-replaced
			// tunnel: it has to be UP and stable for peerMinStableFor before it can
			// carry traffic for its sibling, so the wait is enforced by measurement
			// rather than by the clock.
			chained := false
			if hist, ok := in.History[conn.ID]; ok && !hist.LastReplacementAt.IsZero() {
				if since := in.Now.Sub(hist.LastReplacementAt); since < in.Thresholds.PerConnectionCooldown {
					sibling := hist.LastTunnelIP != "" && hist.LastTunnelIP != st.Tunnel.OutsideIP
					if !in.Thresholds.ChainSiblingTunnel || !sibling || !hist.LastSucceeded {
						block(ReasonCooldown, cooldownDetail(hist, st.Tunnel.OutsideIP, since, in.Thresholds))
						continue
					}
					chained = true
				}
			}

			requestID := RequestID(conn.ID, st.Tunnel.OutsideIP, st.Maintenance)
			if in.AwaitingApproval[requestID] {
				block(ReasonAwaitingApproval, "an approval request is already outstanding in Slack")
				continue
			}
			if in.ReplacementInFlight {
				block(ReasonReplacementInFlight, "another tunnel replacement is already running; replacements are serialized")
				continue
			}
			if !in.WindowOpen {
				block(ReasonWindowClosed, in.WindowDetail)
				continue
			}

			deadlineIn := st.Maintenance.DeadlineIn(in.Now)
			out.Candidates = append(out.Candidates, Candidate{
				Connection:  conn,
				Tunnel:      st.Tunnel,
				Peer:        peer,
				Maintenance: st.Maintenance,
				RequestID:   requestID,
				// Zero means AWS published no deadline, which is not urgent.
				Escalate:          deadlineIn > 0 && deadlineIn <= in.Thresholds.EscalateBefore,
				DeadlineIn:        deadlineIn,
				Chained:           chained,
				SiblingReplacedAt: in.History[conn.ID].LastReplacementAt,
				Queue:             queuedSiblings(conn, statuses, st.Tunnel.OutsideIP),
			})
		}
	}

	sortByUrgency(out.Candidates)
	return out
}

// sortByUrgency puts the nearest AWS deadline first, so the tunnel most likely to
// be replaced at an uncontrolled time gets the window. No deadline sorts last;
// ties break on connection ID then tunnel IP for determinism.
func sortByUrgency(cs []Candidate) {
	key := func(c Candidate) time.Duration {
		if c.DeadlineIn == 0 {
			return time.Duration(1 << 62)
		}
		return c.DeadlineIn
	}
	for i := 1; i < len(cs); i++ {
		for j := i; j > 0; j-- {
			a, b := cs[j-1], cs[j]
			ka, kb := key(a), key(b)
			less := ka < kb ||
				(ka == kb && a.Connection.ID < b.Connection.ID) ||
				(ka == kb && a.Connection.ID == b.Connection.ID && a.Tunnel.OutsideIP < b.Tunnel.OutsideIP)
			if less {
				break
			}
			cs[j-1], cs[j] = cs[j], cs[j-1]
		}
	}
}

// queuedSiblings lists the connection's other tunnels with maintenance pending, so one
// approval can carry the whole connection.
//
// Only lifecycle control is required here. Everything else about a queued tunnel is
// re-evaluated when its turn comes, because the facts that matter most, the peer's
// status and route count, are about the tunnel being replaced right now.
func queuedSiblings(conn awsx.Connection, statuses []awsx.TunnelStatus, currentIP string) []string {
	var queue []string
	for _, st := range statuses {
		if st.Tunnel.OutsideIP == currentIP || !st.Maintenance.Pending || !st.Tunnel.LifecycleControl {
			continue
		}
		queue = append(queue, st.Tunnel.OutsideIP)
	}
	return queue
}

// cooldownDetail explains a cooldown block, naming the reason chaining did not apply
// so an operator can tell "waiting out a failure" from "chaining is switched off".
func cooldownDetail(hist ConnectionState, tunnelIP string, since time.Duration, th Thresholds) string {
	base := fmt.Sprintf("a tunnel of this connection was replaced %s ago; cooldown is %s",
		since.Round(time.Minute), th.PerConnectionCooldown)
	switch {
	case hist.LastTunnelIP == tunnelIP:
		return base + ", and this is the same tunnel that was just replaced"
	case !hist.LastSucceeded:
		return base + ", and that replacement did not end healthy, so its sibling is not chained"
	case !th.ChainSiblingTunnel:
		return base + " (sibling chaining is disabled)"
	default:
		return base
	}
}

// RequestID is the stable approval identity of one proposed replacement.
// Including the deadline scopes it to a single maintenance cycle, so a restart
// reuses the outstanding request and an old approval cannot authorize new work.
func RequestID(connectionID, tunnelIP string, m awsx.Maintenance) string {
	deadline := int64(0)
	if !m.AutoAppliedAfter.IsZero() {
		deadline = m.AutoAppliedAfter.Unix()
	}
	return fmt.Sprintf("%s|%s|%d", connectionID, tunnelIP, deadline)
}

// SplitRequestID recovers the connection ID and tunnel IP from a request ID, so
// the state ConfigMap only has to store the ID itself.
func SplitRequestID(requestID string) (connectionID, tunnelIP string, ok bool) {
	parts := strings.Split(requestID, "|")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// RequestIDMatches reports whether a request ID refers to the given connection and
// tunnel, ignoring the deadline, which may move between proposal and execution.
func RequestIDMatches(requestID, connectionID, tunnelIP string) bool {
	prefix := connectionID + "|" + tunnelIP + "|"
	return len(requestID) > len(prefix) && requestID[:len(prefix)] == prefix
}

func peerStatusMessage(t awsx.Tunnel) string {
	if t.StatusMessage == "" {
		return "no status message"
	}
	return t.StatusMessage
}
