package slackx

import (
	"strings"
	"testing"
	"time"
)

// Every level has to render a tag: an empty one would produce a message that reads
// as unclassified, which is the thing the level exists to prevent.
func TestEveryLevelRendersATag(t *testing.T) {
	levels := []Level{LevelInfo, LevelSuccess, LevelAction, LevelWarn, LevelError, LevelCritical}
	seen := map[string]bool{}
	for _, l := range levels {
		tag := l.Tag()
		if !strings.HasPrefix(tag, "[") || !strings.HasSuffix(tag, "]") || len(tag) <= 2 {
			t.Fatalf("Tag() = %q for level %q", tag, l)
		}
		if seen[tag] {
			t.Fatalf("two levels render the same tag %q", tag)
		}
		seen[tag] = true
	}
}

// The tag has to lead the message: in a phone notification only the first line is
// visible, so a level at the end is a level nobody reads.
func TestPrefixLeadsWithTheLevel(t *testing.T) {
	got := LevelCritical.Prefix("both tunnels are down")
	if !strings.HasPrefix(got, "[CRITICAL] ") {
		t.Fatalf("Prefix() = %q", got)
	}
	if !strings.HasSuffix(got, "both tunnels are down") {
		t.Fatalf("Prefix() dropped the message: %q", got)
	}
}

func TestMessageFormatsWithTheLevel(t *testing.T) {
	got := Message(LevelWarn, "tunnel %s is %s", "203.0.113.10", "DOWN")
	if got != "[WARN] tunnel 203.0.113.10 is DOWN" {
		t.Fatalf("Message() = %q", got)
	}
}

// A reply has to name the connection it is about: replies are read one at a time in
// a phone notification, where the card above them is not visible.
func TestNoticeNamesTheConnection(t *testing.T) {
	got := Notice{Level: LevelInfo, Target: Label("prod-dc", "vpn-a"), Text: "Tunnel is DOWN."}.Render()
	if got != "[INFO] VPN connection prod-dc (vpn-a). Tunnel is DOWN." {
		t.Fatalf("Render() = %q", got)
	}
}

// A connection with no Name tag still has to be identifiable, and a missing target
// must not swallow the message.
func TestLabelAndNoticeFallBackToTheID(t *testing.T) {
	if got := Label("", "vpn-a"); got != "vpn-a" {
		t.Fatalf("Label() = %q, want the bare ID", got)
	}
	if got := (Notice{Level: LevelWarn, Text: "held back"}).Render(); got != "[WARN] held back" {
		t.Fatalf("Render() without a target = %q", got)
	}
}

// A card carries its level in the header and the fallback, because the fallback is
// the whole content of a push notification.
func TestApprovalCardCarriesItsLevel(t *testing.T) {
	p := proposal()
	fallback, blocks := ApprovalBlocks(p)
	if !strings.HasPrefix(fallback, LevelAction.Tag()) {
		t.Fatalf("fallback = %q, want it to lead with %s", fallback, LevelAction.Tag())
	}
	if !strings.Contains(fallback, p.Target()) {
		t.Fatalf("fallback = %q, want it to name %s", fallback, p.Target())
	}
	body := render(t, blocks)
	if !strings.Contains(body, LevelAction.Tag()) {
		t.Fatal("the card header must carry the level")
	}
	if !strings.Contains(body, "prod-dc") {
		t.Fatal("the card header must carry the VPN Name tag")
	}

	p.Escalate = true
	escalated, _ := ApprovalBlocks(p)
	if !strings.HasPrefix(escalated, LevelCritical.Tag()) {
		t.Fatalf("escalated fallback = %q, want it to lead with %s", escalated, LevelCritical.Tag())
	}
}

// Gateway IDs identify nothing to a human. The card carries the Name tag of every
// AWS resource that has one, with the ID kept beside it for the console.
func TestApprovalCardNamesTheGateways(t *testing.T) {
	body := render(t, mustBlocks(t, proposal()))

	for _, want := range []string{"prod-tgw (tgw-abc)", "idc-router (cgw-abc)"} {
		if !strings.Contains(body, want) {
			t.Fatalf("card should carry %q: %s", want, body)
		}
	}
}

// Approving covers the whole connection, so the card has to state the order rather
// than leave the approver to infer it from a single tunnel field.
func TestApprovalCardStatesTheReplacementOrder(t *testing.T) {
	p := proposal()
	p.Queue = []string{"203.0.113.20"}
	p.StableRequirement = 15 * time.Minute

	body := render(t, mustBlocks(t, p))
	if !strings.Contains(body, "Replacement order") {
		t.Fatalf("the card must state the order: %s", body)
	}
	first := strings.Index(body, "203.0.113.10` starts now")
	second := strings.Index(body, "203.0.113.20` starts only once")
	if first < 0 || second < 0 {
		t.Fatalf("both steps must be listed: %s", body)
	}
	if second < first {
		t.Fatal("the steps must be listed in the order they run")
	}
	if !strings.Contains(body, "15m0s") {
		t.Fatalf("the wait between steps must be stated: %s", body)
	}
}

// A one-tunnel approval must say the other tunnel is untouched. Silence there reads
// as "maybe both", which is the one thing an approver must not have to guess.
func TestApprovalCardSaysWhenThePeerIsNotIncluded(t *testing.T) {
	body := render(t, mustBlocks(t, proposal()))
	if !strings.Contains(body, "203.0.113.20` is not touched by this approval") {
		t.Fatalf("a single-tunnel approval must say so: %s", body)
	}
}

// An untagged gateway, or one whose Name tag could not be read, still has to render
// as something an operator can paste into the console.
func TestApprovalCardFallsBackToGatewayIDs(t *testing.T) {
	p := proposal()
	p.GatewayName = ""
	p.CustomerGatewayName = ""

	body := render(t, mustBlocks(t, p))
	if !strings.Contains(body, "tgw-abc") || !strings.Contains(body, "cgw-abc") {
		t.Fatalf("the bare IDs must survive: %s", body)
	}
}

// The resolved card is levelled by its outcome, not by the request: a card that
// ended in ERROR must not still read as a pending action.
func TestResolvedCardCarriesTheOutcomeLevel(t *testing.T) {
	fallback, blocks := ResolvedBlocks(proposal(), LevelError, "*Replaced but not healthy.*")
	body := render(t, blocks)

	if !strings.HasPrefix(fallback, LevelError.Tag()) {
		t.Fatalf("fallback = %q, want it to lead with %s", fallback, LevelError.Tag())
	}
	if !strings.Contains(body, LevelError.Tag()) {
		t.Fatal("the resolved header must carry the outcome level")
	}
	if strings.Contains(body, LevelAction.Tag()) {
		t.Fatal("a resolved card must not still read as a pending action")
	}
}
