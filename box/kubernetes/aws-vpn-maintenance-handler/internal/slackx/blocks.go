package slackx

import (
	"fmt"
	"strings"
	"time"

	"github.com/slack-go/slack"
)

// Proposal is the display form of a proposed replacement, a plain value type so the
// Slack layer stays free of domain and AWS types.
type Proposal struct {
	RequestID    string
	ConnectionID string
	// ConnectionName is the Name tag, or empty.
	ConnectionName string
	// Gateway is the transit or virtual private gateway ID, and GatewayName its Name
	// tag. The name is what an approver recognizes; the ID is what they can paste
	// into the console.
	Gateway             string
	GatewayName         string
	CustomerGatewayID   string
	CustomerGatewayName string
	Region              string
	// TunnelIP is the tunnel about to be replaced, and the first step of the plan.
	TunnelIP string
	// Queue holds the connection's remaining tunnels, in the order they will be
	// replaced under this same approval. Empty when the approval covers one tunnel.
	Queue []string
	// StableRequirement is how long a replaced tunnel must hold UP before the next
	// one may start, which is what makes the plan a sequence rather than a batch.
	StableRequirement time.Duration
	// PeerIP is the tunnel that carries traffic during the replacement.
	PeerIP string
	// PeerRoutes and PeerStableFor are shown so the approver can judge the risk
	// instead of trusting the controller's verdict.
	PeerRoutes     int32
	PeerStableFor  time.Duration
	StaticRoutes   bool
	DeadlineIn     time.Duration
	Deadline       time.Time
	Escalate       bool
	DryRun         bool
	ApprovalExpiry time.Duration
	// Window renders the configured maintenance window.
	Window string
	// TrafficChecked reports whether the traffic gate ran, and TrafficDetail what
	// it found. Shown so the approver sees the measured load rather than trusting
	// that the schedule happened to be quiet.
	TrafficChecked bool
	TrafficDetail  string
}

// subject names what the message is about, without its level.
func (p Proposal) subject() string {
	s := "VPN tunnel replacement approval"
	if p.Escalate {
		s = "URGENT VPN tunnel replacement approval"
	}
	if p.DryRun {
		s += " (dry run)"
	}
	return s
}

// level classifies the approval card. An escalated request is CRITICAL because
// the AWS deadline is close enough that not answering has a cost.
func (p Proposal) level() Level {
	if p.Escalate {
		return LevelCritical
	}
	return LevelAction
}

// Target names the VPN connection this proposal is about, for the level-and-target
// prefix every message carries.
func (p Proposal) Target() string {
	return Label(p.ConnectionName, p.ConnectionID)
}

// title is also the notification fallback, so it is the whole content of a phone push
// notification: the level and the VPN connection have to be inside it rather than only
// in the card body, which a notification does not show.
func (p Proposal) title() string {
	return Notice{Level: p.level(), Target: p.Target(), Text: p.subject()}.Render()
}

// ApprovalBlocks renders the approval card with approve and deny buttons.
func ApprovalBlocks(p Proposal) (string, []slack.Block) {
	fallback := fmt.Sprintf("%s Tunnel %s is the one to replace.", p.title(), p.TunnelIP)

	details := []*slack.TextBlockObject{
		mrkdwnField("VPN connection", p.connectionLabel()),
		mrkdwnField("Region", p.Region),
		mrkdwnField("Tunnel to replace", "`"+p.TunnelIP+"`"),
		mrkdwnField("Tunnel carrying traffic", "`"+p.PeerIP+"`"),
		mrkdwnField("Gateway", orDash(Label(p.GatewayName, p.Gateway))),
		mrkdwnField("Customer gateway", orDash(Label(p.CustomerGatewayName, p.CustomerGatewayID))),
	}

	blocks := []slack.Block{
		slack.NewHeaderBlock(slack.NewTextBlockObject(slack.PlainTextType, p.title(), true, false)),
		slack.NewSectionBlock(nil, details, nil),
		slack.NewSectionBlock(slack.NewTextBlockObject(slack.MarkdownType, p.planSummary(), false, false), nil, nil),
		slack.NewSectionBlock(slack.NewTextBlockObject(slack.MarkdownType, p.preflightSummary(), false, false), nil, nil),
		slack.NewSectionBlock(slack.NewTextBlockObject(slack.MarkdownType, p.deadlineSummary(), false, false), nil, nil),
	}

	if p.DryRun {
		blocks = append(blocks, slack.NewContextBlock("dryrun",
			slack.NewTextBlockObject(slack.MarkdownType,
				"*Dry run is enabled.* Approving validates IAM permissions and arguments through the AWS "+
					"DryRun flag. No tunnel is replaced.", false, false)))
	} else {
		blocks = append(blocks, slack.NewContextBlock("irreversible",
			slack.NewTextBlockObject(slack.MarkdownType,
				"*This cannot be undone.* Approving replaces the tunnel endpoint immediately. The tunnel "+
					"drops for the duration of the replacement and traffic rides the other tunnel.", false, false)))
	}

	blocks = append(blocks,
		slack.NewActionBlock("approval",
			approveButton(p),
			denyButton(p),
		),
		slack.NewContextBlock("meta",
			slack.NewTextBlockObject(slack.MarkdownType,
				fmt.Sprintf("The maintenance window is %s. This request expires in %s. Request ID is `%s`.",
					p.Window, humanDuration(p.ApprovalExpiry), p.RequestID), false, false)),
	)
	return fallback, blocks
}

// approveButton carries a confirmation dialog. The extra click is deliberate: the
// API call is irreversible and a mis-tap on a phone is easy.
func approveButton(p Proposal) *slack.ButtonBlockElement {
	btn := slack.NewButtonBlockElement(ActionApprove, p.RequestID,
		slack.NewTextBlockObject(slack.PlainTextType, "Approve replacement", true, false))
	btn.Style = slack.StylePrimary

	confirmBody := fmt.Sprintf(
		"Replace tunnel %s of %s now.\n\nThis is irreversible. The tunnel will drop and traffic will ride %s.",
		p.TunnelIP, p.connectionLabel(), p.PeerIP)
	if p.DryRun {
		confirmBody = fmt.Sprintf(
			"This is a dry run. It validates the replacement of tunnel %s of %s.\n\nNothing will actually be replaced.",
			p.TunnelIP, p.connectionLabel())
	}
	btn.Confirm = slack.NewConfirmationBlockObject(
		slack.NewTextBlockObject(slack.PlainTextType, "Confirm replacement", true, false),
		slack.NewTextBlockObject(slack.PlainTextType, confirmBody, true, false),
		slack.NewTextBlockObject(slack.PlainTextType, "Replace it", true, false),
		slack.NewTextBlockObject(slack.PlainTextType, "Cancel", true, false),
	)
	btn.Confirm.Style = slack.StyleDanger
	return btn
}

func denyButton(p Proposal) *slack.ButtonBlockElement {
	btn := slack.NewButtonBlockElement(ActionDeny, p.RequestID,
		slack.NewTextBlockObject(slack.PlainTextType, "Deny", true, false))
	btn.Style = slack.StyleDanger
	return btn
}

// planSummary spells out the order the tunnels are replaced in, because approving
// covers the whole connection and the approver is authorizing every step, not the
// first one. A single-tunnel approval still gets the section, so the card never
// leaves the reader guessing whether the other tunnel is included.
func (p Proposal) planSummary() string {
	var b strings.Builder
	b.WriteString("*Replacement order*\n")
	fmt.Fprintf(&b, "1. `%s` starts now. Traffic rides `%s` while it is down.\n", p.TunnelIP, p.PeerIP)

	previous := p.TunnelIP
	for i, next := range p.Queue {
		fmt.Fprintf(&b, "%d. `%s` starts only once `%s` is back UP, carrying routes, and has held steady for %s.\n",
			i+2, next, previous, humanDuration(p.StableRequirement))
		previous = next
	}
	if len(p.Queue) == 0 {
		fmt.Fprintf(&b, "`%s` is not touched by this approval.", p.PeerIP)
		return b.String()
	}
	b.WriteString("Never two at once. Any step that would be unsafe stops the rest and leaves them for a later window.")
	return b.String()
}

// preflightSummary lists the passed checks with their numbers, so approval is an
// informed decision rather than a rubber stamp.
func (p Proposal) preflightSummary() string {
	var b strings.Builder
	b.WriteString("*Preflight checks passed*\n")
	fmt.Fprintf(&b, "• Peer tunnel `%s` is UP and has been stable for %s\n", p.PeerIP, humanDuration(p.PeerStableFor))
	if p.StaticRoutes {
		b.WriteString("• Connection is static-routes-only, so BGP route count is not a health signal\n")
	} else {
		fmt.Fprintf(&b, "• Peer tunnel is accepting %d BGP route(s)\n", p.PeerRoutes)
	}
	b.WriteString("• AWS reports pending endpoint maintenance and lifecycle control is enabled\n")
	if p.TrafficChecked {
		fmt.Fprintf(&b, "• Traffic gate reports that %s\n", p.TrafficDetail)
	}
	b.WriteString("• No other replacement is running, and this connection is out of cooldown")
	return b.String()
}

// deadlineSummary explains the cost of not approving: the real choice is between a
// known window and an AWS-chosen time.
func (p Proposal) deadlineSummary() string {
	if p.Deadline.IsZero() {
		return "*If you do nothing*\nAWS has not published an auto-apply deadline for this maintenance yet. " +
			"The request expires and the tunnel is proposed again in a later window."
	}
	line := fmt.Sprintf("*If you do nothing*\nAWS applies this maintenance itself after *%s* (in %s), "+
		"at a time of its choosing, which may be during business hours.",
		p.Deadline.Format("2006-01-02 15:04 MST"), humanDuration(p.DeadlineIn))
	if p.Escalate {
		line = "*URGENT.* " + line
	}
	return line
}

// ResolvedBlocks renders the card after a decision, without its buttons. level is
// the outcome's level, not the request's: a card that ended in ERROR must not keep
// reading as a pending action.
func ResolvedBlocks(p Proposal, level Level, outcome string) (string, []slack.Block) {
	resolved := Notice{Level: level, Target: p.Target(), Text: p.subject()}.Render()
	fallback := fmt.Sprintf("%s Tunnel %s. %s", resolved, p.TunnelIP, outcome)
	details := []*slack.TextBlockObject{
		mrkdwnField("VPN connection", p.connectionLabel()),
		mrkdwnField("Tunnel", "`"+p.TunnelIP+"`"),
		mrkdwnField("Peer tunnel", "`"+p.PeerIP+"`"),
		mrkdwnField("Region", p.Region),
	}
	return fallback, []slack.Block{
		slack.NewHeaderBlock(slack.NewTextBlockObject(slack.PlainTextType, resolved, true, false)),
		slack.NewSectionBlock(nil, details, nil),
		slack.NewSectionBlock(slack.NewTextBlockObject(slack.MarkdownType, outcome, false, false), nil, nil),
		slack.NewContextBlock("meta", slack.NewTextBlockObject(slack.MarkdownType, "`"+p.RequestID+"`", false, false)),
	}
}

func (p Proposal) connectionLabel() string {
	if p.ConnectionName == "" {
		return "`" + p.ConnectionID + "`"
	}
	return fmt.Sprintf("%s (`%s`)", p.ConnectionName, p.ConnectionID)
}

func mrkdwnField(label, value string) *slack.TextBlockObject {
	return slack.NewTextBlockObject(slack.MarkdownType, "*"+label+"*\n"+value, false, false)
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// humanDuration renders minutes below a day and whole hours above it.
func humanDuration(d time.Duration) string {
	switch {
	case d <= 0:
		return "0s"
	case d < time.Minute:
		return d.Round(time.Second).String()
	case d < 24*time.Hour:
		return d.Round(time.Minute).String()
	default:
		days := int(d.Hours()) / 24
		hours := int(d.Hours()) % 24
		if hours == 0 {
			return fmt.Sprintf("%dd", days)
		}
		return fmt.Sprintf("%dd%dh", days, hours)
	}
}
