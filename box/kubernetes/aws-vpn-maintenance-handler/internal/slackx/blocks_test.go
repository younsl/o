package slackx

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/slack-go/slack"
)

func proposal() Proposal {
	return Proposal{
		RequestID:           "vpn-a|203.0.113.10|1785000000",
		ConnectionID:        "vpn-0123456789abcdef0",
		ConnectionName:      "prod-dc",
		Gateway:             "tgw-abc",
		GatewayName:         "prod-tgw",
		CustomerGatewayID:   "cgw-abc",
		CustomerGatewayName: "idc-router",
		Region:              "ap-northeast-2",
		TunnelIP:            "203.0.113.10",
		PeerIP:              "203.0.113.20",
		PeerRoutes:          12,
		PeerStableFor:       6 * time.Hour,
		DeadlineIn:          200 * time.Hour,
		Deadline:            time.Date(2026, 8, 1, 3, 0, 0, 0, time.UTC),
		ApprovalExpiry:      time.Hour,
		Window:              `"0 2 * * 2,3,4" for 3h (Asia/Seoul)`,
	}
}

// render flattens the blocks to JSON so a test can assert on the whole card without
// walking the Block Kit types.
func render(t *testing.T, blocks []slack.Block) string {
	t.Helper()
	b, err := json.Marshal(blocks)
	if err != nil {
		t.Fatalf("marshal blocks: %v", err)
	}
	return string(b)
}

func TestApprovalBlocksCarryTheDecisionInputs(t *testing.T) {
	fallback, blocks := ApprovalBlocks(proposal())
	body := render(t, blocks)

	// The approver has to be able to judge the risk, not just click.
	for _, want := range []string{
		"prod-dc", "vpn-0123456789abcdef0", "203.0.113.10", "203.0.113.20",
		"ap-northeast-2", "tgw-abc", "cgw-abc",
		"12 BGP route", "stable for 6h",
		"2026-08-01", "cannot be undone",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("card is missing %q", want)
		}
	}
	// The fallback is the whole content of a phone push notification.
	if !strings.Contains(fallback, "203.0.113.10") {
		t.Fatalf("fallback = %q, want it to name the tunnel", fallback)
	}
}

func TestApprovalBlocksCarryBothButtons(t *testing.T) {
	_, blocks := ApprovalBlocks(proposal())
	body := render(t, blocks)

	if !strings.Contains(body, ActionApprove) || !strings.Contains(body, ActionDeny) {
		t.Fatalf("both action IDs must be present: %s", body)
	}
	// The button value is what identifies the request on the way back in.
	if !strings.Contains(body, "vpn-a|203.0.113.10|1785000000") {
		t.Fatal("the request ID must travel as the button value")
	}
	// The confirmation dialog is the guard against a mis-tap on an irreversible call.
	if !strings.Contains(body, "Confirm replacement") {
		t.Fatal("approve must carry a confirmation dialog")
	}
}

func TestApprovalBlocksMarkADryRun(t *testing.T) {
	p := proposal()
	p.DryRun = true
	fallback, blocks := ApprovalBlocks(p)
	body := render(t, blocks)

	if !strings.Contains(fallback, "dry run") {
		t.Fatalf("fallback = %q, want it to say dry run", fallback)
	}
	if !strings.Contains(body, "Dry run is enabled") {
		t.Fatal("a dry run must be stated on the card")
	}
	if strings.Contains(body, "cannot be undone") {
		t.Fatal("a dry run must not carry the irreversible warning")
	}
}

func TestApprovalBlocksEscalate(t *testing.T) {
	p := proposal()
	p.Escalate = true
	p.DeadlineIn = 10 * time.Hour
	fallback, blocks := ApprovalBlocks(p)

	if !strings.Contains(fallback, "URGENT") {
		t.Fatalf("fallback = %q, want it marked urgent", fallback)
	}
	if !strings.Contains(render(t, blocks), string(LevelCritical)) {
		t.Fatal("an escalated card should carry the CRITICAL level")
	}
}

// Without a deadline the choice looks free, so the card has to say what is unknown.
func TestApprovalBlocksHandleAMissingDeadline(t *testing.T) {
	p := proposal()
	p.Deadline = time.Time{}
	p.DeadlineIn = 0

	body := render(t, mustBlocks(t, p))
	if !strings.Contains(body, "has not published an auto-apply deadline") {
		t.Fatalf("card should explain the missing deadline: %s", body)
	}
}

// Route count carries no information on a static-routes-only connection, so claiming
// "0 routes" would read as a failure rather than a non-signal.
func TestApprovalBlocksExplainStaticRoutes(t *testing.T) {
	p := proposal()
	p.StaticRoutes = true
	p.PeerRoutes = 0

	body := render(t, mustBlocks(t, p))
	if !strings.Contains(body, "static-routes-only") {
		t.Fatal("a static-routes-only connection must be called out")
	}
	if strings.Contains(body, "accepting 0 BGP route") {
		t.Fatal("route count must not be presented as a signal here")
	}
}

func TestApprovalBlocksShowTheTrafficVerdict(t *testing.T) {
	p := proposal()
	p.TrafficChecked = true
	p.TrafficDetail = "current traffic 12.30M is 21% of the 58.10M baseline, within the 30% limit"

	body := render(t, mustBlocks(t, p))
	if !strings.Contains(body, "21% of the 58.10M baseline") {
		t.Fatalf("the measured load must reach the approver: %s", body)
	}

	p.TrafficChecked = false
	if strings.Contains(render(t, mustBlocks(t, p)), "Traffic gate") {
		t.Fatal("a disabled gate must not claim to have checked anything")
	}
}

// A resolved card must not be clickable again.
func TestResolvedBlocksDropTheButtons(t *testing.T) {
	fallback, blocks := ResolvedBlocks(proposal(), LevelSuccess, "*Replaced.* tunnel UP with 9 routes in 4m12s.")
	body := render(t, blocks)

	if strings.Contains(body, ActionApprove) || strings.Contains(body, ActionDeny) {
		t.Fatal("the resolved card must carry no buttons")
	}
	if !strings.Contains(body, "Replaced") {
		t.Fatal("the outcome must be on the card")
	}
	if !strings.Contains(fallback, "203.0.113.10") {
		t.Fatalf("fallback = %q", fallback)
	}
}

func TestConnectionLabelFallsBackToTheID(t *testing.T) {
	p := proposal()
	p.ConnectionName = ""
	if got := p.connectionLabel(); !strings.Contains(got, p.ConnectionID) {
		t.Fatalf("connectionLabel = %q, want the raw ID", got)
	}
}

func TestHumanDuration(t *testing.T) {
	for in, want := range map[time.Duration]string{
		0:                "0s",
		-time.Second:     "0s",
		30 * time.Second: "30s",
		90 * time.Second: "2m0s",
		6 * time.Hour:    "6h0m0s",
		48 * time.Hour:   "2d",
		50 * time.Hour:   "2d2h",
		200 * time.Hour:  "8d8h",
	} {
		if got := humanDuration(in); got != want {
			t.Fatalf("humanDuration(%s) = %q, want %q", in, got, want)
		}
	}
}

func mustBlocks(t *testing.T, p Proposal) []slack.Block {
	t.Helper()
	_, blocks := ApprovalBlocks(p)
	return blocks
}
