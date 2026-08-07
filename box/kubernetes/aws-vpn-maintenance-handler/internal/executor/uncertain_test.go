package executor

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
)

// An unanswered call may still have been accepted. Declaring failure would leave a
// real replacement with nobody watching it, including nobody to notice the peer
// dropping, so the run has to continue into verification.
func TestRunVerifiesAfterAnUnansweredCall(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{
		replaceErr: fmt.Errorf("%w: connection reset", awsx.ErrReplaceUncertain),
		snapshots: []awsx.Connection{
			snapshot(false, 0, true, started),
			snapshot(true, 7, true, started.Add(time.Millisecond)),
		},
	}
	rec := &recorder{}

	result := New(fake, opts(), discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, started)), rec)

	if result.Outcome != OutcomeSucceeded {
		t.Fatalf("Outcome = %s (%s), want %s", result.Outcome, result.Detail, OutcomeSucceeded)
	}
	if _, describes := fake.calls(); describes == 0 {
		t.Fatal("an unanswered call must be verified, not written off")
	}
	if rec.mentions("Nothing was replaced") {
		t.Fatalf("an unanswered call must not claim nothing happened: %v", rec.all())
	}
	if !rec.mentions("may or may not be under way") {
		t.Fatalf("the uncertainty must be stated: %v", rec.all())
	}
}

// The timeout message decides where the operator looks first. After an unanswered
// call the likely case is a tunnel nothing was done to, not one stuck mid-replacement.
func TestUncertainTimeoutSaysItMayNeverHaveStarted(t *testing.T) {
	started := time.Now()
	stale := snapshot(true, 9, true, started.Add(-time.Hour))
	fake := &fakeVPN{
		replaceErr: fmt.Errorf("%w: i/o timeout", awsx.ErrReplaceUncertain),
		snapshots:  []awsx.Connection{stale},
	}
	rec := &recorder{}

	o := opts()
	o.VerifyTimeout = 60 * time.Millisecond
	result := New(fake, o, discardLogger()).Run(context.Background(), request(stale), rec)

	if result.Outcome != OutcomeVerifyTimeout {
		t.Fatalf("Outcome = %s, want %s", result.Outcome, OutcomeVerifyTimeout)
	}
	if !rec.mentions("may never have started") {
		t.Fatalf("the timeout must not imply a stuck replacement: %v", rec.all())
	}
	if rec.mentions("cannot be rolled back") {
		t.Fatalf("nothing may have been replaced, so the rollback warning is wrong: %v", rec.all())
	}
}

// A dry run changes nothing whatever the transport did, so an unanswered dry run is
// simply a failed dry run. Verifying one would watch a tunnel that was never going
// to move.
func TestUncertainDryRunDoesNotVerify(t *testing.T) {
	fake := &fakeVPN{replaceErr: fmt.Errorf("%w: i/o timeout", awsx.ErrReplaceUncertain)}
	rec := &recorder{}

	req := request(snapshot(true, 9, true, time.Now()))
	req.DryRun = true
	result := New(fake, opts(), discardLogger()).Run(context.Background(), req, rec)

	if result.Outcome != OutcomeRequestFailed {
		t.Fatalf("Outcome = %s, want %s", result.Outcome, OutcomeRequestFailed)
	}
	if _, describes := fake.calls(); describes != 0 {
		t.Fatalf("a dry run replaced nothing, so it must not verify; %d Describe calls", describes)
	}
	if !rec.mentions("Nothing was replaced") {
		t.Fatalf("a failed dry run must say nothing changed: %v", rec.all())
	}
}

// The definite rejection keeps its old, stronger wording: AWS answered and refused.
func TestDefiniteRejectionStillReportsNothingReplaced(t *testing.T) {
	fake := &fakeVPN{replaceErr: fmt.Errorf("UnauthorizedOperation")}
	rec := &recorder{}

	result := New(fake, opts(), discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, time.Now())), rec)

	if result.Outcome != OutcomeRequestFailed {
		t.Fatalf("Outcome = %s, want %s", result.Outcome, OutcomeRequestFailed)
	}
	if _, describes := fake.calls(); describes != 0 {
		t.Fatal("a definite rejection must not be verified")
	}
	for _, msg := range rec.all() {
		if strings.Contains(msg, "may or may not") {
			t.Fatalf("a definite rejection must not read as uncertain: %q", msg)
		}
	}
}
