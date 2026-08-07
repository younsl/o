package slackx

import (
	"context"
	"fmt"
	"time"

	"github.com/slack-go/slack"
	"github.com/slack-go/slack/socketmode"
)

// Action IDs on the approval buttons, matched on the way back in.
const (
	ActionApprove = "vtr_approve"
	ActionDeny    = "vtr_deny"
)

// Interaction is one approve/deny click, normalized from the Slack callback.
type Interaction struct {
	// RequestID is the button value: which proposed replacement this refers to.
	RequestID string
	// Approved is true for the approve button.
	Approved bool
	// UserID is the clicker, checked by the caller against the configured
	// approvers so a forwarded card cannot become an authorization.
	UserID string
	// UserName is the display name, for the audit trail.
	UserName string
}

// RunSocket consumes Socket Mode events until ctx is cancelled, calling handle for
// each click and onState on connect and disconnect. It blocks.
//
// The client reconnects on its own, so losing the socket delays approvals but never
// lets an unapproved replacement through: the executor only runs on a decision that
// arrived here.
func (c *Client) RunSocket(ctx context.Context, handle func(Interaction), onState func(connected bool)) error {
	go func() {
		// The events arrive on one channel, so connecting-then-connected pairs up
		// without locking. How long the pair took is worth logging: a reconnect
		// that grows slower over the day is throttling, and this line is the only
		// place it shows before approvals start arriving late.
		var connectingAt time.Time
		for evt := range c.socket.Events {
			switch evt.Type {
			case socketmode.EventTypeConnecting:
				connectingAt = time.Now()
				c.logger.Info("connecting to Slack over Socket Mode")
			case socketmode.EventTypeConnected:
				if connectingAt.IsZero() {
					c.logger.Info("Slack Socket Mode connected; approvals are live")
				} else {
					c.logger.Info("Slack Socket Mode connected; approvals are live",
						"took", time.Since(connectingAt).Round(time.Millisecond).String())
				}
				onState(true)
			case socketmode.EventTypeDisconnect:
				c.logger.Warn("Slack Socket Mode disconnected; approvals cannot be received until it reconnects")
				onState(false)
			case socketmode.EventTypeConnectionError:
				onState(false)
				c.logger.Error("Slack Socket Mode connection error; will retry", "error", fmt.Sprint(evt.Data))
			case socketmode.EventTypeIncomingError, socketmode.EventTypeErrorBadMessage, socketmode.EventTypeErrorWriteFailed:
				c.logger.Error("Slack Socket Mode error", "type", evt.Type, "data", fmt.Sprint(evt.Data))
			case socketmode.EventTypeInteractive:
				c.handleInteractive(evt, handle)
			default:
				// hello, slash commands, events API: unused here.
			}
		}
	}()

	if err := c.socket.RunContext(ctx); err != nil && ctx.Err() == nil {
		return fmt.Errorf("slack socket mode: %w", err)
	}
	return nil
}

// handleInteractive acks the envelope, then forwards recognized clicks. Acking
// first matters: Slack retries an unacked envelope, delivering the approval twice.
func (c *Client) handleInteractive(evt socketmode.Event, handle func(Interaction)) {
	cb, ok := evt.Data.(slack.InteractionCallback)
	if !ok {
		c.logger.Error("unexpected payload on interactive Slack event", "data_type", fmt.Sprintf("%T", evt.Data))
		return
	}
	if evt.Request != nil {
		// A dropped acknowledgement is not cosmetic: Slack retries an unacked
		// envelope, which would deliver the same approval twice.
		if err := c.socket.Ack(*evt.Request); err != nil {
			c.logger.Error("failed to acknowledge a Slack envelope; it may be redelivered",
				"envelope_id", evt.Request.EnvelopeID, "error", err)
		}
	}
	if cb.Type != slack.InteractionTypeBlockActions {
		return
	}

	for _, action := range cb.ActionCallback.BlockActions {
		var approved bool
		switch action.ActionID {
		case ActionApprove:
			approved = true
		case ActionDeny:
			approved = false
		default:
			continue
		}
		handle(Interaction{
			RequestID: action.Value,
			Approved:  approved,
			UserID:    cb.User.ID,
			UserName:  cb.User.Name,
		})
	}
}
