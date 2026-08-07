package slackx

import "fmt"

// Level classifies every message this controller sends to Slack.
//
// The level is rendered into the message body rather than signalled by an icon or
// a colour, so it survives a forwarded screenshot, a phone notification preview,
// and a thread read back months later during an incident review. No message is
// posted without one: Client.Reply takes a Level, and the card builders derive
// theirs from the proposal and the outcome.
type Level string

const (
	// LevelInfo is an expected step that needs nothing from anyone.
	LevelInfo Level = "INFO"
	// LevelSuccess is a step that ended the way it was supposed to.
	LevelSuccess Level = "SUCCESS"
	// LevelAction is waiting on a human decision.
	LevelAction Level = "ACTION"
	// LevelWarn is a run that stopped safely: nothing was changed, or the change
	// is fine but worth reading.
	LevelWarn Level = "WARN"
	// LevelError is a run that failed, or a replacement that happened and did not
	// come back. Needs a human, but the connection still has a path.
	LevelError Level = "ERROR"
	// LevelCritical is the connection having no healthy tunnel, or a deadline close
	// enough that not answering is itself a decision.
	LevelCritical Level = "CRITICAL"
)

// Tag is the rendered level marker. Plain brackets rather than mrkdwn, because the
// same tag has to read correctly inside a header block, which is plain text only.
func (l Level) Tag() string { return "[" + string(l) + "]" }

// Prefix puts the tag in front of a message.
func (l Level) Prefix(msg string) string { return l.Tag() + " " + msg }

// Message formats a message with its level prefix.
func Message(l Level, format string, args ...any) string {
	return l.Prefix(fmt.Sprintf(format, args...))
}

// Label names a VPN connection by its Name tag and ID, falling back to the ID alone
// when the connection carries no Name tag. Plain text rather than mrkdwn, so the same
// label works in a header block.
func Label(name, id string) string {
	if name == "" {
		return id
	}
	return name + " (" + id + ")"
}

// Notice is one message posted to Slack.
//
// Level and Target are fields rather than something a caller may or may not write
// into Text: an approver reads these on a phone, often one reply at a time, where a
// message that does not say how bad it is or which VPN connection it is about is not
// actionable. Render puts both in front of the text.
type Notice struct {
	// Level is how severe the message is.
	Level Level
	// Target is the VPN connection the message is about, from Label.
	Target string
	// Text is the message itself, in mrkdwn.
	Text string
}

// Render builds the posted string as sentences. Separator punctuation is avoided on
// purpose: a Slack message is read as prose on a phone, and a line held together by
// colons and middots reads as a log record instead. A Notice with no Target still
// renders, because dropping a progress line over a missing Name tag would be worse.
func (n Notice) Render() string {
	if n.Target == "" {
		return n.Level.Prefix(n.Text)
	}
	return n.Level.Prefix("VPN connection " + n.Target + ". " + n.Text)
}
