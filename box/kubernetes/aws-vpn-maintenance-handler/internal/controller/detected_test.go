package controller

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/events"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/planner"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/state"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/window"
)

// closeWindow replaces the harness window with one that never opens in this test's
// lifetime, which is how a tunnel is held back by the schedule rather than by a rule.
func closeWindow(t *testing.T, h *harness) {
	t.Helper()
	// Fires yearly on 1 January, so no test run is inside it.
	win, err := window.New(window.Config{
		Timezone: "UTC", CronSchedule: "0 0 1 1 *", Duration: time.Hour, MinRemaining: time.Minute,
	})
	if err != nil {
		t.Fatalf("window.New: %v", err)
	}
	h.ctrl.window = win
}

// pendingOnBoth queues maintenance on both tunnels of the connection, which is the case
// AWS produces most often and the reason the notice is scoped to the connection.
func pendingOnBoth() (awsx.Connection, []awsx.TunnelStatus) {
	conn, statuses := pendingOn(targetIP)
	for i := range statuses {
		statuses[i].Maintenance = awsx.Maintenance{
			Pending:          true,
			AutoAppliedAfter: time.Now().Add(200 * time.Hour),
		}
	}
	return conn, statuses
}

// One connection is one piece of news. Two notices for two tunnels of the same connection
// then get answered by a single approval card, which reads as a message having gone
// missing.
func TestOneNoticeCoversTheWholeConnection(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)

	h.vpn.set(pendingOnBoth())
	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}

	notices := h.slack.notices()
	if len(notices) != 1 {
		t.Fatalf("two queued tunnels of one connection must be one notice, got %d: %v", len(notices), notices)
	}
	// And it has to account for both, or the reader is left expecting a second message.
	for _, want := range []string{"2 tunnels", targetIP, peerIP} {
		if !strings.Contains(notices[0], want) {
			t.Fatalf("notice %q is missing %q", notices[0], want)
		}
	}
}

// The record is per connection, so passes after the first stay silent for both tunnels.
func TestConnectionNoticeIsNotRepeated(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)
	ctx := context.Background()

	h.vpn.set(pendingOnBoth())
	for range 3 {
		if err := h.ctrl.reconcile(ctx); err != nil {
			t.Fatalf("reconcile returned error: %v", err)
		}
	}
	if n := h.slack.notices(); len(n) != 1 {
		t.Fatalf("three passes must still send one notice, got %d: %v", len(n), n)
	}
	snap, err := h.store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snap.Notices) != 1 {
		t.Fatalf("one connection must hold one notice record, got %v", snap.Notices)
	}
}

// A tunnel joining the queue later is news the first notice did not carry, so the notice
// is re-sent covering both rather than staying silent about the second tunnel.
func TestASecondQueuedTunnelIsNotifiedAgain(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	if n := h.slack.notices(); len(n) != 1 || !strings.Contains(n[0], "Tunnel "+targetIP) {
		t.Fatalf("the first notice must cover the one queued tunnel, got %v", n)
	}

	h.vpn.set(pendingOnBoth())
	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("second reconcile returned error: %v", err)
	}
	notices := h.slack.notices()
	if len(notices) != 2 {
		t.Fatalf("a newly queued tunnel must be announced, got %d: %v", len(notices), notices)
	}
	if !strings.Contains(notices[1], "2 tunnels") {
		t.Fatalf("the second notice must cover both tunnels: %q", notices[1])
	}

	// The superseded record is dropped rather than left behind next to its replacement.
	snap, err := h.store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snap.Notices) != 1 {
		t.Fatalf("the superseded notice must be pruned, got %v", snap.Notices)
	}
}

// Two connections are two pieces of news, and grouping must not merge them.
func TestNoticesAreSeparatePerConnection(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)

	// The fake serves one connection, so the second comes from a hand-built plan.
	conn, statuses := pendingOnBoth()
	other := conn
	other.ID, other.Name = "vpn-00000000000000002", "stage-dc"

	plan := planner.Evaluate(planner.Input{
		Now:          time.Now(),
		Connections:  []awsx.Connection{conn, other},
		Statuses:     map[string][]awsx.TunnelStatus{conn.ID: statuses, other.ID: statuses},
		WindowOpen:   false,
		WindowDetail: "outside window",
		Thresholds:   planner.Thresholds{PeerMinStableFor: 15 * time.Minute, PeerMinAcceptedRoutes: 1},
	})

	h.ctrl.notifyDetected(context.Background(), plan, state.Snapshot{}, "")
	notices := h.slack.notices()
	if len(notices) != 2 {
		t.Fatalf("two connections must get one notice each, got %d: %v", len(notices), notices)
	}
	if strings.Contains(notices[0], "stage-dc") == strings.Contains(notices[1], "stage-dc") {
		t.Fatalf("each notice must be about one connection: %v", notices)
	}
}

// The notice is what makes queued maintenance visible before its window: without it, a
// tunnel AWS has queued work for is announced by an approval card and nothing earlier.
func TestNoticeIsSentWhileTheWindowIsClosed(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}

	notices := h.slack.notices()
	if len(notices) != 1 {
		t.Fatalf("expected one notice, got %v", notices)
	}
	if len(h.slack.proposals()) != 0 {
		t.Fatal("a closed window must not produce an approval card")
	}
	for _, want := range []string{
		slackx.LevelInfo.Tag(), // a deadline 200h out is not urgent
		"Pending VPN tunnel maintenance detected",
		targetIP,
	} {
		if !strings.Contains(notices[0], want) {
			t.Fatalf("notice %q is missing %q", notices[0], want)
		}
	}
	if !h.events.saw(events.ReasonMaintenanceDetected) {
		t.Fatal("the notice must leave an Event behind")
	}

	snap, err := h.store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snap.Notices) != 1 {
		t.Fatalf("the notice must be recorded in state, got %v", snap.Notices)
	}
}

// Once per maintenance cycle, not once per pass: the reconcile interval would otherwise
// turn one queued maintenance into a DM every few minutes for days.
func TestNoticeIsNotRepeatedOnLaterPasses(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)
	ctx := context.Background()

	for range 3 {
		if err := h.ctrl.reconcile(ctx); err != nil {
			t.Fatalf("reconcile returned error: %v", err)
		}
	}
	if n := h.slack.notices(); len(n) != 1 {
		t.Fatalf("three passes must still send one notice, got %d: %v", len(n), n)
	}
}

// The record lives in the ConfigMap rather than in memory, so a restart or a leader
// handover does not re-announce everything already announced.
func TestNoticeSurvivesARestart(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}

	// A fresh controller against the same ConfigMap is what a restarted Pod is.
	restarted := newHarnessWithKube(t, h.kube)
	closeWindow(t, restarted)
	if err := restarted.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile after restart returned error: %v", err)
	}
	if n := restarted.slack.notices(); len(n) != 0 {
		t.Fatalf("a restart must not re-send a delivered notice, got %v", n)
	}
}

// AWS moving the deadline is new work, and a request ID carries the deadline, so it is a
// new notice rather than one suppressed by the old record.
func TestNewMaintenanceCycleIsNotifiedAgain(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}

	conn, statuses := pendingOn(targetIP)
	for i := range statuses {
		if statuses[i].Maintenance.Pending {
			statuses[i].Maintenance.AutoAppliedAfter = time.Now().Add(300 * time.Hour)
		}
	}
	h.vpn.set(conn, statuses)

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	if n := h.slack.notices(); len(n) != 2 {
		t.Fatalf("a new maintenance cycle must get its own notice, got %d", len(n))
	}

	// And the finished cycle's record is dropped rather than accumulating one entry per
	// cycle for the lifetime of the ConfigMap.
	snap, err := h.store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snap.Notices) != 1 {
		t.Fatalf("the superseded notice must be pruned, got %v", snap.Notices)
	}
}

// A tunnel being proposed in the same pass needs no notice: the card says everything the
// notice would, and asks for the decision as well.
func TestNoNoticeWhenTheCardGoesOutInTheSamePass(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, false)
	h.awaitIdle(t)

	if len(h.slack.proposals()) != 1 {
		t.Fatalf("expected the approval card, got %v", h.slack.proposals())
	}
	if n := h.slack.notices(); len(n) != 0 {
		t.Fatalf("a proposed tunnel must not also be notified about, got %v", n)
	}
}

// The card covers the connection, so the tunnel queued behind the one it names must not
// draw a notice of its own alongside it.
func TestNoNoticeForTheTunnelQueuedBehindACard(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	h.vpn.set(pendingOnBoth())
	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, false)
	h.awaitIdle(t)

	if len(h.slack.proposals()) != 1 {
		t.Fatalf("one card covers the connection, got %v", h.slack.proposals())
	}
	if n := h.slack.notices(); len(n) != 0 {
		t.Fatalf("a connection being proposed must draw no notice, got %v", n)
	}
}

// While a card is outstanding the planner reports the tunnel as awaiting_approval. A
// notice then would be a second message about a decision already in front of the reader.
func TestNoNoticeWhileAnApprovalIsOutstanding(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	// A second pass with the request still pending, before anyone clicks.
	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("second reconcile returned error: %v", err)
	}
	if n := h.slack.notices(); len(n) != 0 {
		t.Fatalf("an outstanding approval must not draw a notice, got %v", n)
	}

	h.awaitApproval(t, false)
	h.awaitIdle(t)
}

// A deadline inside safety.escalateBefore is a notice worth reading now, not at the next
// window, so it is not INFO.
func TestNoticeEscalatesOnANearDeadline(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)

	conn, statuses := pendingOn(targetIP)
	for i := range statuses {
		if statuses[i].Maintenance.Pending {
			// escalateBefore is 72h in the harness.
			statuses[i].Maintenance.AutoAppliedAfter = time.Now().Add(3 * time.Hour)
		}
	}
	h.vpn.set(conn, statuses)

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	notices := h.slack.notices()
	if len(notices) != 1 {
		t.Fatalf("expected one notice, got %v", notices)
	}
	if !strings.Contains(notices[0], slackx.LevelWarn.Tag()) {
		t.Fatalf("a near deadline must not read as INFO: %q", notices[0])
	}
}

// Undeliverable notices are not recorded as sent, so the next pass tries again instead
// of suppressing a message nobody received.
func TestUndeliverableNoticeIsRetried(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)
	ctx := context.Background()

	h.slack.deliver = nil
	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	snap, err := h.store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snap.Notices) != 0 {
		t.Fatalf("a notice nobody received must not be recorded, got %v", snap.Notices)
	}

	h.slack.deliver = []slackx.MessageRef{{ChannelID: "D1", TS: "1750000000.000200"}}
	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("second reconcile returned error: %v", err)
	}
	if n := h.slack.notices(); len(n) != 2 {
		t.Fatalf("the retry must go out, got %d attempts", len(n))
	}
}

// Nothing queued means nothing to announce; the notice must not become a heartbeat.
func TestNoNoticeWithoutPendingMaintenance(t *testing.T) {
	h := newHarness(t)
	closeWindow(t, h)
	conn, _ := pendingOn("none")
	h.vpn.set(conn, []awsx.TunnelStatus{{Tunnel: conn.Tunnels[0]}, {Tunnel: conn.Tunnels[1]}})

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	if b, _, _ := h.slack.counts(); b != 0 {
		t.Fatal("a quiet pass must post nothing at all")
	}
}
