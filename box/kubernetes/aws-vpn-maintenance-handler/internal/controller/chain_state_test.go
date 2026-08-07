package controller

import (
	"context"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/executor"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/planner"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/promx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/state"
)

// The phase is what a restart reads to tell a replacement that is definitely under way
// from one whose call may never have landed. Advancing it before AWS answers would
// erase that difference.
func TestPhaseAdvancesOnlyWhenAWSAccepts(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	var before, after state.Phase
	h.exec.onRun = func(ctx context.Context, req executor.Request) {
		snap, err := h.store.Load(ctx)
		if err != nil || snap.InFlight == nil {
			t.Errorf("no in-flight record during the run: %v", err)
			return
		}
		before = snap.InFlight.Phase

		req.OnAccepted(ctx)

		snap, err = h.store.Load(ctx)
		if err != nil || snap.InFlight == nil {
			t.Errorf("no in-flight record after acceptance: %v", err)
			return
		}
		after = snap.InFlight.Phase
	}

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if before != state.PhaseRequested {
		t.Fatalf("phase before acceptance = %q, want %q", before, state.PhaseRequested)
	}
	if after != state.PhaseVerifying {
		t.Fatalf("phase after acceptance = %q, want %q", after, state.PhaseVerifying)
	}
}

// A record left in the requested phase means nobody saw AWS accept the call, so the
// resumed run must be told the tunnel may never have moved.
func TestResumeCarriesTheUnknownAcceptance(t *testing.T) {
	for _, tc := range []struct {
		phase state.Phase
		want  bool
	}{
		{state.PhaseRequested, true},
		{state.PhaseVerifying, false},
	} {
		t.Run(string(tc.phase), func(t *testing.T) {
			h := newHarness(t)
			ctx := context.Background()

			if err := h.store.SetInFlight(ctx, inFlightFor(tc.phase, nil, 0)); err != nil {
				t.Fatalf("SetInFlight: %v", err)
			}
			h.ctrl.resumeInFlight(ctx)
			h.awaitIdle(t)

			calls := h.exec.calls()
			if len(calls) != 1 {
				t.Fatalf("expected one resumed run, got %d", len(calls))
			}
			if calls[0].AcceptanceUnknown != tc.want {
				t.Fatalf("AcceptanceUnknown = %t, want %t for phase %q",
					calls[0].AcceptanceUnknown, tc.want, tc.phase)
			}
		})
	}
}

// Between two tunnels of one approved run nothing is in flight at AWS, but the run is
// not over. Without a record there, a rollout in that gap would silently drop the
// tunnel the approver was told would also be replaced.
func TestChainRecordsTheWaitBetweenTunnels(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	conn, statuses := bothTunnelsPending()
	h.vpn.set(conn, statuses)
	// Chaining is what puts a second tunnel under one approval, which is the whole
	// subject of this test.
	h.ctrl.cfg.Safety.ChainSiblingTunnel = true

	var waiting *state.InFlight
	h.exec.onRun = func(ctx context.Context, req executor.Request) {
		// Captured on the second tunnel: by then the first has finished and the
		// record must describe a run that is still going.
		if req.TunnelIP != peerIP {
			return
		}
		snap, err := h.store.Load(ctx)
		if err != nil {
			t.Errorf("Load: %v", err)
			return
		}
		waiting = snap.InFlight
	}

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if len(h.exec.calls()) != 2 {
		t.Fatalf("both tunnels should be replaced under one approval, got %d", len(h.exec.calls()))
	}
	if waiting == nil {
		t.Fatal("the second tunnel ran with no in-flight record")
	}
	if waiting.Done != 1 {
		t.Fatalf("Done = %d during the second tunnel, want 1", waiting.Done)
	}
	snap, _ := h.store.Load(ctx)
	if snap.InFlight != nil {
		t.Fatalf("the finished run must clear the record: %+v", snap.InFlight)
	}
}

// A run picked up in the waiting phase had nothing in flight, so verifying the tunnel
// would watch one nobody touched. It continues from the queue instead, keeping the
// step numbers the approver already saw.
func TestResumeFromTheWaitingPhaseContinuesTheChain(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	conn, statuses := bothTunnelsPending()
	h.vpn.set(conn, statuses)
	h.ctrl.cfg.Safety.ChainSiblingTunnel = true

	if err := h.store.SetInFlight(ctx, inFlightFor(state.PhaseWaiting, nil, 1)); err != nil {
		t.Fatalf("SetInFlight: %v", err)
	}
	h.ctrl.resumeInFlight(ctx)
	h.awaitIdle(t)

	calls := h.exec.calls()
	if len(calls) != 1 {
		t.Fatalf("expected the queued tunnel to run, got %d", len(calls))
	}
	if calls[0].Resuming {
		t.Fatal("the queued tunnel was never started, so it must not be marked as resuming")
	}
	if calls[0].TunnelIP != targetIP {
		t.Fatalf("resumed tunnel = %s, want %s", calls[0].TunnelIP, targetIP)
	}
	if !h.slack.said("Step 2 of 2") {
		t.Fatalf("the numbering must carry over the restart: %v", h.slack.messages())
	}
	snap, _ := h.store.Load(ctx)
	if snap.InFlight != nil {
		t.Fatalf("the finished run must clear the record: %+v", snap.InFlight)
	}
}

// A run that gives up between tunnels must not leave the record behind: it would block
// every other connection and make the next leader resume a run that already stopped.
func TestChainClearsTheRecordWhenItStops(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	// The record points at targetIP, and only its sibling has maintenance queued, so
	// the chain has nothing to do and gives up.
	conn, statuses := pendingOn(peerIP)
	h.vpn.set(conn, statuses)

	if err := h.store.SetInFlight(ctx, inFlightFor(state.PhaseWaiting, nil, 1)); err != nil {
		t.Fatalf("SetInFlight: %v", err)
	}
	h.ctrl.resumeInFlight(ctx)
	h.awaitIdle(t)

	snap, _ := h.store.Load(ctx)
	if snap.InFlight != nil {
		t.Fatalf("a chain that stopped must clear its record: %+v", snap.InFlight)
	}
	if !h.slack.said("Stopping before tunnel") {
		t.Fatalf("the thread must say the run stopped: %v", h.slack.messages())
	}
}

// Traffic stops a connection before it is touched, not halfway through it. Once the
// first tunnel is replaced, stopping would leave the connection needing a second window,
// a second approval, and a second failover for the same maintenance, and the peer check
// has already proven the failover has a healthy path.
func TestChainContinuesThroughTheTrafficGate(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	conn, statuses := bothTunnelsPending()
	h.vpn.set(conn, statuses)
	h.ctrl.traffic = blockingGate(t)

	if err := h.store.SetInFlight(ctx, inFlightFor(state.PhaseWaiting, nil, 1)); err != nil {
		t.Fatalf("SetInFlight: %v", err)
	}
	h.ctrl.resumeInFlight(ctx)
	h.awaitIdle(t)

	calls := h.exec.calls()
	if len(calls) != 1 {
		t.Fatalf("the queued tunnel must run through a blocked traffic gate, got %d", len(calls))
	}
	if calls[0].TunnelIP != targetIP {
		t.Fatalf("resumed tunnel = %s, want %s", calls[0].TunnelIP, targetIP)
	}
	// Going ahead silently would leave an operator to infer it from the timestamps.
	if !h.slack.said("continues anyway") {
		t.Fatalf("an elevated reading the run went ahead through must be said out loud: %v", h.slack.messages())
	}
}

// blockingGate is a traffic gate whose metric source is unreachable, configured to block
// on error. It is the cheapest way to get a deterministic "not quiet" verdict.
func blockingGate(t *testing.T) *promx.Gate {
	t.Helper()
	client, err := promx.New(promx.Config{Endpoint: "http://127.0.0.1:1", Timeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("promx.New: %v", err)
	}
	gate, err := promx.NewGate(client, promx.GateConfig{
		Enabled: true, Percentile: 20, OnError: promx.OnErrorBlock,
	}, discardLogger())
	if err != nil {
		t.Fatalf("promx.NewGate: %v", err)
	}
	return gate
}

// inFlightFor builds a persisted record for the resume tests. The waiting phase points
// at the tunnel that is next, which is targetIP here, with peerIP already replaced.
func inFlightFor(phase state.Phase, queue []string, done int) state.InFlight {
	return state.InFlight{
		RequestID:    planner.RequestID(connID, targetIP, awsx.Maintenance{}),
		ConnectionID: connID,
		TunnelIP:     targetIP,
		PeerIP:       peerIP,
		Phase:        phase,
		StartedAt:    time.Now().Add(-time.Minute),
		ApprovedBy:   approver,
		Thread:       []slackx.MessageRef{{ChannelID: "D1", TS: "1750000000.000100"}},
		Queue:        queue,
		Done:         done,
	}
}

// bothTunnelsPending queues maintenance on both tunnels of the connection, which is
// what puts a second tunnel under the same approval.
func bothTunnelsPending() (awsx.Connection, []awsx.TunnelStatus) {
	conn, statuses := pendingOn(targetIP)
	for i := range statuses {
		statuses[i].Maintenance = awsx.Maintenance{
			Pending:          true,
			AutoAppliedAfter: time.Now().Add(200 * time.Hour),
		}
	}
	return conn, statuses
}

var _ = executor.OutcomeSucceeded
