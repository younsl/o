// Package slackx direct-messages the approvers, collects their approve/deny
// decision, and streams progress back into the same thread. Clicks arrive over
// Socket Mode, an outbound WebSocket, so nothing inbound is exposed.
package slackx

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/slack-go/slack"
	"github.com/slack-go/slack/socketmode"
)

// MessageRef locates one posted Slack message. Progress updates are posted as
// replies to it, and the original card is edited in place when the request is
// resolved.
type MessageRef struct {
	// ChannelID is the DM channel with one approver.
	ChannelID string `json:"channelID"`
	// TS is the message timestamp, which is also the thread ID for replies.
	TS string `json:"ts"`
}

// Client posts to Slack and receives interaction callbacks.
type Client struct {
	api    *slack.Client
	socket *socketmode.Client
	logger *slog.Logger
}

// New builds a Client. botToken (xoxb-) authorizes posting; appToken (xapp-)
// opens the Socket Mode connection. opts is a seam for tests to redirect the API
// at a stub server; production callers pass none.
func New(botToken, appToken string, logger *slog.Logger, opts ...slack.Option) *Client {
	// slack-go logs to stderr through its own stdlib logger by default, which would
	// put Socket Mode reconnects and write failures in the Pod log in a format
	// nothing else uses. Both surfaces are bridged so every line the process emits
	// is slog.
	bridge := slogBridge{logger: logger.With("component", "slack")}
	base := []slack.Option{slack.OptionAppLevelToken(appToken), slack.OptionLog(bridge)}
	api := slack.New(botToken, append(base, opts...)...)
	return &Client{
		api:    api,
		socket: socketmode.New(api, socketmode.OptionLog(bridge)),
		logger: logger,
	}
}

// OpenDMs resolves each Slack user ID to a DM channel ID. A partial failure is not
// fatal: one reachable approver is enough to authorize maintenance.
func (c *Client) OpenDMs(ctx context.Context, userIDs []string) ([]string, error) {
	channels := make([]string, 0, len(userIDs))
	for _, uid := range userIDs {
		ch, _, _, err := c.api.OpenConversationContext(ctx, &slack.OpenConversationParameters{
			Users: []string{uid},
		})
		if err != nil {
			c.logger.Error("failed to open Slack DM channel", "user_id", uid, "error", err)
			continue
		}
		channels = append(channels, ch.ID)
	}
	if len(channels) == 0 {
		return nil, fmt.Errorf("could not open a DM channel with any of the %d configured approvers", len(userIDs))
	}
	return channels, nil
}

// Approver is a configured approver with the name to print for them.
type Approver struct {
	// ID is the Slack user ID, which stays the authorization identity: it is what
	// an interaction payload carries, and it survives a rename.
	ID string
	// Name is for humans reading a log line. It falls back to the ID when the
	// lookup is unavailable, so it is never empty.
	Name string
}

// ResolveApprovers puts a name to each configured user ID, so an operator can check
// the approver list against people rather than against opaque IDs.
//
// Cosmetic by design. A failed lookup, including the users:read scope not being
// granted, degrades to the bare ID instead of failing: the ID is what authorizes a
// click, and the controller must not refuse to start over a label.
func (c *Client) ResolveApprovers(ctx context.Context, userIDs []string) []Approver {
	out := make([]Approver, 0, len(userIDs))
	for _, uid := range userIDs {
		approver := Approver{ID: uid, Name: uid}
		user, err := c.api.GetUserInfoContext(ctx, uid)
		if err != nil {
			c.logger.Warn("could not resolve the name of a configured approver; logging the ID only",
				"user_id", uid, "error", err,
				"hint", "grant the users:read scope to print approver names")
			out = append(out, approver)
			continue
		}
		if name := displayName(user); name != "" {
			approver.Name = name
		}
		out = append(out, approver)
	}
	return out
}

// displayName prefers what the person chose to be called, then their real name, then
// the handle.
func displayName(u *slack.User) string {
	switch {
	case u == nil:
		return ""
	case u.Profile.DisplayName != "":
		return u.Profile.DisplayName
	case u.RealName != "":
		return u.RealName
	default:
		return u.Name
	}
}

// AuthTest verifies the bot token at startup, so a revoked token fails loudly
// rather than when maintenance is first queued.
func (c *Client) AuthTest(ctx context.Context) (string, error) {
	resp, err := c.api.AuthTestContext(ctx)
	if err != nil {
		return "", fmt.Errorf("slack auth.test: %w", err)
	}
	return resp.User, nil
}

// Post sends a message to a channel and returns its reference.
func (c *Client) Post(ctx context.Context, channelID, fallback string, blocks []slack.Block) (MessageRef, error) {
	_, ts, err := c.api.PostMessageContext(ctx, channelID,
		slack.MsgOptionText(fallback, false),
		slack.MsgOptionBlocks(blocks...),
	)
	if err != nil {
		return MessageRef{}, fmt.Errorf("post slack message to %s: %w", channelID, err)
	}
	return MessageRef{ChannelID: channelID, TS: ts}, nil
}

// Broadcast posts to every channel and returns the references that succeeded, so
// one unreachable approver does not block the others.
func (c *Client) Broadcast(ctx context.Context, channelIDs []string, fallback string, blocks []slack.Block) []MessageRef {
	refs := make([]MessageRef, 0, len(channelIDs))
	for _, ch := range channelIDs {
		ref, err := c.Post(ctx, ch, fallback, blocks)
		if err != nil {
			c.logger.Error("failed to post Slack message", "channel", ch, "error", err)
			continue
		}
		refs = append(refs, ref)
	}
	return refs
}

// Reply posts a threaded reply under each referenced message, so every progress
// step lands under the card the approver clicked.
//
// The level and the VPN connection are rendered here rather than by the caller, so a
// reply cannot reach Slack without either: a thread reply read on a phone is often the
// only thing an approver sees.
func (c *Client) Reply(ctx context.Context, refs []MessageRef, n Notice) {
	text := n.Render()
	for _, ref := range refs {
		_, _, err := c.api.PostMessageContext(ctx, ref.ChannelID,
			slack.MsgOptionText(text, false),
			slack.MsgOptionTS(ref.TS),
		)
		if err != nil {
			c.logger.Error("failed to post Slack thread reply",
				"channel", ref.ChannelID, "thread_ts", ref.TS, "error", err)
		}
	}
}

// Update rewrites each referenced message in place, replacing the buttons with the
// outcome so a resolved card cannot be clicked again.
func (c *Client) Update(ctx context.Context, refs []MessageRef, fallback string, blocks []slack.Block) {
	for _, ref := range refs {
		_, _, _, err := c.api.UpdateMessageContext(ctx, ref.ChannelID, ref.TS,
			slack.MsgOptionText(fallback, false),
			slack.MsgOptionBlocks(blocks...),
		)
		if err != nil {
			c.logger.Error("failed to update Slack message",
				"channel", ref.ChannelID, "ts", ref.TS, "error", err)
		}
	}
}
