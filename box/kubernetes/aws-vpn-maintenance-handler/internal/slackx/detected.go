package slackx

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/slack-go/slack"
)

// Detected is the display form of maintenance AWS has queued on one VPN connection that
// is not being replaced yet, a plain value type for the same reason Proposal is one.
//
// It exists because the approval card is not the right message for this. A card asks for
// a decision that cannot be made yet: the window is shut, or a preflight rule is holding
// the tunnels back. Sending nothing instead leaves the first anyone hears of queued
// maintenance to be a button appearing in the middle of the night, so this is the
// message in between, and it carries no buttons on purpose.
//
// One notice covers the connection, not one of its tunnels, which is the same scope the
// approval that follows will have. Two tunnels of one connection are one piece of news.
type Detected struct {
	// NoticeID is the identity this notice was sent under: the request ID of every
	// tunnel cycle it covers, so a reader can match it against the logs and the state.
	NoticeID     string
	ConnectionID string
	// ConnectionName is the Name tag, or empty.
	ConnectionName string
	Region         string
	// Tunnels are the tunnels with maintenance queued, in address order.
	Tunnels []DetectedTunnel
	// NextWindow is when the maintenance window next opens. Zero when it is open now,
	// where the wait is a preflight rule rather than the schedule.
	NextWindow time.Time
	// Window renders the configured maintenance window.
	Window string
}

// DetectedTunnel is one tunnel of the connection with maintenance queued.
type DetectedTunnel struct {
	IP         string
	Deadline   time.Time
	DeadlineIn time.Duration
	// Reason is why this tunnel is not being replaced, in mrkdwn. It is the planner's
	// own explanation, so the notice and the logs give the same account.
	Reason string
	// Escalate marks a deadline already inside safety.escalateBefore, which makes the
	// notice worth reading now rather than at the next window.
	Escalate bool
	// Unmanageable marks tunnel endpoint lifecycle control being off. That is a
	// configuration gap only a human can close, not something the next window fixes.
	Unmanageable bool
}

// subject names what the message is about, without its level. Only a connection whose
// every queued tunnel is unmanageable gets the harder wording: with one of two tunnels
// still under control, maintenance is going to be taken over, just not all of it.
func (d Detected) subject() string {
	if d.every(func(t DetectedTunnel) bool { return t.Unmanageable }) {
		return "VPN tunnel maintenance cannot be taken over"
	}
	return "Pending VPN tunnel maintenance detected"
}

// level classifies the notice. Nothing is being asked of anyone, so it is never ACTION:
// an approval card follows when the connection becomes proposable, and a notice that
// read as a pending decision would compete with it. Lifecycle control being off and a
// deadline already inside the escalation horizon are both WARN, because in neither case
// does waiting for the next window resolve anything.
func (d Detected) level() Level {
	if d.any(func(t DetectedTunnel) bool { return t.Unmanageable || t.Escalate }) {
		return LevelWarn
	}
	return LevelInfo
}

// Target names the VPN connection this notice is about.
func (d Detected) Target() string {
	return Label(d.ConnectionName, d.ConnectionID)
}

// title doubles as the start of the notification fallback, so the level and the
// connection are inside it: a phone push shows that line and nothing else.
func (d Detected) title() string {
	return Notice{Level: d.level(), Target: d.Target(), Text: d.subject()}.Render()
}

// DetectedBlocks renders the detection notice. No buttons: approving here would be a
// decision made without the preflight evidence the approval card carries.
func DetectedBlocks(d Detected) (string, []slack.Block) {
	fallback := fmt.Sprintf("%s %s. %s", d.title(), d.tunnelList(), d.deadlineSummary())

	details := []*slack.TextBlockObject{
		mrkdwnField("VPN connection", d.connectionLabel()),
		mrkdwnField("Region", d.Region),
	}

	blocks := []slack.Block{
		slack.NewHeaderBlock(slack.NewTextBlockObject(slack.PlainTextType, d.title(), true, false)),
		slack.NewSectionBlock(nil, details, nil),
		slack.NewSectionBlock(slack.NewTextBlockObject(slack.MarkdownType, d.queuedSummary(), false, false), nil, nil),
		slack.NewSectionBlock(slack.NewTextBlockObject(slack.MarkdownType, d.reasonSummary(), false, false), nil, nil),
		slack.NewSectionBlock(slack.NewTextBlockObject(slack.MarkdownType, d.nextSummary(), false, false), nil, nil),
		slack.NewContextBlock("meta",
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("The maintenance window is %s. This notice is sent once per maintenance cycle. Request IDs are `%s`.",
					d.Window, d.NoticeID), false, false)),
	}
	return fallback, blocks
}

// queuedSummary lists what AWS has queued, one line per tunnel with its own deadline.
// Deadlines are per tunnel and can differ, so a single summary field would have to pick
// one and misreport the other.
func (d Detected) queuedSummary() string {
	var b strings.Builder
	b.WriteString("*Maintenance queued*\n")
	for _, t := range d.Tunnels {
		fmt.Fprintf(&b, "• `%s`, applied by AWS itself after %s\n", t.IP, t.deadlineText())
	}
	return strings.TrimRight(b.String(), "\n")
}

// reasonSummary explains the wait in the planner's own words, collapsed to one line when
// every tunnel is held by the same thing, which is the usual case.
func (d Detected) reasonSummary() string {
	head := "*Why it is not being replaced yet*\n"
	if len(d.Tunnels) == 1 {
		return head + d.Tunnels[0].Reason
	}
	same := d.every(func(t DetectedTunnel) bool { return t.Reason == d.Tunnels[0].Reason })
	if same {
		return head + d.Tunnels[0].Reason
	}

	var b strings.Builder
	b.WriteString(head)
	for _, t := range d.Tunnels {
		fmt.Fprintf(&b, "• `%s`: %s\n", t.IP, t.Reason)
	}
	return strings.TrimRight(b.String(), "\n")
}

// nextSummary says what happens next, and what has to be done by hand for any tunnel
// lifecycle control rules out. A notice with no buttons has to answer "so what do I do"
// itself, or it reads as an alert someone forgot to wire up.
func (d Detected) nextSummary() string {
	unmanageable := d.filter(func(t DetectedTunnel) bool { return t.Unmanageable })
	fix := fmt.Sprintf("Enable tunnel endpoint lifecycle control on %s with "+
		"`ModifyVpnTunnelOptions` (`EnableTunnelLifecycleControl`). Until then AWS applies that "+
		"maintenance on its own schedule, which may be during business hours, and no approval "+
		"request can be offered for it.", quoted(unmanageable))

	if len(unmanageable) == len(d.Tunnels) {
		return "*What to do*\n" + fix
	}

	line := "*What happens next*\nOne approval request arrives here covering this connection, once " +
		"it clears every preflight check inside the maintenance window. Nothing is needed from you " +
		"until then."
	if !d.NextWindow.IsZero() {
		line += fmt.Sprintf(" The window next opens at *%s*.", d.NextWindow.Format("2006-01-02 15:04 MST"))
	}
	if len(unmanageable) > 0 {
		line += "\n\n*What to do*\n" + fix
	}
	return line
}

// deadlineSummary is the one-line version for the notification fallback, where a phone
// shows nothing else. It reports the nearest deadline, which is the one that decides how
// soon this matters.
func (d Detected) deadlineSummary() string {
	nearest, ok := d.nearest()
	if !ok {
		return "AWS has published no auto-apply deadline yet."
	}
	return fmt.Sprintf("AWS applies it itself after %s.", nearest.deadlineText())
}

// nearest returns the tunnel AWS will take over first, and false when no tunnel has a
// published deadline.
func (d Detected) nearest() (DetectedTunnel, bool) {
	var (
		out   DetectedTunnel
		found bool
	)
	for _, t := range d.Tunnels {
		if t.Deadline.IsZero() {
			continue
		}
		if !found || t.Deadline.Before(out.Deadline) {
			out, found = t, true
		}
	}
	return out, found
}

// tunnelList names the tunnels for the fallback, where mrkdwn is not rendered.
func (d Detected) tunnelList() string {
	ips := make([]string, 0, len(d.Tunnels))
	for _, t := range d.Tunnels {
		ips = append(ips, t.IP)
	}
	if len(ips) == 1 {
		return "Tunnel " + ips[0]
	}
	return fmt.Sprintf("%d tunnels: %s", len(ips), strings.Join(ips, ", "))
}

func (t DetectedTunnel) deadlineText() string {
	if t.Deadline.IsZero() {
		return "no published deadline"
	}
	return fmt.Sprintf("%s (in %s)", t.Deadline.Format("2006-01-02 15:04 MST"), humanDuration(t.DeadlineIn))
}

func (d Detected) connectionLabel() string {
	if d.ConnectionName == "" {
		return "`" + d.ConnectionID + "`"
	}
	return fmt.Sprintf("%s (`%s`)", d.ConnectionName, d.ConnectionID)
}

func (d Detected) any(pred func(DetectedTunnel) bool) bool {
	return slices.ContainsFunc(d.Tunnels, pred)
}

// every reports whether pred holds for every tunnel. A notice is never built without one,
// so the vacuous true is not reachable.
func (d Detected) every(pred func(DetectedTunnel) bool) bool {
	return len(d.Tunnels) > 0 && !slices.ContainsFunc(d.Tunnels, func(t DetectedTunnel) bool { return !pred(t) })
}

func (d Detected) filter(pred func(DetectedTunnel) bool) []DetectedTunnel {
	var out []DetectedTunnel
	for _, t := range d.Tunnels {
		if pred(t) {
			out = append(out, t)
		}
	}
	return out
}

// quoted renders tunnel addresses as a readable mrkdwn list.
func quoted(tunnels []DetectedTunnel) string {
	ips := make([]string, 0, len(tunnels))
	for _, t := range tunnels {
		ips = append(ips, "`"+t.IP+"`")
	}
	switch len(ips) {
	case 0:
		return "this connection's tunnels"
	case 1:
		return ips[0]
	default:
		return strings.Join(ips[:len(ips)-1], ", ") + " and " + ips[len(ips)-1]
	}
}
