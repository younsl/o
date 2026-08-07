package controller

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/config"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/promx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/window"
)

// shortenRevalidation runs the re-check on a test timescale. These tests are not
// parallel, so the swap is safe, and it is restored so a later test still sees the real
// interval.
func shortenRevalidation(t *testing.T) {
	t.Helper()
	original := revalidateInterval
	revalidateInterval = 10 * time.Millisecond
	t.Cleanup(func() { revalidateInterval = original })
}

// outstandingOn is the request the wait loop is handed once a card has been posted.
// expiryReason reads only the tunnel it names, so a test can put it straight in.
func outstandingOn(tunnelIP string) pendingRequest {
	return pendingRequest{
		requestID:    connID + "|" + tunnelIP + "|1786604400",
		connectionID: connID,
		tunnelIP:     tunnelIP,
	}
}

// exhaustedWindow is inside its window at every instant yet never has room to start,
// which is the state a window reaches once minRemaining bites. Expressing it this way
// rather than with a schedule that fires rarely keeps the test off the wall clock.
func exhaustedWindow(t *testing.T) *window.Window {
	t.Helper()
	w, err := window.New(window.Config{
		Timezone: "UTC", CronSchedule: "* * * * *", Duration: time.Hour, MinRemaining: 2 * time.Hour,
	})
	if err != nil {
		t.Fatalf("window.New: %v", err)
	}
	return w
}

// peerDownOn is the connection with the target's maintenance still queued but its peer
// DOWN, so replacing the target would drop the connection.
func peerDownOn(target string) (awsx.Connection, []awsx.TunnelStatus) {
	conn, statuses := pendingOn(target)
	for i := range conn.Tunnels {
		if conn.Tunnels[i].OutsideIP != target {
			conn.Tunnels[i].Up = false
		}
	}
	for i := range statuses {
		if statuses[i].Tunnel.OutsideIP != target {
			statuses[i].Tunnel.Up = false
		}
	}
	return conn, statuses
}

// A window with no room left to start cannot come back before the request expires, so
// the card has to be withdrawn rather than left offering a button that would abort.
func TestExpiryReasonEndsTheRequestWhenTheWindowHasNoRoomLeft(t *testing.T) {
	h := newHarness(t)
	h.ctrl.window = exhaustedWindow(t)

	detail, expired := h.ctrl.expiryReason(context.Background(), outstandingOn(targetIP), time.Now().Add(time.Hour))
	if !expired {
		t.Fatal("a window with no room to start must expire the request")
	}
	if detail == "" {
		t.Fatal("the approver has to be told why the card was withdrawn")
	}
}

// AWS applying the maintenance itself, or withdrawing it, leaves nothing to approve.
func TestExpiryReasonEndsTheRequestWhenMaintenanceIsGone(t *testing.T) {
	h := newHarness(t)
	h.vpn.set(pendingOn("none"))

	detail, expired := h.ctrl.expiryReason(context.Background(), outstandingOn(targetIP), time.Now().Add(time.Hour))
	if !expired {
		t.Fatal("a tunnel with no maintenance queued must expire the request")
	}
	if detail == "" {
		t.Fatal("the approver has to be told why the card was withdrawn")
	}
}

// A peer that dropped can come back, so the card stays live while there is still time
// for it to come back, settle, and have the replacement verified.
func TestExpiryReasonKeepsWaitingOnAPeerThatCouldStillRecover(t *testing.T) {
	h := newHarness(t)
	h.ctrl.cfg.Safety.PeerMinStableFor = config.Duration(time.Minute)
	h.ctrl.cfg.Safety.VerifyTimeout = config.Duration(time.Minute)
	h.vpn.set(peerDownOn(targetIP))

	// 30m left against the 2m a recovery would need.
	_, expired := h.ctrl.expiryReason(context.Background(), outstandingOn(targetIP), time.Now().Add(30*time.Minute))
	if expired {
		t.Fatal("a recoverable peer with time to spare must not expire the request")
	}
}

// The same peer with the budget gone is a card nobody can use: even an instant recovery
// could no longer be followed by a verified replacement.
func TestExpiryReasonEndsTheRequestWhenRecoveryCouldNoLongerFit(t *testing.T) {
	h := newHarness(t)
	h.vpn.set(peerDownOn(targetIP))

	// 45m needed to recover and verify, 5m left.
	detail, expired := h.ctrl.expiryReason(context.Background(), outstandingOn(targetIP), time.Now().Add(5*time.Minute))
	if !expired {
		t.Fatal("a recoverable peer with no time left must expire the request")
	}
	if detail == "" {
		t.Fatal("the approver has to be told why the card was withdrawn")
	}
}

// A read that failed says nothing about the tunnel. Expiring on it would cost an
// approver their card over a throttled API call.
func TestExpiryReasonIgnoresAFailedRead(t *testing.T) {
	h := newHarness(t)
	h.vpn.statusesErr = errors.New("throttled")

	if _, expired := h.ctrl.expiryReason(context.Background(), outstandingOn(targetIP), time.Now().Add(time.Minute)); expired {
		t.Fatal("a failed read must not expire the request")
	}
}

// Metrics that cannot be read are not a changed condition. With onError set to block an
// unreadable source holds a replacement back, but holding back is not the same as
// withdrawing the offer: an outage of the monitoring stack must not consume approvals
// nobody was given the chance to answer.
func TestExpiryReasonIgnoresAnUnreadableMetricSource(t *testing.T) {
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(down.Close)

	client, err := promx.New(promx.Config{Endpoint: down.URL, Timeout: time.Second})
	if err != nil {
		t.Fatalf("promx.New: %v", err)
	}
	gate, err := promx.NewGate(client, promx.GateConfig{
		Enabled: true, OnError: promx.OnErrorBlock, Percentile: 20,
	}, discardLogger())
	if err != nil {
		t.Fatalf("promx.NewGate: %v", err)
	}

	h := newHarness(t)
	h.ctrl.traffic = gate

	// Inside verifyTimeout, so the gate is consulted rather than skipped.
	_, expired := h.ctrl.expiryReason(context.Background(), outstandingOn(targetIP), time.Now().Add(time.Minute))
	if expired {
		t.Fatal("an unreadable metric source must not expire the request")
	}
}

// Querying the metric source before the budget is down to the verification a replacement
// would need cannot change any outcome, and a range query every tick is not free.
func TestExpiryReasonDoesNotQueryTrafficWhileThereIsTimeToSpare(t *testing.T) {
	var queries atomic.Int32
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		queries.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(stub.Close)

	client, err := promx.New(promx.Config{Endpoint: stub.URL, Timeout: time.Second})
	if err != nil {
		t.Fatalf("promx.New: %v", err)
	}
	gate, err := promx.NewGate(client, promx.GateConfig{
		Enabled: true, OnError: promx.OnErrorBlock, Percentile: 20,
	}, discardLogger())
	if err != nil {
		t.Fatalf("promx.NewGate: %v", err)
	}

	h := newHarness(t)
	h.ctrl.traffic = gate

	// 90m left against a 30m verifyTimeout.
	if _, expired := h.ctrl.expiryReason(context.Background(), outstandingOn(targetIP), time.Now().Add(90*time.Minute)); expired {
		t.Fatal("a healthy request with time to spare must not expire")
	}
	if got := queries.Load(); got != 0 {
		t.Fatalf("the metric source was queried %d time(s) with time to spare", got)
	}
}

// End to end: the card goes up, the maintenance disappears underneath it, and the wait
// loop withdraws the card instead of leaving a button that would only abort.
func TestOutstandingApprovalIsWithdrawnWhenItsPreconditionsLapse(t *testing.T) {
	h := newHarness(t)
	shortenRevalidation(t)

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	// Wait for the card before moving the world, so the request is genuinely outstanding.
	for range 400 {
		if len(h.broker.Pending()) > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if len(h.broker.Pending()) == 0 {
		t.Fatal("no approval request was registered")
	}

	h.vpn.set(pendingOn("none"))
	h.awaitIdle(t)

	if !h.slack.said("Expired") {
		t.Fatalf("the card was not withdrawn: %v", h.slack.messages())
	}
	if _, _, updates := h.slack.counts(); updates == 0 {
		t.Fatal("the card must be rewritten without its buttons")
	}
	if !h.events.saw("ApprovalExpired") {
		t.Fatal("an expiry that was not a timeout must be recorded as ApprovalExpired")
	}
	if h.events.saw("ApprovalTimedOut") {
		t.Fatal("lapsed preconditions must not be reported as nobody answering")
	}
	if len(h.broker.Pending()) != 0 {
		t.Fatal("the withdrawn request must no longer accept clicks")
	}
	if len(h.exec.calls()) != 0 {
		t.Fatal("nothing may be replaced after the card was withdrawn")
	}
}

// The re-check runs on a ticker for the whole wait, and a click can land between two of
// them. Losing it would leave the approver pressing a live button for nothing.
func TestAClickIsNotLostBetweenRevalidations(t *testing.T) {
	h := newHarness(t)
	shortenRevalidation(t)

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	// Long enough for several re-checks to have come and gone before the click.
	time.Sleep(80 * time.Millisecond)

	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if len(h.exec.calls()) == 0 {
		t.Fatalf("the approval was lost: %v", h.slack.messages())
	}
	if h.slack.said("Expired") {
		t.Fatalf("a healthy request must not expire: %v", h.slack.messages())
	}
}
