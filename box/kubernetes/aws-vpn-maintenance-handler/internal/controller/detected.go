package controller

import (
	"context"
	"sort"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/events"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/planner"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/state"
)

// notifyDetected tells the approvers about queued maintenance that is not being proposed
// right now, once per connection per maintenance cycle.
//
// Without it the metrics are the only place pending maintenance appears until a window
// opens, so the first thing an approver sees is an approval card, possibly days after AWS
// queued the work and hours before its deadline. The notice is deliberately not an
// approval card: it carries no buttons, because the preflight evidence a decision needs
// does not exist while the connection is still blocked.
//
// Delivery is not retried. A notice is a courtesy ahead of the card that actually gates
// the replacement, and a failed one must not hold up the pass; the same connection is
// re-evaluated on the next interval, and the state write below only happens for a notice
// Slack accepted, so a total delivery failure is retried then anyway.
func (c *Controller) notifyDetected(ctx context.Context, plan planner.Plan, snap state.Snapshot, proposing string) {
	groups := c.detections(plan, proposing)
	live := make(map[string]bool, len(groups))
	for _, g := range groups {
		// Every notice ID this pass saw stays live, including the suppressed ones: live
		// is what the prune below keeps, and forgetting a suppressed notice would send
		// it again as soon as the connection went back to being merely blocked.
		live[g.noticeID] = true
		if !g.notify || !snap.Notices[g.noticeID].IsZero() {
			continue
		}

		fallback, blocks := slackx.DetectedBlocks(g.detected)
		refs := c.slack.Broadcast(ctx, c.dmChannels, fallback, blocks)
		if len(refs) == 0 {
			c.logger.Warn("could not deliver the maintenance notice to any approver",
				"vpn_connection_id", g.connectionID, "tunnels", g.tunnelIPs())
			c.metrics.ObserveReconcileError("notice_delivery")
			continue
		}
		if err := c.store.AddNotice(ctx, g.noticeID, time.Now()); err != nil {
			// Recorded but not persisted means it will be sent again next pass. Noisy,
			// not wrong, and better than suppressing a notice that never went out.
			c.logger.Error("failed to persist the maintenance notice", "error", err,
				"notice_id", g.noticeID)
		}
		c.logger.Info("maintenance notice sent", "approvers", len(refs),
			"vpn_connection_id", g.connectionID, "tunnels", g.tunnelIPs(), "reason", g.reason)
		c.metrics.ObserveDetectionNotice(g.reason)
		c.events.Normal(events.ReasonMaintenanceDetected,
			"AWS has queued endpoint maintenance for %s of %s (%s)",
			g.tunnelIPs(), g.detected.Target(), g.reason)
	}

	// Notices outlive the pass that sent them, so something has to drop the ones whose
	// maintenance is done. Only written when there is something stale, since Mutate
	// writes the ConfigMap unconditionally.
	if stale(snap.Notices, live) {
		if err := c.store.PruneNotices(ctx, live); err != nil {
			c.logger.Error("failed to prune finished maintenance notices", "error", err)
		}
	}
}

// detection is one VPN connection's queued maintenance, and whether the approvers should
// hear about it.
type detection struct {
	// noticeID is the identity the notice is remembered under: every covered tunnel's
	// request ID, joined. Scoping it to the whole group is what makes the notice
	// once-per-connection and still re-send when the set of queued tunnels changes,
	// since that is news the first notice did not carry.
	noticeID     string
	connectionID string
	// reason is the machine-readable planner reason of the tunnel AWS takes over first,
	// for logs and the metric label.
	reason string
	// notify is false when the controller is already working on this connection, which
	// needs no notice because the approval card is doing the telling.
	notify   bool
	detected slackx.Detected
}

func (d detection) tunnelIPs() string {
	ips := make([]string, 0, len(d.detected.Tunnels))
	for _, t := range d.detected.Tunnels {
		ips = append(ips, t.IP)
	}
	return strings.Join(ips, ", ")
}

// tunnel pairs one tunnel's display form with the planner facts the grouping needs.
type tunnel struct {
	requestID string
	reason    planner.Reason
	detected  slackx.DetectedTunnel
}

// detections groups every tunnel with maintenance queued by VPN connection: the ones a
// preflight rule held back, the ones lifecycle control rules out entirely, and the
// candidates that were eligible this pass.
//
// Grouped because an approval covers the connection and replaces its tunnels in sequence
// under one card. A notice per tunnel would announce one connection's maintenance twice
// and then be answered by a single card, which reads as a message having gone missing.
//
// Candidates are here because being eligible is not the same as being acted on. One
// replacement runs at a time and the traffic gate can defer all of them, and neither
// verdict shows up in Blocked, since both are reached after the planner has run. They are
// only notified about when nothing was proposed at all, which is the traffic gate holding
// the whole window: a candidate passed over because another tunnel got the pass is
// usually proposed a few minutes later, and a notice then arrives just ahead of the card
// that supersedes it.
//
// proposing is the request ID whose approval card is going out in this pass, or empty.
func (c *Controller) detections(plan planner.Plan, proposing string) []detection {
	now := time.Now()
	escalateBefore := c.cfg.Safety.EscalateBefore.D()

	byConnection := map[string][]tunnel{}
	names := map[string]string{}
	// A connection the controller is already working on is suppressed as a whole: the
	// card that exists covers it, including the tunnels queued behind the one named on
	// the card.
	suppressed := map[string]bool{}

	for _, b := range plan.Held() {
		names[b.ConnectionID] = b.ConnectionName
		if !notifiable(b.Reason) {
			suppressed[b.ConnectionID] = true
		}
		byConnection[b.ConnectionID] = append(byConnection[b.ConnectionID], tunnel{
			requestID: b.RequestID,
			reason:    b.Reason,
			detected: slackx.DetectedTunnel{
				IP:           b.TunnelIP,
				Deadline:     b.Deadline,
				DeadlineIn:   b.DeadlineIn,
				Reason:       b.Detail,
				Escalate:     b.DeadlineIn > 0 && b.DeadlineIn <= escalateBefore,
				Unmanageable: b.Reason == planner.ReasonLifecycleControlDisabled,
			},
		})
	}

	for _, cand := range plan.Candidates {
		names[cand.Connection.ID] = cand.Connection.Name
		if cand.RequestID == proposing {
			suppressed[cand.Connection.ID] = true
		}
		byConnection[cand.Connection.ID] = append(byConnection[cand.Connection.ID], tunnel{
			requestID: cand.RequestID,
			reason:    planner.ReasonTrafficHigh,
			detected: slackx.DetectedTunnel{
				IP:         cand.Tunnel.OutsideIP,
				Deadline:   cand.Maintenance.AutoAppliedAfter,
				DeadlineIn: cand.DeadlineIn,
				Escalate:   cand.Escalate,
				Reason: "every preflight check passes, but the replacement has not started yet: " +
					"replacements run one at a time and the traffic gate waits for the tunnel to be quiet",
			},
		})
	}

	nextWindow := c.nextWindow(now)
	out := make([]detection, 0, len(byConnection))
	for id, tunnels := range byConnection {
		// Sorted so the notice, its ID, and the logs read the same on every pass; map
		// iteration alone would reorder them and make one notice look like two.
		sort.Slice(tunnels, func(i, j int) bool { return tunnels[i].detected.IP < tunnels[j].detected.IP })

		ids := make([]string, 0, len(tunnels))
		shown := make([]slackx.DetectedTunnel, 0, len(tunnels))
		for _, t := range tunnels {
			ids = append(ids, t.requestID)
			shown = append(shown, t.detected)
		}
		noticeID := strings.Join(ids, " ")

		out = append(out, detection{
			noticeID:     noticeID,
			connectionID: id,
			reason:       string(urgentReason(tunnels)),
			notify:       !suppressed[id],
			detected: slackx.Detected{
				NoticeID:       noticeID,
				ConnectionID:   id,
				ConnectionName: names[id],
				Region:         c.cfg.Region,
				Tunnels:        shown,
				NextWindow:     nextWindow,
				Window:         c.window.String(),
			},
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].noticeID < out[j].noticeID })
	return out
}

// urgentReason returns the reason of the tunnel AWS takes over first, which is the one
// worth counting for a notice covering several. An unpublished deadline never wins, since
// it is the least urgent thing a tunnel can have.
func urgentReason(tunnels []tunnel) planner.Reason {
	best := tunnels[0]
	for _, t := range tunnels[1:] {
		if best.detected.Deadline.IsZero() && !t.detected.Deadline.IsZero() {
			best = t
			continue
		}
		if !t.detected.Deadline.IsZero() && t.detected.Deadline.Before(best.detected.Deadline) {
			best = t
		}
	}
	return best.reason
}

// notifiable reports whether a blocked reason is worth a notice.
//
// Two are not. A tunnel awaiting approval already has a card in front of the same people,
// and one held back because a replacement is running is a queueing detail of a window
// that is actively working: both would be a second message about a connection the
// approvers are already looking at, and neither describes maintenance nobody has heard
// about, which is what this notice is for.
func notifiable(r planner.Reason) bool {
	switch r {
	case planner.ReasonAwaitingApproval, planner.ReasonReplacementInFlight:
		return false
	default:
		return true
	}
}

// nextWindow returns the next opening, or the zero time while the window is open, where
// naming a future opening would read as the wait being the schedule's fault.
func (c *Controller) nextWindow(now time.Time) time.Time {
	if open, _ := c.window.Open(now); open {
		return time.Time{}
	}
	return c.window.NextOpen(now)
}

// stale reports whether notices holds an ID the latest pass no longer saw.
func stale(notices map[string]time.Time, live map[string]bool) bool {
	for id := range notices {
		if !live[id] {
			return true
		}
	}
	return false
}
