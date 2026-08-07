package slackx

import (
	"strings"
	"testing"
	"time"
)

func detectedTunnel(ip string) DetectedTunnel {
	return DetectedTunnel{
		IP:         ip,
		Deadline:   time.Date(2026, 8, 1, 3, 0, 0, 0, time.UTC),
		DeadlineIn: 200 * time.Hour,
		Reason:     `outside window: schedule "0 2 * * 2,3,4" (Asia/Seoul) next opens at 2026-07-28 02:00 KST`,
	}
}

// detected is the usual case this notice exists for: both tunnels of one connection have
// maintenance queued and the window is shut.
func detected() Detected {
	return Detected{
		NoticeID:       "vpn-0123456789abcdef0|203.0.113.10|1785000000 vpn-0123456789abcdef0|203.0.113.20|1785000000",
		ConnectionID:   "vpn-0123456789abcdef0",
		ConnectionName: "prod-dc",
		Region:         "ap-northeast-2",
		Tunnels:        []DetectedTunnel{detectedTunnel("203.0.113.10"), detectedTunnel("203.0.113.20")},
		NextWindow:     time.Date(2026, 7, 28, 2, 0, 0, 0, time.UTC),
		Window:         `"0 2 * * 2,3,4" for 3h (Asia/Seoul)`,
	}
}

func TestDetectedBlocksSayWhatIsQueuedAndWhy(t *testing.T) {
	fallback, blocks := DetectedBlocks(detected())
	body := render(t, blocks)

	for _, want := range []string{
		"prod-dc", "vpn-0123456789abcdef0", "ap-northeast-2",
		"203.0.113.10", "203.0.113.20",
		"2026-08-01", "in 8d8h",
		"outside window", "What happens next", "2026-07-28",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("notice is missing %q", want)
		}
	}
	// A phone push shows the fallback alone, so the scope and the deadline are in it.
	for _, want := range []string{"[INFO]", "prod-dc", "2 tunnels", "203.0.113.10", "2026-08-01"} {
		if !strings.Contains(fallback, want) {
			t.Fatalf("fallback %q is missing %q", fallback, want)
		}
	}
}

// One approval covers the connection, so the notice ahead of it has to promise one card
// rather than leaving the reader expecting one per tunnel.
func TestDetectedBlocksPromiseASingleApproval(t *testing.T) {
	_, blocks := DetectedBlocks(detected())
	if body := render(t, blocks); !strings.Contains(body, "One approval request arrives") {
		t.Fatalf("notice must say one approval covers the connection: %s", body)
	}
}

// Tunnels held by the same rule collapse to one explanation. Repeating an identical
// sentence per tunnel is what made two messages feel like two problems.
func TestDetectedBlocksCollapseAnIdenticalReason(t *testing.T) {
	_, blocks := DetectedBlocks(detected())
	body := render(t, blocks)
	if n := strings.Count(body, "outside window"); n != 1 {
		t.Fatalf("one shared reason must print once, got %d occurrences", n)
	}
}

// Different reasons are listed per tunnel, since collapsing them would drop information.
func TestDetectedBlocksListDifferingReasons(t *testing.T) {
	d := detected()
	d.Tunnels[1].Reason = "peer tunnel 203.0.113.10 is DOWN"

	_, blocks := DetectedBlocks(d)
	body := render(t, blocks)
	for _, want := range []string{"outside window", "is DOWN", "203.0.113.20`:"} {
		if !strings.Contains(body, want) {
			t.Fatalf("notice is missing %q: %s", want, body)
		}
	}
}

// Deadlines are per tunnel and can differ, so each is printed with its own.
func TestDetectedBlocksPrintEveryDeadline(t *testing.T) {
	d := detected()
	d.Tunnels[1].Deadline = time.Date(2026, 8, 9, 3, 0, 0, 0, time.UTC)
	d.Tunnels[1].DeadlineIn = 400 * time.Hour

	fallback, blocks := DetectedBlocks(d)
	body := render(t, blocks)
	for _, want := range []string{"2026-08-01", "2026-08-09"} {
		if !strings.Contains(body, want) {
			t.Fatalf("notice is missing deadline %q", want)
		}
	}
	// The fallback has room for one, and the nearest is the one that decides urgency.
	if !strings.Contains(fallback, "2026-08-01") || strings.Contains(fallback, "2026-08-09") {
		t.Fatalf("fallback must carry the nearest deadline only: %q", fallback)
	}
}

// The notice reports; the approval card decides. A button here would ask for a decision
// without the preflight evidence that justifies it.
func TestDetectedBlocksCarryNoButtons(t *testing.T) {
	_, blocks := DetectedBlocks(detected())
	if body := render(t, blocks); strings.Contains(body, ActionApprove) || strings.Contains(body, "actions") {
		t.Fatalf("a detection notice must not be actionable: %s", body)
	}
}

func TestDetectedLevels(t *testing.T) {
	tests := []struct {
		name string
		edit func(*Detected)
		want Level
	}{
		{"a distant deadline is informational", func(*Detected) {}, LevelInfo},
		{"a near deadline on one tunnel is a warning", func(d *Detected) { d.Tunnels[1].Escalate = true }, LevelWarn},
		{"lifecycle control off on one tunnel is a warning", func(d *Detected) { d.Tunnels[0].Unmanageable = true }, LevelWarn},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			d := detected()
			tc.edit(&d)
			if got := d.level(); got != tc.want {
				t.Fatalf("level = %s, want %s", got, tc.want)
			}
			if !strings.Contains(d.title(), tc.want.Tag()) {
				t.Fatalf("title %q does not carry the level", d.title())
			}
		})
	}
}

// Lifecycle control being off is the one case no window resolves, so the notice has to
// name the API call instead of promising an approval request that can never come.
func TestDetectedBlocksExplainAnUnmanageableConnection(t *testing.T) {
	d := detected()
	for i := range d.Tunnels {
		d.Tunnels[i].Unmanageable = true
		d.Tunnels[i].Reason = "tunnel endpoint lifecycle control is disabled"
	}

	fallback, blocks := DetectedBlocks(d)
	body := render(t, blocks)
	for _, want := range []string{
		"cannot be taken over", "ModifyVpnTunnelOptions", "EnableTunnelLifecycleControl",
		// Both tunnels have to be named: enabling it on one fixes half the problem.
		"203.0.113.10", "203.0.113.20",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("notice is missing %q", want)
		}
	}
	if strings.Contains(body, "approval request arrives") {
		t.Fatal("a connection that cannot be managed must not be promised an approval request")
	}
	if !strings.Contains(fallback, "[WARN]") {
		t.Fatalf("fallback %q must carry the level", fallback)
	}
}

// One tunnel out of control is not the whole connection out of control: the other is
// still going to be proposed, so the notice has to say both things.
func TestDetectedBlocksMixManageableAndUnmanageableTunnels(t *testing.T) {
	d := detected()
	d.Tunnels[0].Unmanageable = true
	d.Tunnels[0].Reason = "tunnel endpoint lifecycle control is disabled"

	_, blocks := DetectedBlocks(d)
	body := render(t, blocks)
	if !strings.Contains(body, "Pending VPN tunnel maintenance detected") {
		t.Fatalf("a partly manageable connection keeps the ordinary title: %s", body)
	}
	for _, want := range []string{"approval request arrives", "ModifyVpnTunnelOptions"} {
		if !strings.Contains(body, want) {
			t.Fatalf("notice is missing %q: %s", want, body)
		}
	}
	// Only the tunnel that needs the fix is named in the instruction.
	if strings.Contains(body, "`203.0.113.10` and `203.0.113.20` with") {
		t.Fatal("the fix must name only the unmanageable tunnel")
	}
}

// An unpublished deadline is said plainly rather than rendered as a zero timestamp.
func TestDetectedBlocksWithoutADeadline(t *testing.T) {
	d := detected()
	for i := range d.Tunnels {
		d.Tunnels[i].Deadline, d.Tunnels[i].DeadlineIn = time.Time{}, 0
	}

	fallback, blocks := DetectedBlocks(d)
	body := render(t, blocks)
	if !strings.Contains(body, "no published deadline") {
		t.Fatalf("notice must say the deadline is unpublished: %s", body)
	}
	if !strings.Contains(fallback, "no auto-apply deadline") {
		t.Fatalf("fallback must say the deadline is unpublished: %q", fallback)
	}
	if strings.Contains(body, "0001-01-01") || strings.Contains(fallback, "0001-01-01") {
		t.Fatal("a zero deadline must never be printed as a date")
	}
}

// While the window is open the wait is a preflight rule, so naming a future opening would
// point at the wrong cause.
func TestDetectedBlocksOmitTheNextWindowWhileItIsOpen(t *testing.T) {
	d := detected()
	d.NextWindow = time.Time{}
	for i := range d.Tunnels {
		d.Tunnels[i].Reason = "a tunnel of this connection was replaced 2h ago; cooldown is 24h"
	}

	_, blocks := DetectedBlocks(d)
	body := render(t, blocks)
	if strings.Contains(body, "The window next opens") {
		t.Fatalf("an open window must not advertise its next opening: %s", body)
	}
	if !strings.Contains(body, "cooldown is 24h") {
		t.Fatalf("notice must carry the planner's reason: %s", body)
	}
}

// A single queued tunnel reads as one tunnel, not as a list of one.
func TestDetectedBlocksWithOneTunnel(t *testing.T) {
	d := detected()
	d.Tunnels = d.Tunnels[:1]
	d.NoticeID = "vpn-0123456789abcdef0|203.0.113.10|1785000000"

	fallback, blocks := DetectedBlocks(d)
	if !strings.Contains(fallback, "Tunnel 203.0.113.10") {
		t.Fatalf("fallback %q must name the single tunnel", fallback)
	}
	if body := render(t, blocks); strings.Contains(body, "203.0.113.20") {
		t.Fatalf("a tunnel with nothing queued must not appear: %s", body)
	}
}

// A connection with no Name tag still has to render.
func TestDetectedBlocksWithoutAConnectionName(t *testing.T) {
	d := detected()
	d.ConnectionName = ""

	fallback, blocks := DetectedBlocks(d)
	if body := render(t, blocks); !strings.Contains(body, "vpn-0123456789abcdef0") {
		t.Fatalf("notice must fall back to the connection ID: %s", body)
	}
	if strings.Contains(fallback, "()") {
		t.Fatalf("fallback must not render an empty name: %q", fallback)
	}
}
