package controller

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/executor"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/state"
)

func TestProgressLine(t *testing.T) {
	for _, tc := range []struct {
		name string
		p    *progress
		want string
	}{
		// No run means no footer: an approval card's own replies are not a percentage
		// of anything yet.
		{"before any run", &progress{}, ""},
		{"nil", nil, ""},
		{"first phase of one tunnel", &progress{tunnels: 1, done: 0, phase: phaseChecking}, "Progress: 1/4 (25%)"},
		{"last phase of one tunnel", &progress{tunnels: 1, done: 0, phase: phaseRecorded}, "Progress: 4/4 (100%)"},
		// The halves are the interesting ones: 3/8 and 7/8 only read as 38% and 88%
		// because the percentage rounds rather than truncates.
		{"verifying the first of two", &progress{tunnels: 2, done: 0, phase: phaseVerifying}, "Progress: 3/8 (38%)"},
		{"first of two finished", &progress{tunnels: 2, done: 1, phase: phaseChecking}, "Progress: 5/8 (63%)"},
		{"verifying the second of two", &progress{tunnels: 2, done: 1, phase: phaseVerifying}, "Progress: 7/8 (88%)"},
		{"run finished", &progress{tunnels: 2, done: 1, phase: phaseRecorded}, "Progress: 8/8 (100%)"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.p.line(); got != tc.want {
				t.Fatalf("line() = %q, want %q", got, tc.want)
			}
		})
	}
}

// A run must never report more than all of itself, whatever the caller does with the
// counters. A percentage above 100 would read as a bug in the replacement, not in the
// footer.
func TestProgressNeverExceedsTheRun(t *testing.T) {
	p := &progress{tunnels: 1}
	p.at(5, phaseRecorded)
	if got := p.line(); got != "Progress: 4/4 (100%)" {
		t.Fatalf("line() = %q, want the run capped at its own size", got)
	}
}

func TestWithProgressAppendsOnItsOwnLine(t *testing.T) {
	got := withProgress("*Replaced.* tunnel UP.", &progress{tunnels: 1, phase: phaseRecorded})
	want := "*Replaced.* tunnel UP.\nProgress: 4/4 (100%)"
	if got != want {
		t.Fatalf("withProgress() = %q, want %q", got, want)
	}
	if got := withProgress("nothing running", &progress{}); got != "nothing running" {
		t.Fatalf("a message posted outside a run must be untouched, got %q", got)
	}
}

func TestRunReport(t *testing.T) {
	const took = 27*time.Minute + 30*time.Second

	for _, tc := range []struct {
		name  string
		p     *progress
		want  string
		level slackx.Level
		ok    bool
	}{
		{
			name: "both tunnels done", ok: true, level: slackx.LevelSuccess,
			p:    &progress{tunnels: 2, done: 1, phase: phaseRecorded, finished: 2},
			want: "*Run complete.* All 2 tunnel(s) of this connection are done. The whole run took 27m 30s.",
		},
		{
			// The tunnels left behind keep their queued maintenance, which is the fact
			// that decides whether anyone has to do something about this run.
			name: "stopped after the first", ok: true, level: slackx.LevelWarn,
			p: &progress{tunnels: 2, done: 0, phase: phaseRecorded, finished: 1},
			want: "*Run ended early.* 1 of 2 tunnel(s) replaced, and the whole run took 27m 30s. " +
				"The rest keep their queued maintenance and are proposed again in a later window.",
		},
		{
			name: "all replaced, one unhealthy", ok: true, level: slackx.LevelWarn,
			p: &progress{tunnels: 2, done: 1, phase: phaseRecorded, finished: 2, unhealthy: 1},
			want: "*Run finished.* All 2 tunnel(s) were replaced in 27m 30s, but 1 did not end healthy. " +
				"Read the steps above before treating this connection as done.",
		},
		// A single-tunnel run has already stated its duration one line above, on the
		// replacement itself. Saying it again reads as a second measurement.
		{name: "single tunnel", p: &progress{tunnels: 1, done: 0, phase: phaseRecorded, finished: 1}},
		// Approved, then held back by the re-check: nothing was replaced, so there is
		// no run to report the length of.
		{name: "nothing replaced", p: &progress{tunnels: 2, phase: phaseChecking}},
		{name: "no run at all", p: &progress{}},
		{name: "nil", p: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			level, summary, ok := tc.p.report(took)
			if ok != tc.ok {
				t.Fatalf("report() ok = %t, want %t (summary %q)", ok, tc.ok, summary)
			}
			if !ok {
				return
			}
			if level != tc.level {
				t.Fatalf("level = %q, want %q", level, tc.level)
			}
			if summary != tc.want {
				t.Fatalf("summary =\n%q\nwant\n%q", summary, tc.want)
			}
		})
	}
}

// The footer is what lets a reply read on its own say how much of the approved work is
// behind it, so every reply of a run carries one and the last says 100%.
func TestRunRepliesCarryProgress(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	conn, statuses := bothTunnelsPending()
	h.vpn.set(conn, statuses)
	h.ctrl.cfg.Safety.ChainSiblingTunnel = true

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	// The first tunnel of two: its own last phase is half the run.
	if !h.slack.said("Progress: 4/8 (50%)") {
		t.Fatalf("the first tunnel of two must close at half the run: %v", h.slack.messages())
	}
	if !h.slack.said("Progress: 8/8 (100%)") {
		t.Fatalf("the finished run must close at 100%%: %v", h.slack.messages())
	}
	if h.slack.said("Progress: 0/") {
		t.Fatalf("a phase is what is in progress, never zero of them: %v", h.slack.messages())
	}
}

// Nothing ran, so there is no progress to report. A percentage on an expired or denied
// card would say a replacement got part-way when none was ever started.
func TestApprovalRepliesCarryNoProgress(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, false)
	h.awaitIdle(t)

	for _, m := range h.slack.messages() {
		if strings.Contains(m, "Progress:") {
			t.Fatalf("a denied request must not report progress: %q", m)
		}
	}
}

// A finished run says so once, at the end, with the length of the whole thing. The
// per-tunnel lines cannot: the wait between tunnels appears in none of them.
func TestFinishedRunReportsItsTotalLength(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	conn, statuses := bothTunnelsPending()
	h.vpn.set(conn, statuses)
	h.ctrl.cfg.Safety.ChainSiblingTunnel = true

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if !h.slack.said("*Run complete.* All 2 tunnel(s) of this connection are done. The whole run took ") {
		t.Fatalf("a finished run must close with its own length: %v", h.slack.messages())
	}
	// The report is the last word on the run, after the closing line of its last tunnel.
	h.slack.mu.Lock()
	last := h.slack.replies[len(h.slack.replies)-1]
	h.slack.mu.Unlock()
	if !strings.Contains(last, "*Run complete.*") {
		t.Fatalf("the run report must come last, got %q", last)
	}
}

// A single-tunnel run already stated its duration on the replacement itself.
func TestSingleTunnelRunReportsNoTotal(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if h.slack.said("Run complete") || h.slack.said("whole run took") {
		t.Fatalf("one tunnel needs no run-wide total: %v", h.slack.messages())
	}
}

// A chain that gives up still says how long it ran and what it left behind. Silence
// there reads as a run still going.
func TestStoppedRunReportsWhatItLeftBehind(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	// The record points at targetIP, and only its sibling has maintenance queued, so
	// the chain has nothing to do and gives up with one tunnel of two done.
	conn, statuses := pendingOn(peerIP)
	h.vpn.set(conn, statuses)

	if err := h.store.SetInFlight(ctx, inFlightFor(state.PhaseWaiting, nil, 1)); err != nil {
		t.Fatalf("SetInFlight: %v", err)
	}
	h.ctrl.resumeInFlight(ctx)
	h.awaitIdle(t)

	if !h.slack.said("*Run ended early.* 1 of 2 tunnel(s) replaced, and the whole run took ") {
		t.Fatalf("a chain that stopped must report what it managed: %v", h.slack.messages())
	}
}

// The run clock is persisted, so a rollout mid-run does not make the connection look
// faster than it was.
func TestResumedRunTimesFromTheOriginalStart(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	conn, statuses := bothTunnelsPending()
	h.vpn.set(conn, statuses)
	h.ctrl.cfg.Safety.ChainSiblingTunnel = true

	rec := inFlightFor(state.PhaseWaiting, nil, 1)
	rec.RunStartedAt = time.Now().Add(-45 * time.Minute).UTC()
	if err := h.store.SetInFlight(ctx, rec); err != nil {
		t.Fatalf("SetInFlight: %v", err)
	}
	h.ctrl.resumeInFlight(ctx)
	h.awaitIdle(t)

	if !h.slack.said("The whole run took 45m 0") {
		t.Fatalf("the resumed run must count from the persisted start: %v", h.slack.messages())
	}
}

// Without RunStartedAt the record predates the run clock. Falling back to this tunnel's
// own start is the closest true answer, and still earlier than this process.
func TestResumedRunWithoutARunClockFallsBackToTheTunnel(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	conn, statuses := bothTunnelsPending()
	h.vpn.set(conn, statuses)
	h.ctrl.cfg.Safety.ChainSiblingTunnel = true

	rec := inFlightFor(state.PhaseWaiting, nil, 1)
	rec.RunStartedAt = time.Time{}
	rec.StartedAt = time.Now().Add(-20 * time.Minute).UTC()
	if err := h.store.SetInFlight(ctx, rec); err != nil {
		t.Fatalf("SetInFlight: %v", err)
	}
	h.ctrl.resumeInFlight(ctx)
	h.awaitIdle(t)

	if !h.slack.said("The whole run took 20m 0") {
		t.Fatalf("an old record must fall back to the tunnel's start: %v", h.slack.messages())
	}
}

// The next leader can only time the run from its real beginning if the record carries
// it, so the wait between tunnels has to persist it.
func TestWaitingRecordCarriesTheRunClock(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	conn, statuses := bothTunnelsPending()
	h.vpn.set(conn, statuses)
	h.ctrl.cfg.Safety.ChainSiblingTunnel = true

	var waiting *state.InFlight
	h.exec.onRun = func(ctx context.Context, req executor.Request) {
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

	if waiting == nil {
		t.Fatal("the second tunnel ran with no in-flight record")
	}
	if waiting.RunStartedAt.IsZero() {
		t.Fatal("the record must carry when the run began, not only when this tunnel did")
	}
	if !waiting.RunStartedAt.Before(waiting.StartedAt) && !waiting.RunStartedAt.Equal(waiting.StartedAt) {
		t.Fatalf("the run began at %s, after this tunnel's %s", waiting.RunStartedAt, waiting.StartedAt)
	}
}

// A restart does not restart the count. The approver was told about one run covering the
// connection, and the tunnels finished before the rollout are still part of it.
func TestResumedRunKeepsTheRunWideProgress(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	conn, statuses := bothTunnelsPending()
	h.vpn.set(conn, statuses)
	h.ctrl.cfg.Safety.ChainSiblingTunnel = true

	// One tunnel is already done, so the resumed run starts from half of it.
	if err := h.store.SetInFlight(ctx, inFlightFor(state.PhaseWaiting, nil, 1)); err != nil {
		t.Fatalf("SetInFlight: %v", err)
	}
	h.ctrl.resumeInFlight(ctx)
	h.awaitIdle(t)

	if !h.slack.said("Progress: 5/8 (63%)") {
		t.Fatalf("the resumed run must count the tunnel finished before the restart: %v", h.slack.messages())
	}
	if !h.slack.said("Progress: 8/8 (100%)") {
		t.Fatalf("the resumed run must still close at 100%%: %v", h.slack.messages())
	}
}
