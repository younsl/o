package awsx

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/smithy-go"
)

// apiErr is a service response: AWS received the request and answered.
type apiErr struct {
	code  string
	fault smithy.ErrorFault
}

func (e apiErr) Error() string                 { return e.code }
func (e apiErr) ErrorCode() string             { return e.code }
func (e apiErr) ErrorMessage() string          { return e.code }
func (e apiErr) ErrorFault() smithy.ErrorFault { return e.fault }

// A client-fault answer proves the replacement did not start, so it must not be
// reported as uncertain: that would send the controller off to verify a tunnel
// nothing was ever done to.
func TestReplaceReportsADefiniteRejection(t *testing.T) {
	fake := &fakeEC2{replaceErr: apiErr{code: "UnauthorizedOperation", fault: smithy.FaultClient}}

	err := NewWithAPI(fake).Replace(context.Background(), "vpn-a", "203.0.113.10", false)
	if err == nil {
		t.Fatal("Replace should have returned the rejection")
	}
	if errors.Is(err, ErrReplaceUncertain) {
		t.Fatalf("a client-fault rejection must be definite: %v", err)
	}
}

// A lost answer is the dangerous case: AWS may have accepted the request. Anything
// that is not a client-fault answer has to be treated as possibly applied.
func TestReplaceReportsAnUnansweredCallAsUncertain(t *testing.T) {
	tests := []struct {
		name string
		err  error
	}{
		{"timeout", context.DeadlineExceeded},
		{"cancelled", context.Canceled},
		{"connection failure", errors.New("dial tcp: i/o timeout")},
		{"server fault", apiErr{code: "InternalError", fault: smithy.FaultServer}},
		{"unknown fault", apiErr{code: "Weird", fault: smithy.FaultUnknown}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fake := &fakeEC2{replaceErr: tc.err}

			err := NewWithAPI(fake).Replace(context.Background(), "vpn-a", "203.0.113.10", false)
			if !errors.Is(err, ErrReplaceUncertain) {
				t.Fatalf("error = %v, want it to wrap ErrReplaceUncertain", err)
			}
			if !errors.Is(err, tc.err) {
				t.Fatalf("the cause must survive wrapping: %v", err)
			}
		})
	}
}

// The dry-run signal is an API error too, and it must keep its own meaning.
func TestReplaceStillDetectsTheDryRunSignal(t *testing.T) {
	fake := &fakeEC2{replaceErr: apiErr{code: "DryRunOperation", fault: smithy.FaultClient}}

	err := NewWithAPI(fake).Replace(context.Background(), "vpn-a", "203.0.113.10", true)
	if !errors.Is(err, ErrDryRunSucceeded) {
		t.Fatalf("error = %v, want ErrDryRunSucceeded", err)
	}
}
