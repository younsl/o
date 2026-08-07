package approval

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
)

const approver = "U0APPROVER"

func newBroker() *Broker {
	return New([]string{approver}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func click(requestID string, approved bool, userID string) slackx.Interaction {
	return slackx.Interaction{RequestID: requestID, Approved: approved, UserID: userID, UserName: "tester"}
}

func TestWaitReceivesAnApproval(t *testing.T) {
	b := newBroker()
	go func() {
		// Handle only delivers once a waiter is registered, so retry briefly.
		for range 200 {
			if b.Pending()["req-1"] {
				b.Handle(click("req-1", true, approver))
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()

	decision, err := b.Wait(context.Background(), "req-1", 2*time.Second)
	if err != nil {
		t.Fatalf("Wait returned error: %v", err)
	}
	if !decision.Approved || decision.UserID != approver {
		t.Fatalf("decision = %+v", decision)
	}
	if decision.At.IsZero() {
		t.Fatal("the decision must be timestamped for the audit trail")
	}
}

func TestWaitReceivesADenial(t *testing.T) {
	b := newBroker()
	go func() {
		for range 200 {
			if b.Pending()["req-1"] {
				b.Handle(click("req-1", false, approver))
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()

	decision, err := b.Wait(context.Background(), "req-1", 2*time.Second)
	if err != nil {
		t.Fatalf("Wait returned error: %v", err)
	}
	if decision.Approved {
		t.Fatal("a deny click must not read as approved")
	}
}

func TestWaitTimesOut(t *testing.T) {
	b := newBroker()

	_, err := b.Wait(context.Background(), "req-1", 20*time.Millisecond)
	if !errors.Is(err, ErrTimeout) {
		t.Fatalf("error = %v, want ErrTimeout", err)
	}
	if len(b.Pending()) != 0 {
		t.Fatal("an expired request must not stay registered, or it would block the tunnel forever")
	}
}

func TestWaitStopsOnCancel(t *testing.T) {
	b := newBroker()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(10 * time.Millisecond)
		cancel()
	}()

	_, err := b.Wait(ctx, "req-1", time.Minute)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

// Anyone who can see a forwarded card could click it, so the clicker is checked
// against the configured approvers and not merely logged.
func TestHandleIgnoresAnUnconfiguredUser(t *testing.T) {
	b := newBroker()
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := b.Wait(context.Background(), "req-1", 60*time.Millisecond); !errors.Is(err, ErrTimeout) {
			t.Errorf("a click from an unconfigured user must not resolve the request; got %v", err)
		}
	}()

	for range 200 {
		if b.Pending()["req-1"] {
			break
		}
		time.Sleep(time.Millisecond)
	}
	b.Handle(click("req-1", true, "U0STRANGER"))
	<-done
}

// Cards stay clickable after they are resolved or expire, so a click for an unknown
// request is normal and must simply be dropped.
func TestHandleIgnoresAnUnknownRequest(t *testing.T) {
	b := newBroker()
	b.Handle(click("does-not-exist", true, approver))
	if len(b.Pending()) != 0 {
		t.Fatal("handling an unknown request must not register anything")
	}
}

// The first click wins; a second must not deliver again, which would otherwise let a
// resolved request be approved twice.
func TestHandleResolvesOnlyOnce(t *testing.T) {
	b := newBroker()
	got := make(chan Decision, 2)
	go func() {
		d, err := b.Wait(context.Background(), "req-1", 2*time.Second)
		if err != nil {
			t.Errorf("Wait returned error: %v", err)
			return
		}
		got <- d
	}()

	for range 200 {
		if b.Pending()["req-1"] {
			break
		}
		time.Sleep(time.Millisecond)
	}
	b.Handle(click("req-1", true, approver))
	b.Handle(click("req-1", false, approver))

	select {
	case d := <-got:
		if !d.Approved {
			t.Fatal("the first click should have won")
		}
	case <-time.After(time.Second):
		t.Fatal("no decision delivered")
	}
	if len(got) != 0 {
		t.Fatal("a second click must not deliver another decision")
	}
}

// Pending is what stops the planner re-proposing a tunnel already in front of an
// approver, so it has to reflect registration immediately.
func TestPendingReportsOutstandingRequests(t *testing.T) {
	b := newBroker()
	ch := b.register("req-1")
	defer b.unregister("req-1")

	pending := b.Pending()
	if !pending["req-1"] {
		t.Fatalf("Pending = %+v, want req-1", pending)
	}
	// The returned map is a copy, so a caller cannot corrupt the broker's state.
	pending["req-2"] = true
	if b.Pending()["req-2"] {
		t.Fatal("Pending must return a copy")
	}
	if ch == nil {
		t.Fatal("register must return a channel")
	}
}

// A decision arriving before the waiter reaches its select must be buffered, not
// dropped, or a fast click would be lost.
func TestDecisionArrivingEarlyIsBuffered(t *testing.T) {
	b := newBroker()
	ch := b.register("req-1")

	b.mu.Lock()
	delivered := b.pending["req-1"]
	b.mu.Unlock()
	if delivered == nil {
		t.Fatal("register did not store the channel")
	}

	delivered <- Decision{Approved: true, UserID: approver, At: time.Now()}
	select {
	case d := <-ch:
		if !d.Approved {
			t.Fatal("buffered decision lost its verdict")
		}
	default:
		t.Fatal("the channel must buffer one decision")
	}
}

// A caller re-checking preconditions on a ticker keeps one Watch registration for the
// whole wait. Nothing it does between re-checks may make the request look resolved, or
// a click arriving at that moment would be dropped.
func TestWatchStaysRegisteredAcrossRepeatedChecks(t *testing.T) {
	b := newBroker()
	ch, release := b.Watch("req-1")
	defer release()

	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for range 20 {
		<-ticker.C
		if !b.Pending()["req-1"] {
			t.Fatal("Watch must keep the request outstanding between checks")
		}
	}

	b.Handle(click("req-1", true, approver))
	select {
	case d := <-ch:
		if !d.Approved {
			t.Fatal("the click lost its verdict")
		}
	case <-time.After(time.Second):
		t.Fatal("a click after several checks was not delivered")
	}
}

func TestReleaseStopsDelivery(t *testing.T) {
	b := newBroker()
	_, release := b.Watch("req-1")
	release()

	if b.Pending()["req-1"] {
		t.Fatal("release must drop the registration")
	}
	// Dropped rather than panicking on a send to a channel nobody reads.
	b.Handle(click("req-1", true, approver))
}

func TestMultipleApproversAreAccepted(t *testing.T) {
	b := New([]string{"U1", "U2"}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, uid := range []string{"U1", "U2"} {
		go func() {
			for range 200 {
				if b.Pending()["req-"+uid] {
					b.Handle(click("req-"+uid, true, uid))
					return
				}
				time.Sleep(time.Millisecond)
			}
		}()
		d, err := b.Wait(context.Background(), "req-"+uid, 2*time.Second)
		if err != nil {
			t.Fatalf("Wait for %s returned error: %v", uid, err)
		}
		if d.UserID != uid {
			t.Fatalf("decision came from %q, want %q", d.UserID, uid)
		}
	}
}
