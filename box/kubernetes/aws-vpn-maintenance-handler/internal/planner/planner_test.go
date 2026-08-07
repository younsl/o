package planner

import (
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
)

var now = time.Date(2026, 7, 21, 3, 0, 0, 0, time.UTC)

func thresholds() Thresholds {
	return Thresholds{
		PeerMinStableFor:      15 * time.Minute,
		PeerMinAcceptedRoutes: 1,
		PerConnectionCooldown: 24 * time.Hour,
		EscalateBefore:        72 * time.Hour,
	}
}

// healthyPeer is a tunnel that satisfies every peer-side rule.
func healthyPeer(ip string) awsx.Tunnel {
	return awsx.Tunnel{
		OutsideIP:        ip,
		Up:               true,
		AcceptedRoutes:   12,
		LastStatusChange: now.Add(-6 * time.Hour),
		LifecycleControl: true,
	}
}

func targetTunnel(ip string) awsx.Tunnel {
	return awsx.Tunnel{
		OutsideIP:        ip,
		Up:               true,
		AcceptedRoutes:   9,
		LastStatusChange: now.Add(-6 * time.Hour),
		LifecycleControl: true,
	}
}

func connection(tunnels ...awsx.Tunnel) awsx.Connection {
	return awsx.Connection{
		ID:      "vpn-0123456789abcdef0",
		Name:    "prod-dc",
		State:   "available",
		Tunnels: tunnels,
	}
}

// pendingInput builds an Input where the target tunnel has pending maintenance
// and everything else is nominal, so each test can break exactly one rule.
func pendingInput(conn awsx.Connection, targetIP string, deadline time.Time) Input {
	statuses := make([]awsx.TunnelStatus, 0, len(conn.Tunnels))
	for _, t := range conn.Tunnels {
		st := awsx.TunnelStatus{Tunnel: t}
		if t.OutsideIP == targetIP {
			st.Maintenance = awsx.Maintenance{Pending: true, AutoAppliedAfter: deadline}
		}
		statuses = append(statuses, st)
	}
	return Input{
		Now:         now,
		Connections: []awsx.Connection{conn},
		Statuses:    map[string][]awsx.TunnelStatus{conn.ID: statuses},
		WindowOpen:  true,
		History:     map[string]ConnectionState{},
		Thresholds:  thresholds(),
	}
}

func TestEvaluateProposesAHealthyCandidate(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))

	plan := Evaluate(in)
	if len(plan.Candidates) != 1 {
		t.Fatalf("expected 1 candidate, got %d (blocked: %+v)", len(plan.Candidates), plan.Blocked)
	}
	cand := plan.Candidates[0]
	if cand.Tunnel.OutsideIP != "1.1.1.1" {
		t.Fatalf("candidate tunnel = %s, want 1.1.1.1", cand.Tunnel.OutsideIP)
	}
	if cand.Peer.OutsideIP != "2.2.2.2" {
		t.Fatalf("candidate peer = %s, want 2.2.2.2", cand.Peer.OutsideIP)
	}
	if cand.Escalate {
		t.Fatal("a deadline 200h out must not be escalated")
	}
	// The tunnel without pending maintenance is reported, not silently dropped.
	if len(plan.Held()) != 0 {
		t.Fatalf("nothing should be held back, got %+v", plan.Held())
	}
}

func TestEvaluateBlocksOnEachSafetyRule(t *testing.T) {
	tests := []struct {
		name       string
		mutate     func(*Input)
		wantReason Reason
	}{
		{
			name:       "no pending maintenance",
			mutate:     func(in *Input) { in.Statuses[in.Connections[0].ID][0].Maintenance.Pending = false },
			wantReason: ReasonNoPendingMaintenance,
		},
		{
			name:       "connection not available",
			mutate:     func(in *Input) { in.Connections[0].State = "deleting" },
			wantReason: ReasonConnectionUnavailable,
		},
		{
			name: "peer tunnel down",
			mutate: func(in *Input) {
				in.Connections[0].Tunnels[1].Up = false
				in.Connections[0].Tunnels[1].StatusMessage = "IPSEC IS DOWN"
			},
			wantReason: ReasonPeerDown,
		},
		{
			name: "peer tunnel only just came up",
			mutate: func(in *Input) {
				in.Connections[0].Tunnels[1].LastStatusChange = now.Add(-2 * time.Minute)
			},
			wantReason: ReasonPeerUnstable,
		},
		{
			name: "peer tunnel carries no routes",
			mutate: func(in *Input) {
				in.Connections[0].Tunnels[1].AcceptedRoutes = 0
			},
			wantReason: ReasonPeerNoRoutes,
		},
		{
			name: "connection is in cooldown",
			mutate: func(in *Input) {
				in.History[in.Connections[0].ID] = ConnectionState{LastReplacementAt: now.Add(-2 * time.Hour)}
			},
			wantReason: ReasonCooldown,
		},
		{
			name:       "another replacement is running",
			mutate:     func(in *Input) { in.ReplacementInFlight = true },
			wantReason: ReasonReplacementInFlight,
		},
		{
			name:       "window closed",
			mutate:     func(in *Input) { in.WindowOpen = false; in.WindowDetail = "outside window" },
			wantReason: ReasonWindowClosed,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
			in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))
			tc.mutate(&in)

			plan := Evaluate(in)
			if len(plan.Candidates) != 0 {
				t.Fatalf("expected no candidates, got %+v", plan.Candidates)
			}
			if !blockedFor(plan, "1.1.1.1", tc.wantReason) {
				t.Fatalf("tunnel 1.1.1.1 should be blocked with reason %q; blocked = %+v", tc.wantReason, plan.Blocked)
			}
		})
	}
}

// Without lifecycle control, ReplaceVpnTunnel cannot be used at all, so the tunnel
// is ineligible however healthy it looks.
func TestEvaluateRefusesATunnelWithoutLifecycleControl(t *testing.T) {
	target := targetTunnel("1.1.1.1")
	target.LifecycleControl = false
	conn := connection(target, healthyPeer("2.2.2.2"))

	plan := Evaluate(pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour)))
	if len(plan.Candidates) != 0 {
		t.Fatalf("expected no candidates, got %+v", plan.Candidates)
	}
	if !blockedFor(plan, "1.1.1.1", ReasonLifecycleControlDisabled) {
		t.Fatalf("want reason %q, blocked = %+v", ReasonLifecycleControlDisabled, plan.Blocked)
	}
	if !strings.Contains(blockedDetail(plan, "1.1.1.1"), "ModifyVpnTunnelOptions") {
		t.Fatalf("the detail must name the fix; got %q", blockedDetail(plan, "1.1.1.1"))
	}
}

// Lifecycle control is checked before pending maintenance: AWS never reports
// maintenance as available for such a tunnel, so ordering the other way would report
// "nothing to do" and hide the configuration gap.
func TestLifecycleControlIsReportedEvenWithNothingQueued(t *testing.T) {
	target := targetTunnel("1.1.1.1")
	target.LifecycleControl = false
	peer := healthyPeer("2.2.2.2")
	peer.LifecycleControl = false
	conn := connection(target, peer)

	in := Input{
		Now:         now,
		Connections: []awsx.Connection{conn},
		Statuses: map[string][]awsx.TunnelStatus{conn.ID: {
			{Tunnel: target},
			{Tunnel: peer},
		}},
		WindowOpen: true,
		History:    map[string]ConnectionState{},
		Thresholds: thresholds(),
	}

	plan := Evaluate(in)
	held := plan.Held()
	if len(held) != 2 {
		t.Fatalf("both tunnels should surface as needing attention, got %+v", held)
	}
	for _, b := range held {
		if b.Reason != ReasonLifecycleControlDisabled {
			t.Fatalf("reason = %q, want %q", b.Reason, ReasonLifecycleControlDisabled)
		}
		if b.PendingMaintenance {
			t.Fatal("no maintenance is queued; only the reason makes this worth reporting")
		}
	}
}

// A single-tunnel connection has nothing to fail over to, so replacing its only
// tunnel is a guaranteed outage rather than a risk of one.
func TestEvaluateRefusesConnectionWithoutTwoTunnels(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"))
	plan := Evaluate(pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour)))

	if len(plan.Candidates) != 0 {
		t.Fatalf("expected no candidates, got %+v", plan.Candidates)
	}
	if !blockedFor(plan, "1.1.1.1", ReasonTunnelCount) {
		t.Fatalf("want reason %q, blocked = %+v", ReasonTunnelCount, plan.Blocked)
	}
}

// Static-routes-only connections never report accepted routes, so the route count
// carries no information and must not block them.
func TestEvaluateIgnoresRouteCountOnStaticRoutesOnly(t *testing.T) {
	peer := healthyPeer("2.2.2.2")
	peer.AcceptedRoutes = 0
	conn := connection(targetTunnel("1.1.1.1"), peer)
	conn.StaticRoutesOnly = true

	plan := Evaluate(pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour)))
	if len(plan.Candidates) != 1 {
		t.Fatalf("a static-routes-only connection with 0 routes should still be eligible; blocked = %+v", plan.Blocked)
	}
}

func TestEvaluateEscalatesNearTheAWSDeadline(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	plan := Evaluate(pendingInput(conn, "1.1.1.1", now.Add(10*time.Hour)))

	if len(plan.Candidates) != 1 {
		t.Fatalf("expected 1 candidate, blocked = %+v", plan.Blocked)
	}
	if !plan.Candidates[0].Escalate {
		t.Fatal("a deadline inside escalateBefore must be escalated")
	}
}

// A deadline AWS has not published is not urgent, and must not be treated as one
// just because the zero time is in the past.
func TestEvaluateDoesNotEscalateWithoutADeadline(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	plan := Evaluate(pendingInput(conn, "1.1.1.1", time.Time{}))

	if len(plan.Candidates) != 1 {
		t.Fatalf("expected 1 candidate, blocked = %+v", plan.Blocked)
	}
	if plan.Candidates[0].Escalate {
		t.Fatal("a candidate with no published deadline must not be escalated")
	}
	if plan.Candidates[0].DeadlineIn != 0 {
		t.Fatalf("DeadlineIn = %s, want 0 when no deadline is published", plan.Candidates[0].DeadlineIn)
	}
}

// Ordering decides which tunnel gets the window, so the one AWS is closest to
// replacing on its own must come first.
func TestEvaluateOrdersByUrgency(t *testing.T) {
	early := awsx.Connection{
		ID: "vpn-aaa", State: "available",
		Tunnels: []awsx.Tunnel{targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2")},
	}
	late := awsx.Connection{
		ID: "vpn-bbb", State: "available",
		Tunnels: []awsx.Tunnel{targetTunnel("3.3.3.3"), healthyPeer("4.4.4.4")},
	}
	noDeadline := awsx.Connection{
		ID: "vpn-ccc", State: "available",
		Tunnels: []awsx.Tunnel{targetTunnel("5.5.5.5"), healthyPeer("6.6.6.6")},
	}

	in := Input{
		Now:         now,
		Connections: []awsx.Connection{late, noDeadline, early},
		Statuses: map[string][]awsx.TunnelStatus{
			"vpn-aaa": {
				{Tunnel: early.Tunnels[0], Maintenance: awsx.Maintenance{Pending: true, AutoAppliedAfter: now.Add(20 * time.Hour)}},
				{Tunnel: early.Tunnels[1]},
			},
			"vpn-bbb": {
				{Tunnel: late.Tunnels[0], Maintenance: awsx.Maintenance{Pending: true, AutoAppliedAfter: now.Add(300 * time.Hour)}},
				{Tunnel: late.Tunnels[1]},
			},
			"vpn-ccc": {
				{Tunnel: noDeadline.Tunnels[0], Maintenance: awsx.Maintenance{Pending: true}},
				{Tunnel: noDeadline.Tunnels[1]},
			},
		},
		WindowOpen: true,
		History:    map[string]ConnectionState{},
		Thresholds: thresholds(),
	}

	plan := Evaluate(in)
	if len(plan.Candidates) != 3 {
		t.Fatalf("expected 3 candidates, got %d (blocked: %+v)", len(plan.Candidates), plan.Blocked)
	}
	got := []string{
		plan.Candidates[0].Connection.ID,
		plan.Candidates[1].Connection.ID,
		plan.Candidates[2].Connection.ID,
	}
	want := []string{"vpn-aaa", "vpn-bbb", "vpn-ccc"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("candidate order = %v, want %v (nearest deadline first, unpublished last)", got, want)
		}
	}
}

func TestEvaluateSkipsATunnelAlreadyAwaitingApproval(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))
	requestID := RequestID(conn.ID, "1.1.1.1", awsx.Maintenance{Pending: true, AutoAppliedAfter: now.Add(200 * time.Hour)})
	in.AwaitingApproval = map[string]bool{requestID: true}

	plan := Evaluate(in)
	if len(plan.Candidates) != 0 {
		t.Fatalf("expected no candidates, got %+v", plan.Candidates)
	}
	if !blockedFor(plan, "1.1.1.1", ReasonAwaitingApproval) {
		t.Fatalf("want reason %q, blocked = %+v", ReasonAwaitingApproval, plan.Blocked)
	}
}

// Held is what operators see; a tunnel with nothing queued is noise and must not
// appear there.
func TestHeldOnlyReportsPendingMaintenance(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))
	in.WindowOpen = false
	in.WindowDetail = "outside window"

	plan := Evaluate(in)
	held := plan.Held()
	if len(held) != 1 {
		t.Fatalf("expected exactly the pending tunnel to be held, got %+v", held)
	}
	if held[0].TunnelIP != "1.1.1.1" || held[0].Reason != ReasonWindowClosed {
		t.Fatalf("held = %+v, want tunnel 1.1.1.1 blocked on the window", held[0])
	}
	if held[0].Detail != "outside window" {
		t.Fatalf("held detail = %q, want the window explanation passed through", held[0].Detail)
	}
}

// The request ID scopes an approval to one maintenance cycle: a new deadline must
// produce a new ID so an old approval cannot authorize a future replacement.
func TestRequestIDChangesWithTheDeadline(t *testing.T) {
	first := RequestID("vpn-a", "1.1.1.1", awsx.Maintenance{AutoAppliedAfter: now})
	same := RequestID("vpn-a", "1.1.1.1", awsx.Maintenance{AutoAppliedAfter: now})
	later := RequestID("vpn-a", "1.1.1.1", awsx.Maintenance{AutoAppliedAfter: now.Add(time.Hour)})

	if first != same {
		t.Fatal("the same maintenance cycle must produce a stable request ID across restarts")
	}
	if first == later {
		t.Fatal("a new deadline must produce a new request ID")
	}
}

func TestSplitRequestID(t *testing.T) {
	id := RequestID("vpn-abc", "1.2.3.4", awsx.Maintenance{AutoAppliedAfter: now})
	conn, tunnel, ok := SplitRequestID(id)
	if !ok {
		t.Fatalf("SplitRequestID(%q) reported failure", id)
	}
	if conn != "vpn-abc" || tunnel != "1.2.3.4" {
		t.Fatalf("SplitRequestID = (%q, %q), want (vpn-abc, 1.2.3.4)", conn, tunnel)
	}

	for _, bad := range []string{"", "vpn-abc", "vpn-abc|1.2.3.4", "|1.2.3.4|0", "vpn-abc||0", "a|b|c|d"} {
		if _, _, ok := SplitRequestID(bad); ok {
			t.Fatalf("SplitRequestID(%q) should have failed", bad)
		}
	}
}

func TestRequestIDMatches(t *testing.T) {
	id := RequestID("vpn-abc", "1.2.3.4", awsx.Maintenance{AutoAppliedAfter: now})
	if !RequestIDMatches(id, "vpn-abc", "1.2.3.4") {
		t.Fatal("the ID should match the connection and tunnel it was built from")
	}
	if RequestIDMatches(id, "vpn-abc", "9.9.9.9") {
		t.Fatal("a different tunnel must not match")
	}
	if RequestIDMatches(id, "vpn-xyz", "1.2.3.4") {
		t.Fatal("a different connection must not match")
	}
}

func TestCandidateLabel(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	plan := Evaluate(pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour)))
	got := plan.Candidates[0].Label()
	want := "prod-dc (vpn-0123456789abcdef0) tunnel 1.1.1.1"
	if got != want {
		t.Fatalf("Label() = %q, want %q", got, want)
	}
}

func blockedFor(plan Plan, tunnelIP string, reason Reason) bool {
	for _, b := range plan.Blocked {
		if b.TunnelIP == tunnelIP && b.Reason == reason {
			return b.Detail != ""
		}
	}
	return false
}

func blockedDetail(plan Plan, tunnelIP string) string {
	for _, b := range plan.Blocked {
		if b.TunnelIP == tunnelIP {
			return b.Detail
		}
	}
	return ""
}

// One approval covers the connection, so the candidate carries the other tunnels that
// also have maintenance pending.
func TestCandidateQueuesTheSiblingTunnel(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))
	// Both tunnels have maintenance queued, which is the case a chain exists for.
	in.Statuses[conn.ID][1].Maintenance = awsx.Maintenance{Pending: true, AutoAppliedAfter: now.Add(300 * time.Hour)}

	plan := Evaluate(in)
	if len(plan.Candidates) == 0 {
		t.Fatalf("expected a candidate, blocked = %+v", plan.Blocked)
	}
	cand := plan.Candidates[0]
	if len(cand.Queue) != 1 || cand.Queue[0] == cand.Tunnel.OutsideIP {
		t.Fatalf("Queue = %v, want the other tunnel", cand.Queue)
	}
}

// A tunnel with nothing queued is not part of the chain.
func TestCandidateQueueSkipsTunnelsWithoutMaintenance(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	plan := Evaluate(pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour)))

	if len(plan.Candidates[0].Queue) != 0 {
		t.Fatalf("Queue = %v, want empty", plan.Candidates[0].Queue)
	}
}

// A queued tunnel without lifecycle control could never be replaced, so it must not be
// promised by the approval.
func TestCandidateQueueSkipsTunnelsWithoutLifecycleControl(t *testing.T) {
	peer := healthyPeer("2.2.2.2")
	peer.LifecycleControl = false
	conn := connection(targetTunnel("1.1.1.1"), peer)
	in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))
	in.Statuses[conn.ID][1].Tunnel = peer
	in.Statuses[conn.ID][1].Maintenance = awsx.Maintenance{Pending: true}

	plan := Evaluate(in)
	if len(plan.Candidates) == 0 {
		t.Fatalf("expected a candidate, blocked = %+v", plan.Blocked)
	}
	if len(plan.Candidates[0].Queue) != 0 {
		t.Fatalf("Queue = %v, want empty", plan.Candidates[0].Queue)
	}
}

// Chaining lets the sibling skip the cooldown, which is what allows both tunnels of a
// connection to be finished in one window.
func TestCooldownIsSkippedForTheSiblingAfterASuccess(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))
	in.Thresholds.ChainSiblingTunnel = true
	in.History[conn.ID] = ConnectionState{
		LastReplacementAt: now.Add(-20 * time.Minute),
		LastTunnelIP:      "2.2.2.2",
		LastSucceeded:     true,
	}

	plan := Evaluate(in)
	if len(plan.Candidates) != 1 {
		t.Fatalf("the sibling should chain past the cooldown; blocked = %+v", plan.Blocked)
	}
	if !plan.Candidates[0].Chained {
		t.Fatal("the candidate must be marked as chained so the approver is told")
	}
}

// Everything that makes chaining safe is a measurement, not a timer: the just-replaced
// tunnel has to be a peer good enough to fail over to.
func TestChainingStillRespectsPeerStability(t *testing.T) {
	peer := healthyPeer("2.2.2.2")
	peer.LastStatusChange = now.Add(-2 * time.Minute) // just came back
	conn := connection(targetTunnel("1.1.1.1"), peer)
	in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))
	in.Thresholds.ChainSiblingTunnel = true
	in.History[conn.ID] = ConnectionState{
		LastReplacementAt: now.Add(-3 * time.Minute),
		LastTunnelIP:      "2.2.2.2",
		LastSucceeded:     true,
	}

	plan := Evaluate(in)
	if len(plan.Candidates) != 0 {
		t.Fatal("a freshly replaced peer is not yet safe to rely on")
	}
	if !blockedFor(plan, "1.1.1.1", ReasonPeerUnstable) {
		t.Fatalf("want %q, blocked = %+v", ReasonPeerUnstable, plan.Blocked)
	}
}

func TestCooldownStillBlocksAfterAFailureOrOnTheSameTunnel(t *testing.T) {
	tests := []struct {
		name string
		hist ConnectionState
		want string
	}{
		{
			name: "previous replacement failed",
			hist: ConnectionState{LastReplacementAt: now.Add(-time.Hour), LastTunnelIP: "2.2.2.2", LastSucceeded: false},
			want: "did not end healthy",
		},
		{
			name: "same tunnel again",
			hist: ConnectionState{LastReplacementAt: now.Add(-time.Hour), LastTunnelIP: "1.1.1.1", LastSucceeded: true},
			want: "same tunnel",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
			in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))
			in.Thresholds.ChainSiblingTunnel = true
			in.History[conn.ID] = tc.hist

			plan := Evaluate(in)
			if len(plan.Candidates) != 0 {
				t.Fatalf("expected the cooldown to hold, got %+v", plan.Candidates)
			}
			if !blockedFor(plan, "1.1.1.1", ReasonCooldown) {
				t.Fatalf("want %q, blocked = %+v", ReasonCooldown, plan.Blocked)
			}
			if !strings.Contains(blockedDetail(plan, "1.1.1.1"), tc.want) {
				t.Fatalf("detail = %q, want it to mention %q", blockedDetail(plan, "1.1.1.1"), tc.want)
			}
		})
	}
}

// With chaining off the cooldown applies to the sibling as well.
func TestChainingCanBeDisabled(t *testing.T) {
	conn := connection(targetTunnel("1.1.1.1"), healthyPeer("2.2.2.2"))
	in := pendingInput(conn, "1.1.1.1", now.Add(200*time.Hour))
	in.Thresholds.ChainSiblingTunnel = false
	in.History[conn.ID] = ConnectionState{
		LastReplacementAt: now.Add(-time.Hour), LastTunnelIP: "2.2.2.2", LastSucceeded: true,
	}

	plan := Evaluate(in)
	if len(plan.Candidates) != 0 {
		t.Fatal("chaining is off, so the cooldown must hold")
	}
	if !strings.Contains(blockedDetail(plan, "1.1.1.1"), "chaining is disabled") {
		t.Fatalf("detail = %q", blockedDetail(plan, "1.1.1.1"))
	}
}
