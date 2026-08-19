package gateway

import (
	"errors"
	"fmt"
	"testing"
)

// summaryError stands in for the errors a2a returns, which carry a line meant
// for Slack alongside the chain meant for the log.
type summaryError struct {
	summary string
	detail  string
}

func (e summaryError) Error() string       { return e.detail }
func (e summaryError) UserMessage() string { return e.summary }

func TestUserMessagePrefersTheCarriedSummary(t *testing.T) {
	err := fmt.Errorf("submit analysis: %w", summaryError{
		summary: "the controller stopped responding",
		detail:  "gave up polling task after 6 consecutive failures",
	})
	if got := userMessage(err); got != "the controller stopped responding" {
		t.Errorf("userMessage() = %q, want the carried summary", got)
	}
}

// An error with no summary is a fault the thread cannot act on, and its text is
// unbounded, so Slack gets a fixed line instead.
func TestUserMessageFallsBackForAPlainError(t *testing.T) {
	got := userMessage(errors.New("read tcp 10.0.0.1:8083: connection reset by peer"))
	if got == "" {
		t.Fatal("userMessage() returned nothing")
	}
	if got != "an internal error occurred. check the gateway log." {
		t.Errorf("userMessage() = %q, want the fixed line", got)
	}
}
