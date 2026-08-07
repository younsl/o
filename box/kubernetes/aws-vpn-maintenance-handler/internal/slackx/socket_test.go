package slackx

import (
	"testing"

	"github.com/slack-go/slack"
	"github.com/slack-go/slack/socketmode"
)

// interactiveEvent builds the Socket Mode envelope Slack delivers for a button click.
func interactiveEvent(actionID, value, userID string) socketmode.Event {
	return socketmode.Event{
		Type: socketmode.EventTypeInteractive,
		Data: slack.InteractionCallback{
			Type: slack.InteractionTypeBlockActions,
			User: slack.User{ID: userID, Name: "tester"},
			ActionCallback: slack.ActionCallbacks{
				BlockActions: []*slack.BlockAction{{ActionID: actionID, Value: value}},
			},
		},
		Request: &socketmode.Request{EnvelopeID: "envelope-1"},
	}
}

func testClient() *Client {
	return New("xoxb-test", "xapp-test", discardLogger())
}

func TestHandleInteractiveParsesApproveAndDeny(t *testing.T) {
	tests := []struct {
		actionID     string
		wantApproved bool
	}{
		{ActionApprove, true},
		{ActionDeny, false},
	}
	for _, tc := range tests {
		t.Run(tc.actionID, func(t *testing.T) {
			var got []Interaction
			testClient().handleInteractive(
				interactiveEvent(tc.actionID, "vpn-a|1.1.1.1|100", "U0APPROVER"),
				func(i Interaction) { got = append(got, i) })

			if len(got) != 1 {
				t.Fatalf("expected one interaction, got %d", len(got))
			}
			if got[0].Approved != tc.wantApproved {
				t.Fatalf("Approved = %t, want %t", got[0].Approved, tc.wantApproved)
			}
			// The value is the request ID; losing it would leave the click unable to
			// resolve any pending request.
			if got[0].RequestID != "vpn-a|1.1.1.1|100" {
				t.Fatalf("RequestID = %q", got[0].RequestID)
			}
			// The clicker travels through so the broker can check it against the
			// configured approvers.
			if got[0].UserID != "U0APPROVER" || got[0].UserName != "tester" {
				t.Fatalf("user = %+v", got[0])
			}
		})
	}
}

// Slack retries an unacked envelope, so acking is what stops the same approval being
// delivered twice. An envelope with nothing to ack must still be handled.
func TestHandleInteractiveWithoutAnEnvelope(t *testing.T) {
	evt := interactiveEvent(ActionApprove, "req-1", "U1")
	evt.Request = nil

	var got []Interaction
	testClient().handleInteractive(evt, func(i Interaction) { got = append(got, i) })

	if len(got) != 1 {
		t.Fatalf("the click must still be delivered, got %d", len(got))
	}
}

// Slack sends other block actions from the same app; only this controller's buttons
// may resolve a request.
func TestHandleInteractiveIgnoresUnknownActions(t *testing.T) {
	var got []Interaction
	testClient().handleInteractive(
		interactiveEvent("some_other_button", "req-1", "U1"),
		func(i Interaction) { got = append(got, i) })

	if len(got) != 0 {
		t.Fatalf("an unrelated action must be ignored, got %+v", got)
	}
}

// A view submission or shortcut carries no approval decision.
func TestHandleInteractiveIgnoresNonBlockActions(t *testing.T) {
	evt := interactiveEvent(ActionApprove, "req-1", "U1")
	cb := evt.Data.(slack.InteractionCallback)
	cb.Type = slack.InteractionTypeViewSubmission
	evt.Data = cb

	var got []Interaction
	testClient().handleInteractive(evt, func(i Interaction) { got = append(got, i) })

	if len(got) != 0 {
		t.Fatalf("a non-block-actions callback must be ignored, got %+v", got)
	}
}

// A payload that is not an InteractionCallback must be logged and dropped rather than
// panicking the Socket Mode loop, which would take approvals down entirely.
func TestHandleInteractiveSurvivesAnUnexpectedPayload(t *testing.T) {
	evt := socketmode.Event{
		Type:    socketmode.EventTypeInteractive,
		Data:    "not a callback",
		Request: &socketmode.Request{EnvelopeID: "envelope-1"},
	}

	var got []Interaction
	testClient().handleInteractive(evt, func(i Interaction) { got = append(got, i) })

	if len(got) != 0 {
		t.Fatalf("an unexpected payload must be dropped, got %+v", got)
	}
}

// One envelope can carry several actions, so every recognized one is forwarded.
func TestHandleInteractiveForwardsEveryRecognizedAction(t *testing.T) {
	evt := interactiveEvent(ActionApprove, "req-1", "U1")
	cb := evt.Data.(slack.InteractionCallback)
	cb.ActionCallback.BlockActions = append(cb.ActionCallback.BlockActions,
		&slack.BlockAction{ActionID: "unrelated", Value: "x"},
		&slack.BlockAction{ActionID: ActionDeny, Value: "req-2"},
	)
	evt.Data = cb

	var got []Interaction
	testClient().handleInteractive(evt, func(i Interaction) { got = append(got, i) })

	if len(got) != 2 {
		t.Fatalf("expected the two recognized actions, got %+v", got)
	}
	if !got[0].Approved || got[1].Approved {
		t.Fatalf("verdicts = %t/%t, want true/false", got[0].Approved, got[1].Approved)
	}
	if got[1].RequestID != "req-2" {
		t.Fatalf("second RequestID = %q", got[1].RequestID)
	}
}
