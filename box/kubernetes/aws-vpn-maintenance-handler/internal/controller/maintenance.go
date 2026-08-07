package controller

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/approval"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/events"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/executor"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/humanize"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/planner"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/promx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/state"
)

// revalidateInterval is how often an outstanding approval request is re-checked against
// the preflight rules, so a card is withdrawn once no click could still succeed.
//
// Not configurable, and deliberately so: it is not a policy anyone should have to pick.
// Too coarse and a stale card outlives its conditions by that much, too fine and it only
// adds AWS reads without changing any outcome. Thirty seconds is finer than the window
// boundary it exists to catch and coarser than any telemetry that moves.
//
// A variable rather than a constant only so tests can shrink it; nothing at runtime
// writes to it.
var revalidateInterval = 30 * time.Second

// pendingRequest is an approval request being waited on, freshly posted or adopted
// from persisted state after a restart.
type pendingRequest struct {
	requestID    string
	connectionID string
	tunnelIP     string
	proposal     slackx.Proposal
	refs         []slackx.MessageRef
	// timeout is what is left of the approval window, shorter for an adopted one.
	timeout time.Duration
}

// runMaintenance posts an approval card for a fresh candidate.
func (c *Controller) runMaintenance(ctx context.Context, cand planner.Candidate, assessment promx.Assessment) {
	log := c.logger.With(
		"vpn_connection_id", cand.Connection.ID,
		"tunnel_ip", cand.Tunnel.OutsideIP,
		"request_id", cand.RequestID,
	)

	proposal := c.proposal(cand)
	proposal.TrafficChecked = assessment.Evaluated
	proposal.TrafficDetail = assessment.Detail
	fallback, blocks := slackx.ApprovalBlocks(proposal)
	refs := c.slack.Broadcast(ctx, c.dmChannels, fallback, blocks)
	if len(refs) == 0 {
		// No reachable approver means no authorization path, so drop and retry.
		log.Error("could not deliver the approval request to any approver; skipping this candidate")
		c.metrics.ObserveReconcileError("approval_delivery")
		return
	}

	if err := c.store.AddApproval(ctx, state.Approval{
		RequestID: cand.RequestID,
		PostedAt:  time.Now().UTC(),
		Thread:    refs,
	}); err != nil {
		log.Error("failed to persist the outstanding approval request", "error", err)
	}
	log.Info("approval request sent", "approvers", len(refs),
		"escalated", cand.Escalate, "deadline_in", cand.DeadlineIn.String())
	c.events.Normal(events.ReasonApprovalRequested,
		"Requested approval to replace tunnel %s of %s (AWS auto-applies in %s)",
		cand.Tunnel.OutsideIP, cand.Connection.Label(), cand.DeadlineIn.Round(time.Minute))

	c.awaitDecision(ctx, pendingRequest{
		requestID:    cand.RequestID,
		connectionID: cand.Connection.ID,
		tunnelIP:     cand.Tunnel.OutsideIP,
		proposal:     proposal,
		refs:         refs,
		timeout:      c.cfg.Approval.Timeout.D(),
	}, log)
}

// awaitDecision blocks on the approver's answer and acts on it.
//
// The wait is not only a timeout. Preconditions lapse while a card sits in front of an
// approver, most often the window running out of room to still start and verify a
// replacement, and a click after that reaches the re-check in execute and aborts. The
// approver is then looking at a button that did nothing, with no way to tell that from a
// slow controller. So the loop re-applies the preflight rules and withdraws the card
// once no click could succeed any more, which makes a live button mean what it says.
//
// One Watch registration covers the whole loop. Re-checking cannot be expressed as
// repeated short Waits, because a click arriving between two of them would be dropped
// as no longer outstanding.
func (c *Controller) awaitDecision(ctx context.Context, req pendingRequest, log *slog.Logger) {
	reporter := c.reporter(req.refs, req.proposal.Target(), log)

	decisions, release := c.broker.Watch(req.requestID)
	defer release()

	deadline := time.Now().Add(req.timeout)
	timer := time.NewTimer(req.timeout)
	defer timer.Stop()

	revalidate := time.NewTicker(revalidateInterval)
	defer revalidate.Stop()

	for {
		select {
		case decision := <-decisions:
			c.applyDecision(ctx, req, decision, reporter, log)
			return
		case <-timer.C:
			c.resolveWithoutReplacing(ctx, req, "timeout", log, slackx.LevelWarn,
				fmt.Sprintf("*Expired.* Nobody responded within %s. The tunnel was left alone and will be proposed again in a later window.",
					c.cfg.Approval.Timeout))
			c.events.Warning(events.ReasonApprovalTimeout,
				"Approval to replace tunnel %s of %s expired after %s",
				req.tunnelIP, req.connectionID, c.cfg.Approval.Timeout)
			return
		case <-revalidate.C:
			detail, expired := c.expiryReason(ctx, req, deadline)
			if !expired {
				continue
			}
			// A re-check takes several AWS calls, and a click during it has already been
			// accepted by the broker and buffered. It was made against a card that was
			// still live, so it wins over an expiry decided in the same moment; dropping
			// it would tell the approver their click never happened.
			select {
			case decision := <-decisions:
				c.applyDecision(ctx, req, decision, reporter, log)
				return
			default:
			}
			log.Info("approval request can no longer succeed; withdrawing the card", "detail", detail)
			c.resolveWithoutReplacing(ctx, req, "expired", log, slackx.LevelWarn,
				fmt.Sprintf("*Expired.* %s. The tunnel was left alone and will be proposed again in a later window.", detail))
			c.events.Warning(events.ReasonApprovalExpired,
				"Approval to replace tunnel %s of %s expired before it could be answered: %s",
				req.tunnelIP, req.connectionID, detail)
			return
		case <-ctx.Done():
			// Shutdown or lost leadership. The record stays so the next leader adopts
			// the same card instead of posting a duplicate.
			log.Info("stopped waiting for approval", "reason", ctx.Err())
			c.metrics.ObserveApproval("aborted")
			return
		}
	}
}

// applyDecision acts on an answered request.
func (c *Controller) applyDecision(ctx context.Context, req pendingRequest, decision approval.Decision, reporter *threadReporter, log *slog.Logger) {
	if !decision.Approved {
		c.resolveWithoutReplacing(ctx, req, "denied", log, slackx.LevelWarn,
			fmt.Sprintf("*Denied* by <@%s>. The tunnel was left alone.", decision.UserID))
		c.events.Normal(events.ReasonDenied, "Replacement of tunnel %s of %s denied by %s",
			req.tunnelIP, req.connectionID, decision.UserName)
		return
	}

	c.metrics.ObserveApproval("approved")
	log.Info("replacement approved", "approver_user_id", decision.UserID, "approver", decision.UserName)
	// The run starts here, at the size the card announced. execute corrects the count
	// if the re-check finds the connection's queue has changed since.
	reporter.progress.start(len(req.proposal.Queue) + 1)
	// The clock starts with the approval rather than with the first AWS call, because
	// that is the moment the approver has been waiting from. Deferred here because
	// every way a run can end, finished or abandoned, returns through this call.
	defer c.reportRun(ctx, reporter)

	reporter.Info(ctx, fmt.Sprintf(
		"Approved by <@%s>. Re-checking safety conditions before touching anything.", decision.UserID))
	c.events.Normal(events.ReasonApproved, "Replacement of tunnel %s of %s approved by %s",
		req.tunnelIP, req.connectionID, decision.UserName)

	c.execute(ctx, req, decision.UserID, reporter, log)
}

// reportRun posts the closing report of a run that replaced something, naming what the
// whole approval achieved and how long it took end to end.
func (c *Controller) reportRun(ctx context.Context, reporter *threadReporter) {
	p := reporter.progress
	level, summary, ok := p.report(time.Since(p.startedAt))
	if !ok {
		return
	}
	switch level {
	case slackx.LevelSuccess:
		reporter.Success(ctx, summary)
	default:
		reporter.Warn(ctx, summary)
	}
}

// expiryReason reports why an outstanding request could no longer be acted on, or false
// to keep waiting. deadline is when the request expires on its own. The reason is a
// clause the caller punctuates, matching how the planner phrases a blocked candidate.
//
// Three outcomes, because a failed re-check is not one thing. A read that failed says
// nothing about the tunnel and must not cost anyone their card. A block that cannot
// clear ends the request immediately. A block that can clear ends it only once clearing
// would come too late to be followed by a verified replacement, which is the honest test
// of whether a click could still succeed rather than a guess at how long to be patient.
func (c *Controller) expiryReason(ctx context.Context, req pendingRequest, deadline time.Time) (string, bool) {
	cand, reason, detail, ok := c.recheckTunnel(ctx, req.connectionID, req.tunnelIP)

	// The window is the tighter of the two deadlines whenever the card went up late in
	// it, so the budget is the smaller remainder rather than whichever one was configured.
	now := time.Now()
	budget := min(deadline.Sub(now), c.window.StartBudget(now))

	if !ok {
		if reason == "" {
			// The connection, its telemetry, or the state could not be read. That is
			// our failure, not a changed condition, and it clears on the next tick.
			return "", false
		}
		if !waitable(reason) {
			return detail, true
		}
		if budget >= c.recoveryNeed(reason) {
			return "", false
		}
		return outOfTime(detail), true
	}

	// Every preflight rule passes, so traffic is the only thing left that could still
	// stand in the way. It cannot decide anything until the budget is down to the
	// verification a replacement would need, so the metric source is not queried before
	// then: it would be a range query every tick that no outcome depends on.
	if budget >= c.cfg.Safety.VerifyTimeout.D() {
		return "", false
	}
	assessment := c.traffic.Evaluate(ctx, c.trafficVars(cand))
	// HasHistory separates a measured verdict from an onError one. Metrics that cannot
	// be read say nothing about the tunnel, and an outage of the monitoring stack must
	// not quietly consume approvals that were never given a chance.
	if assessment.Allowed || !assessment.HasHistory {
		return "", false
	}
	return outOfTime(assessment.Detail), true
}

// outOfTime phrases a block that could still clear but no longer soon enough.
func outOfTime(detail string) string {
	return fmt.Sprintf("%s, and too little time is left for that to clear and the replacement "+
		"still be verified", detail)
}

// recoveryNeed is how long a clearable block still needs after it clears.
//
// A peer that comes back has to hold up for peerMinStableFor before the tunnel is a
// candidate again, and the replacement then needs verifyTimeout to be verified. Traffic
// falling quiet costs no settling time, only the verification. Comparing that against
// the budget left is what decides whether waiting is still worth anything.
func (c *Controller) recoveryNeed(reason planner.Reason) time.Duration {
	switch reason {
	case planner.ReasonPeerDown, planner.ReasonPeerUnstable, planner.ReasonPeerNoRoutes:
		return c.cfg.Safety.PeerMinStableFor.D() + c.cfg.Safety.VerifyTimeout.D()
	default:
		return c.cfg.Safety.VerifyTimeout.D()
	}
}

// execute re-validates the preflight rules and then replaces. Re-validation is not
// redundant: an approval can arrive an hour after the card was posted, and the peer
// tunnel may have dropped, started flapping, or lost its routes since.
func (c *Controller) execute(ctx context.Context, req pendingRequest, approverID string, reporter *threadReporter, log *slog.Logger) {
	fresh, _, detail, ok := c.recheck(ctx, req.connectionID, req.requestID)
	if !ok {
		log.Warn("preflight re-check failed after approval; not replacing", "detail", detail)
		c.metrics.ObserveReconcileError("recheck")
		reporter.Warn(ctx, fmt.Sprintf("*Not replacing.* Conditions changed between approval and execution.\n> %s\n"+
			"Nothing was touched. The tunnel will be proposed again once it is safe.", detail))
		c.resolveWithoutReplacing(ctx, req, "aborted", log, slackx.LevelWarn, "Aborted before any change. "+detail)
		c.events.Warning(events.ReasonHeldBack,
			"Aborted approved replacement of tunnel %s of %s after re-check: %s",
			req.tunnelIP, req.connectionID, detail)
		return
	}

	// Traffic is re-measured too. It was quiet when the card was posted, but an
	// approval can arrive an hour later, by which time a batch job may have started.
	assessment := c.traffic.Evaluate(ctx, c.trafficVars(fresh))
	if assessment.Evaluated {
		c.metrics.ObserveTrafficGate(assessment.Allowed, assessment.Ratio, assessment.Rank, assessment.HasHistory)
	}
	if !assessment.Allowed {
		log.Warn("traffic gate closed between approval and execution; not replacing", "detail", assessment.Detail)
		c.metrics.ObserveBlocked(string(planner.ReasonTrafficHigh))
		reporter.Warn(ctx, fmt.Sprintf("*Not replacing.* The tunnel is no longer quiet.\n> %s\n"+
			"Nothing was touched. It will be proposed again once traffic drops.", assessment.Detail))
		c.resolveWithoutReplacing(ctx, req, "aborted", log, slackx.LevelWarn, "Aborted before any change. "+assessment.Detail)
		c.events.Warning(events.ReasonHeldBack,
			"Aborted approved replacement of tunnel %s of %s: traffic gate closed (%s)",
			req.tunnelIP, req.connectionID, assessment.Detail)
		return
	}

	// The queue is re-derived from fresh telemetry, so AWS may have queued or applied
	// maintenance since the card went up. Sizing the run from what is true now is what
	// keeps the percentage honest for the rest of the thread.
	reporter.progress.start(len(fresh.Queue) + 1)

	if len(fresh.Queue) > 0 {
		reporter.Info(ctx, fmt.Sprintf(
			"This approval covers %d tunnel(s) of %s, replaced one at a time in this order.\n%s",
			len(fresh.Queue)+1, fresh.Connection.Label(),
			chainOrder(fresh.Tunnel.OutsideIP, fresh.Queue)))
	}
	c.runChain(ctx, req, fresh, approverID, reporter, log)
}

// runChain replaces each tunnel of the connection in turn under the one approval.
//
// Never two at once: the next tunnel waits until the previous one is a peer good enough
// to fail over to, which is the same peer check a fresh proposal has to pass. Anything
// that would make the next step unsafe, including the window closing or the peer not
// recovering, stops the chain and leaves the rest for a later window. Stopping is always
// safe; continuing on stale facts is not.
//
// Traffic is the one condition that does not stop a chain in progress: see
// awaitChainReady. It still stops the first tunnel, in execute, where nothing has been
// replaced yet and deferring costs nothing.
func (c *Controller) runChain(ctx context.Context, req pendingRequest, first planner.Candidate, approverID string, reporter *threadReporter, log *slog.Logger) {
	total := len(first.Queue) + 1
	c.announceStep(ctx, reporter, 1, total, first.Tunnel.OutsideIP)

	result, ok := c.replaceOne(ctx, req, first, first.Queue, approverID, 0, reporter, log)
	if !ok {
		return
	}
	reporter.progress.record(0, result.Outcome.Healthy())
	c.completeRun(ctx, first.Connection, first.Tunnel.OutsideIP, result, req.refs, c.proposal(first),
		c.waitingRecord(req, first.Connection, first.Tunnel.OutsideIP, first.Queue, approverID, 1, reporter.progress),
		reporter.progress, log)

	if !result.Outcome.Healthy() {
		c.stopChain(ctx, first.Queue, reporter)
		return
	}
	c.continueChain(ctx, req, first.Connection, first.Queue, approverID, reporter, total, 1, log)
}

// waitingRecord describes the gap between two tunnels of one approved run: nothing is
// in flight at AWS, but the run is not over. Nil when this was the last tunnel.
//
// The tunnel just replaced becomes the peer of the next one, which is the whole reason
// the next step has to wait for it to be healthy.
func (c *Controller) waitingRecord(req pendingRequest, conn awsx.Connection, replaced string, queue []string, approverID string, done int, p *progress) *state.InFlight {
	if len(queue) == 0 {
		return nil
	}
	return &state.InFlight{
		RequestID:    req.requestID,
		ConnectionID: conn.ID,
		TunnelIP:     queue[0],
		PeerIP:       replaced,
		Phase:        state.PhaseWaiting,
		StartedAt:    time.Now().UTC(),
		RunStartedAt: p.startedAt.UTC(),
		ApprovedBy:   approverID,
		Thread:       req.refs,
		Queue:        queue[1:],
		Done:         done,
	}
}

// continueChain works through the connection's remaining tunnels. It is shared with the
// restart path, so a chain interrupted by a rollout finishes the same way it would have.
// total and step number the steps for the thread. On the restart path the earlier
// steps happened in a previous process, so total is the remaining count and the
// numbering restarts, which is honest about what this process knows.
func (c *Controller) continueChain(ctx context.Context, req pendingRequest, conn awsx.Connection, queue []string, approverID string, reporter *threadReporter, total, done int, log *slog.Logger) {
	for len(queue) > 0 {
		next, remaining := queue[0], queue[1:]
		stepLog := log.With("tunnel_ip", next)

		reporter.progress.at(done, phaseChecking)
		cand, detail, ok := c.awaitChainReady(ctx, conn.ID, next, reporter, stepLog)
		if !ok {
			reporter.Warn(ctx, fmt.Sprintf(
				"Stopping before tunnel `%s`:\n> %s\nNothing further was touched; it will be proposed again in a later window.",
				next, detail))
			c.events.Warning(events.ReasonHeldBack,
				"Stopped the chain before tunnel %s of %s: %s", next, conn.Label(), detail)
			// The waiting record only means "this run is not over". Leaving it behind
			// would block every other connection and make the next leader resume a
			// run that already gave up.
			c.dropWaiting(ctx, stepLog)
			return
		}

		c.announceStep(ctx, reporter, done+1, total, next)

		result, ok := c.replaceOne(ctx, req, cand, remaining, approverID, done, reporter, stepLog)
		if !ok {
			c.dropWaiting(ctx, stepLog)
			return
		}
		reporter.progress.record(done, result.Outcome.Healthy())
		c.completeRun(ctx, cand.Connection, cand.Tunnel.OutsideIP, result, req.refs, c.proposal(cand),
			c.waitingRecord(req, cand.Connection, cand.Tunnel.OutsideIP, remaining, approverID, done+1, reporter.progress),
			reporter.progress, stepLog)

		if !result.Outcome.Healthy() {
			c.stopChain(ctx, remaining, reporter)
			return
		}
		queue = remaining
		done++
	}
}

// dropWaiting clears a between-tunnels record for a run that ended early.
func (c *Controller) dropWaiting(ctx context.Context, log *slog.Logger) {
	detached, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := c.store.ClearInFlight(detached); err != nil {
		log.Error("failed to clear the between-tunnels record; the next pass will be blocked until it goes",
			"error", err)
		return
	}
	c.metrics.SetInFlight(false)
}

// announceStep marks where in the announced order the thread currently is, so a reply
// read on its own says which tunnel of which step it belongs to. A single-tunnel
// approval gets no banner: numbering one step reads as noise.
func (c *Controller) announceStep(ctx context.Context, reporter *threadReporter, step, total int, tunnelIP string) {
	if total < 2 {
		return
	}
	reporter.Info(ctx, fmt.Sprintf("*Step %d of %d.* Tunnel `%s` is next.", step, total, tunnelIP))
}

// chainOrder renders the replacement order as a numbered list, matching the one on the
// approval card.
func chainOrder(first string, queue []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "1. `%s`\n", first)
	for i, ip := range queue {
		fmt.Fprintf(&b, "%d. `%s`\n", i+2, ip)
	}
	return strings.TrimRight(b.String(), "\n")
}

// stopChain reports the tunnels left untouched after a step that did not end healthy.
func (c *Controller) stopChain(ctx context.Context, remaining []string, reporter *threadReporter) {
	if len(remaining) == 0 {
		return
	}
	reporter.Warn(ctx, fmt.Sprintf(
		"Stopping here: %d tunnel(s) of this connection still have maintenance pending, but the last "+
			"replacement did not end healthy. They will be proposed again once the connection is healthy.",
		len(remaining)))
}

// resumeInFlight picks up a replacement interrupted by a restart or leadership
// handover, before any new discovery.
func (c *Controller) resumeInFlight(ctx context.Context) {
	snap, err := c.store.Load(ctx)
	if err != nil {
		c.logger.Error("failed to load persisted state on startup", "error", err)
		return
	}
	if snap.InFlight == nil {
		c.adoptApprovals(ctx, snap)
		return
	}

	f := *snap.InFlight
	log := c.logger.With("vpn_connection_id", f.ConnectionID, "tunnel_ip", f.TunnelIP, "request_id", f.RequestID)
	// Total and step survive the restart, so the thread keeps counting where it left
	// off instead of starting a second "Step 1 of ...".
	total := f.Done + 1 + len(f.Queue)
	log.Warn("found an interrupted approved run; picking it up",
		"phase", string(f.Phase), "started_at", f.StartedAt.Format(time.RFC3339),
		"elapsed", humanize.Elapsed(time.Since(f.StartedAt)),
		"approved_by", f.ApprovedBy, "done", f.Done, "queued", len(f.Queue))

	conn, err := c.aws.Describe(ctx, f.ConnectionID)
	if err != nil {
		c.logger.Error("failed to describe the connection of the interrupted replacement",
			"vpn_connection_id", f.ConnectionID, "error", err)
		c.metrics.ObserveReconcileError("resume_describe")
		return
	}
	if !c.busy.CompareAndSwap(false, true) {
		return
	}
	c.metrics.SetInFlight(true)

	req := pendingRequest{
		requestID:    f.RequestID,
		connectionID: f.ConnectionID,
		tunnelIP:     f.TunnelIP,
		refs:         f.Thread,
		proposal:     c.proposalFromInFlight(conn, f),
	}

	go func() {
		defer c.busy.Store(false)
		reporter := c.reporter(f.Thread, slackx.Label(conn.Name, conn.ID), log)
		// runStart falls back to this tunnel's own start for a record written before
		// the run clock existed, which is the closest true answer available and still
		// earlier than this process.
		runStart := f.RunStartedAt
		if runStart.IsZero() {
			runStart = f.StartedAt
		}
		defer c.reportRun(ctx, reporter)

		// Nothing was in flight at AWS: the run was between tunnels, waiting for the
		// one just replaced to become a peer worth failing over to. Verifying here
		// would watch a tunnel nobody touched.
		if f.Phase == state.PhaseWaiting {
			remaining := append([]string{f.TunnelIP}, f.Queue...)
			// The tunnels finished before the restart still count: the approver was
			// told about one run, and it is still that run's percentage.
			reporter.progress.resume(total, f.Done, phaseChecking, runStart)
			reporter.Info(ctx, fmt.Sprintf(
				"Picking the approved run back up after a restart. %d of %d tunnel(s) are done, and the "+
					"rest follow in this order.\n%s",
				f.Done, total, chainOrder(remaining[0], remaining[1:])))
			c.continueChain(ctx, req, conn, remaining, f.ApprovedBy, reporter, total, f.Done, log)
			return
		}

		// The AWS call already happened, so this process picks the run up in the
		// verifying phase rather than at the start of the tunnel.
		reporter.progress.resume(total, f.Done, phaseVerifying, runStart)
		result := c.exec.Run(ctx, executor.Request{
			Connection: conn,
			TunnelIP:   f.TunnelIP,
			PeerIP:     f.PeerIP,
			DryRun:     c.cfg.DryRun,
			Resuming:   true,
			// The replacement began in the previous process, so its duration counts
			// from there rather than from this pod's start.
			StartedAt: f.StartedAt,
			// A record still in the requested phase means nobody ever saw AWS accept
			// the call, so a tunnel that never moves is as likely to mean it never
			// started as it is to mean it is stuck.
			AcceptanceUnknown: f.Phase == state.PhaseRequested,
		}, reporter)
		reporter.progress.record(f.Done, result.Outcome.Healthy())
		c.completeRun(ctx, conn, f.TunnelIP, result, f.Thread, req.proposal,
			c.waitingRecord(req, conn, f.TunnelIP, f.Queue, f.ApprovedBy, f.Done+1, reporter.progress),
			reporter.progress, log)

		// The approval covered the whole connection, so a restart mid-chain has to
		// finish it. Without this the connection would be left with one tunnel
		// replaced and one not, waiting on an approval that was already given.
		if len(f.Queue) == 0 || !result.Outcome.Healthy() {
			c.stopChain(ctx, f.Queue, reporter)
			return
		}
		reporter.Info(ctx, fmt.Sprintf(
			"Continuing the approved run. %d of %d tunnel(s) are done, and the rest follow in this order.\n%s",
			f.Done+1, total, chainOrder(f.Queue[0], f.Queue[1:])))
		c.continueChain(ctx, req, conn, f.Queue, f.ApprovedBy, reporter, total, f.Done+1, log)
	}()
}

// adoptApprovals takes over a request still outstanding when the previous leader
// stopped. The existing card is still clickable, so re-posting would leave two in
// the DM with only one of them wired up.
func (c *Controller) adoptApprovals(ctx context.Context, snap state.Snapshot) {
	for id, rec := range snap.Approvals {
		log := c.logger.With("request_id", id)

		remaining := c.cfg.Approval.Timeout.D() - time.Since(rec.PostedAt)
		connectionID, tunnelIP, ok := planner.SplitRequestID(id)
		if !ok || remaining <= 0 || len(rec.Thread) == 0 {
			log.Info("dropping a stale recorded approval request",
				"remaining", remaining.String(), "parsable", ok, "threads", len(rec.Thread))
			if err := c.store.RemoveApproval(ctx, id); err != nil {
				log.Error("failed to drop the stale approval request", "error", err)
			}
			continue
		}
		if !c.busy.CompareAndSwap(false, true) {
			return
		}

		log.Info("adopting an outstanding approval request from persisted state",
			"vpn_connection_id", connectionID, "tunnel_ip", tunnelIP, "remaining", remaining.String())
		req := pendingRequest{
			requestID:    id,
			connectionID: connectionID,
			tunnelIP:     tunnelIP,
			refs:         rec.Thread,
			timeout:      remaining,
			proposal: slackx.Proposal{
				RequestID:      id,
				ConnectionID:   connectionID,
				TunnelIP:       tunnelIP,
				Region:         c.cfg.Region,
				DryRun:         c.cfg.DryRun,
				ApprovalExpiry: remaining,
				Window:         c.window.String(),
			},
		}
		go func() {
			defer c.busy.Store(false)
			c.awaitDecision(ctx, req, log)
		}()
		// One at a time: a decision leads straight into the single replacement slot.
		return
	}
}

// completeRun records the outcome of one step, clears the in-flight record, and closes
// the card.
//
// An aborted run is the one case the record is kept: the replacement really happened
// and is still unverified, so the next leader must resume it rather than find a clean
// slate.
func (c *Controller) completeRun(ctx context.Context, conn awsx.Connection, tunnelIP string, result executor.Result, refs []slackx.MessageRef, proposal slackx.Proposal, next *state.InFlight, p *progress, log *slog.Logger) {
	c.metrics.ObserveReplacement(string(result.Outcome), result.Duration, result.PeerDropped)

	if result.Outcome == executor.OutcomeAborted {
		log.Warn("replacement left in-flight for the next leader to verify",
			"elapsed", humanize.Elapsed(result.Duration), "elapsed_seconds", result.Duration.Seconds())
		return
	}

	// Detached: the run may be ending because ctx was cancelled, and the outcome
	// still has to reach the ConfigMap and Slack.
	finishCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()

	// A healthy tunnel with more to come hands the record straight to the next step
	// rather than clearing it: the run continues, and a restart in the wait between
	// tunnels has to find that out from somewhere.
	if next != nil && result.Outcome.Healthy() {
		if err := c.store.AdvanceChain(finishCtx, conn.ID, tunnelIP, string(result.Outcome), time.Now(), *next); err != nil {
			log.Error("failed to record the next tunnel of the approved run", "error", err)
		}
	} else {
		if err := c.store.FinishInFlight(finishCtx, conn.ID, tunnelIP, string(result.Outcome), time.Now()); err != nil {
			log.Error("failed to clear in-flight state", "error", err)
		}
		c.metrics.SetInFlight(false)
	}

	if result.PeerDropped {
		c.events.Warning(events.ReasonPeerLost,
			"Peer tunnel dropped while replacing tunnel %s of %s; the connection had no healthy path",
			tunnelIP, conn.Label())
	}
	// took is logged twice: once for a human reading the line, once as a number so it
	// can be compared across runs without parsing the rendered form.
	took := humanize.Elapsed(result.Duration)
	if result.Outcome.Healthy() {
		log.Info("replacement finished", "outcome", string(result.Outcome),
			"took", took, "took_seconds", result.Duration.Seconds())
		c.events.Normal(events.ReasonReplaced, "Tunnel %s of %s: %s (%s) after %s",
			tunnelIP, conn.Label(), result.Outcome, result.Detail, took)
	} else {
		log.Error("replacement finished badly", "outcome", string(result.Outcome), "detail", result.Detail,
			"took", took, "took_seconds", result.Duration.Seconds())
		c.events.Warning(events.ReasonReplaceFailed, "Tunnel %s of %s: %s (%s) after %s",
			tunnelIP, conn.Label(), result.Outcome, result.Detail, took)
	}

	level, summary := outcomeSummary(result)
	c.closeCard(finishCtx, proposal, refs, level, withProgress(summary, p))
}

// closeCard posts the closing line and rewrites the card without its buttons. Both
// carry the outcome's level, so the resolved card no longer reads as a pending
// action even when it is found weeks later.
func (c *Controller) closeCard(ctx context.Context, proposal slackx.Proposal, refs []slackx.MessageRef, level slackx.Level, summary string) {
	c.slack.Reply(ctx, refs, slackx.Notice{
		Level:  level,
		Target: slackx.Label(proposal.ConnectionName, proposal.ConnectionID),
		Text:   summary,
	})
	fallback, blocks := slackx.ResolvedBlocks(proposal, level, summary)
	c.slack.Update(ctx, refs, fallback, blocks)
}

// abandonRequest closes a card nothing is waiting on any more.
//
// The approver already clicked, so the broker has stopped listening: leaving the
// buttons in place would produce a card that looks live and silently does nothing
// when pressed, and the operator would have no way to tell that from a slow
// controller. Dropping the persisted record too keeps a restart from adopting a
// request whose decision has already been consumed.
//
// Separate from resolveWithoutReplacing because the approval itself was answered.
// Counting it again as an approval outcome would double-count the decision.
func (c *Controller) abandonRequest(ctx context.Context, req pendingRequest, log *slog.Logger) {
	detached, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()

	c.closeCard(detached, req.proposal, req.refs, slackx.LevelError,
		"*Closed without replacing anything.* The controller could not record what it was about to do. "+
			"The tunnel is proposed again in a later window.")
	if err := c.store.RemoveApproval(detached, req.requestID); err != nil {
		log.Error("failed to drop the recorded approval request", "error", err)
	}
}

// resolveWithoutReplacing closes a request that never reached the AWS call.
func (c *Controller) resolveWithoutReplacing(ctx context.Context, req pendingRequest, decision string, log *slog.Logger, level slackx.Level, summary string) {
	c.metrics.ObserveApproval(decision)
	log.Info("approval request resolved without replacing", "decision", decision)

	detached, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	c.closeCard(detached, req.proposal, req.refs, level, summary)
	if err := c.store.RemoveApproval(detached, req.requestID); err != nil {
		log.Error("failed to drop the recorded approval request", "error", err)
	}
}

// replaceOne performs a single step of the chain: record it, call AWS, verify.
//
// The in-flight record is written before the AWS call and carries the rest of the queue,
// so a crash leaves both facts visible: a replacement may have started, and the
// connection is only part-way done.
func (c *Controller) replaceOne(ctx context.Context, req pendingRequest, step planner.Candidate, queue []string, approverID string, done int, reporter *threadReporter, log *slog.Logger) (executor.Result, bool) {
	reporter.progress.at(done, phaseReplacing)
	if err := c.store.SetInFlight(ctx, state.InFlight{
		RequestID:    step.RequestID,
		ConnectionID: step.Connection.ID,
		TunnelIP:     step.Tunnel.OutsideIP,
		PeerIP:       step.Peer.OutsideIP,
		Phase:        state.PhaseRequested,
		StartedAt:    time.Now().UTC(),
		RunStartedAt: reporter.progress.startedAt.UTC(),
		ApprovedBy:   approverID,
		Thread:       req.refs,
		Queue:        queue,
		Done:         done,
	}); err != nil {
		log.Error("failed to persist in-flight state; refusing to replace", "error", err)
		c.metrics.ObserveReconcileError("persist_in_flight")
		reporter.Error(ctx, fmt.Sprintf("*Not replacing tunnel `%s`.* Could not record the in-flight state in the "+
			"ConfigMap, and a replacement that cannot be tracked must not be started. Nothing was touched. "+
			"This request is closed rather than left clickable, because nothing is waiting on it any more; "+
			"the tunnel is proposed again in a later window.\n```%s```", step.Tunnel.OutsideIP, err))
		c.abandonRequest(ctx, req, log)
		c.events.Warning(events.ReasonHeldBack,
			"Refused to replace tunnel %s of %s: the in-flight state could not be recorded (%s)",
			step.Tunnel.OutsideIP, step.Connection.Label(), err)
		return executor.Result{}, false
	}
	c.metrics.SetInFlight(true)
	c.events.Normal(events.ReasonReplacing, "Replacing tunnel %s of %s (approved by %s, dry_run=%t)",
		step.Tunnel.OutsideIP, step.Connection.Label(), approverID, c.cfg.DryRun)

	return c.exec.Run(ctx, executor.Request{
		Connection: step.Connection,
		TunnelIP:   step.Tunnel.OutsideIP,
		PeerIP:     step.Peer.OutsideIP,
		DryRun:     c.cfg.DryRun,
		// Recorded only once AWS has answered that it accepted the call. Advancing
		// the phase before that would erase the one distinction the phase exists to
		// keep: a restart could no longer tell a replacement that is definitely
		// under way from one whose call may never have landed.
		OnAccepted: func(ctx context.Context) {
			reporter.progress.at(done, phaseVerifying)
			if err := c.store.SetPhase(ctx, state.PhaseVerifying); err != nil {
				log.Warn("failed to record the verifying phase", "error", err)
			}
		},
	}, reporter), true
}

// awaitChainReady waits until the next tunnel of the connection passes every preflight
// check, including the peer check against the tunnel that was just replaced.
//
// Waiting rather than failing immediately is the point: right after a replacement the
// previous tunnel is UP but too young to be trusted, and that resolves on its own within
// peerMinStableFor. Everything else it waits on can also resolve, so the same loop
// covers a busy moment or routes still converging. It gives up when the wait could no
// longer be followed by a verified replacement inside the window.
//
// Traffic is measured but does not gate a chained step. Once the first tunnel of a
// connection has been replaced, the second is finished under the same approval: leaving
// a connection half-replaced means a second maintenance window, a second approval, and a
// second failover for the same work. Continuity is not a downtime risk here because the
// peer check above already proves the freshly replaced tunnel can carry traffic, which is
// what makes the step non-disruptive. The measurement is still taken for metrics and
// announced in the thread when it is elevated, so an operator sees what the run went
// ahead through.
func (c *Controller) awaitChainReady(ctx context.Context, connectionID, tunnelIP string, reporter *threadReporter, log *slog.Logger) (planner.Candidate, string, bool) {
	deadline := time.Now().Add(c.cfg.Safety.PeerMinStableFor.D() + c.cfg.Safety.VerifyTimeout.D())
	ticker := time.NewTicker(c.cfg.Safety.VerifyPollInterval.D())
	defer ticker.Stop()

	announced := false
	var detail string
	for {
		cand, reason, why, ok := c.recheckTunnel(ctx, connectionID, tunnelIP)
		if !ok && !waitable(reason) {
			log.Info("the next tunnel in the chain cannot become ready by waiting",
				"reason", string(reason), "detail", why)
			return planner.Candidate{}, why, false
		}
		if ok {
			c.noteChainTraffic(ctx, cand, reporter, log)
			log.Info("next tunnel in the chain is ready")
			return cand, "", true
		}
		detail = why

		if !announced {
			reporter.Info(ctx, fmt.Sprintf(
				"Waiting before tunnel `%s`: %s", tunnelIP, why))
			announced = true
		}
		log.Info("waiting for the next tunnel in the chain", "detail", why)

		if time.Now().After(deadline) {
			return planner.Candidate{}, detail, false
		}
		select {
		case <-ctx.Done():
			return planner.Candidate{}, "controller is shutting down", false
		case <-ticker.C:
		}
	}
}

// noteChainTraffic measures a chained step's traffic without letting it stop the step.
//
// The metric is still recorded, so the traffic gate's own dashboards do not go blind
// halfway through a connection, and an elevated reading is said out loud in the thread.
// An operator reading the thread later should not have to infer that the second tunnel
// went ahead during a busy moment; it is written down at the moment it happened.
func (c *Controller) noteChainTraffic(ctx context.Context, cand planner.Candidate, reporter *threadReporter, log *slog.Logger) {
	assessment := c.traffic.Evaluate(ctx, c.trafficVars(cand))
	if !assessment.Evaluated {
		return
	}
	c.metrics.ObserveTrafficGate(assessment.Allowed, assessment.Ratio, assessment.Rank, assessment.HasHistory)
	if assessment.Allowed {
		return
	}
	log.Info("continuing the approved run through elevated traffic", "detail", assessment.Detail)
	reporter.Warn(ctx, fmt.Sprintf(
		"Tunnel `%s` is not quiet, but this run already replaced its peer and continues anyway.\n> %s\n"+
			"The peer is UP and stable, so the failover still has a healthy path.",
		cand.Tunnel.OutsideIP, assessment.Detail))
}

// recheck re-reads the connection and re-applies every preflight rule, returning
// the refreshed candidate when the same request is still eligible.
func (c *Controller) recheck(ctx context.Context, connectionID, requestID string) (planner.Candidate, planner.Reason, string, bool) {
	return c.recheckMatching(ctx, connectionID,
		func(cand planner.Candidate) bool { return cand.RequestID == requestID },
		func(b planner.Blocked) bool { return planner.RequestIDMatches(requestID, b.ConnectionID, b.TunnelIP) })
}

// recheckTunnel re-applies every preflight rule to one tunnel by its outside IP.
//
// The chain needs this because a queued tunnel has its own request ID, derived from its
// own maintenance deadline, which the approval never carried.
func (c *Controller) recheckTunnel(ctx context.Context, connectionID, tunnelIP string) (planner.Candidate, planner.Reason, string, bool) {
	return c.recheckMatching(ctx, connectionID,
		func(cand planner.Candidate) bool { return cand.Tunnel.OutsideIP == tunnelIP },
		func(b planner.Blocked) bool { return b.TunnelIP == tunnelIP })
}

// recheckMatching re-reads the connection and re-runs the planner, returning the
// candidate the matcher selects or the reason it was rejected.
// The reason comes back with the detail because the two answer different questions:
// the detail says what is wrong, the reason says whether waiting could fix it. An
// empty reason means the read itself failed, which is transient by nature.
func (c *Controller) recheckMatching(ctx context.Context, connectionID string, wanted func(planner.Candidate) bool, rejected func(planner.Blocked) bool) (planner.Candidate, planner.Reason, string, bool) {
	conn, err := c.aws.Describe(ctx, connectionID)
	if err != nil {
		return planner.Candidate{}, "", "the VPN connection could not be re-read. " + err.Error(), false
	}
	statuses, err := c.aws.Statuses(ctx, conn)
	if err != nil {
		return planner.Candidate{}, "", "tunnel maintenance status could not be re-read. " + err.Error(), false
	}
	snap, err := c.store.Load(ctx)
	if err != nil {
		return planner.Candidate{}, "", "controller state could not be re-read. " + err.Error(), false
	}

	now := time.Now()
	open, windowDetail := c.window.Open(now)
	plan := planner.Evaluate(planner.Input{
		Now:          now,
		Connections:  []awsx.Connection{conn},
		Statuses:     map[string][]awsx.TunnelStatus{conn.ID: statuses},
		WindowOpen:   open,
		WindowDetail: windowDetail,
		// This run holds the single replacement slot, so it must not block itself.
		ReplacementInFlight: false,
		AwaitingApproval:    nil,
		History:             historyFrom(snap),
		Thresholds: planner.Thresholds{
			PeerMinStableFor:      c.cfg.Safety.PeerMinStableFor.D(),
			PeerMinAcceptedRoutes: c.cfg.Safety.PeerMinAcceptedRoutes,
			PerConnectionCooldown: c.cfg.Safety.PerConnectionCooldown.D(),
			EscalateBefore:        c.cfg.Safety.EscalateBefore.D(),
			ChainSiblingTunnel:    c.cfg.Safety.ChainSiblingTunnel,
		},
	})

	for _, cand := range plan.Candidates {
		if wanted(cand) {
			return cand, "", "", true
		}
	}
	for _, b := range plan.Blocked {
		if rejected(b) {
			return planner.Candidate{}, b.Reason, b.Detail, false
		}
	}
	return planner.Candidate{}, planner.ReasonTunnelCount, "the tunnel is no longer reported by this connection", false
}

// waitable reports whether a blocked reason could clear while the chain waits for it.
//
// The waiting loop holds the single replacement slot, so waiting on something that
// cannot resolve, a tunnel with no maintenance queued or a window that closed for the
// night, would idle every other connection for the better part of an hour and then
// give up anyway.
func waitable(reason planner.Reason) bool {
	switch reason {
	case planner.ReasonPeerDown, planner.ReasonPeerUnstable, planner.ReasonPeerNoRoutes,
		planner.ReasonTrafficHigh, "":
		return true
	default:
		return false
	}
}

// reporter binds a Slack thread to the executor's progress interface. target is bound
// here rather than passed per message, so no step can be reported without naming the
// VPN connection it belongs to. The progress counter is bound for the same reason, and
// stays silent until a run actually starts.
func (c *Controller) reporter(refs []slackx.MessageRef, target string, log *slog.Logger) *threadReporter {
	return &threadReporter{client: c.slack, refs: refs, target: target, logger: log, progress: &progress{}}
}

// threadReporter posts each step as a reply under the card that authorized it, so
// the replacement reads as one conversation.
type threadReporter struct {
	client Notifier
	refs   []slackx.MessageRef
	// target is the VPN connection every reply from this reporter is about.
	target string
	// progress is the run this reporter belongs to, advanced by the controller. Every
	// reply carries it, because a thread is read one message at a time and a step named
	// on its own says nothing about how much is left.
	progress *progress
	logger   *slog.Logger
}

// post detaches from ctx on purpose: progress matters most when the controller is
// shutting down, and a cancelled context would drop it. The level reaches both the
// log and the Slack reply, so the two can be read side by side.
func (t *threadReporter) post(ctx context.Context, level slackx.Level, msg string) {
	detached, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()
	t.client.Reply(detached, t.refs, slackx.Notice{
		Level: level, Target: t.target, Text: withProgress(msg, t.progress),
	})
}

func (t *threadReporter) Info(ctx context.Context, msg string) {
	t.logger.Info("replacement progress", "vpn_connection", t.target, "level", string(slackx.LevelInfo), "message", msg)
	t.post(ctx, slackx.LevelInfo, msg)
}

func (t *threadReporter) Success(ctx context.Context, msg string) {
	t.logger.Info("replacement progress", "vpn_connection", t.target, "level", string(slackx.LevelSuccess), "message", msg)
	t.post(ctx, slackx.LevelSuccess, msg)
}

func (t *threadReporter) Warn(ctx context.Context, msg string) {
	t.logger.Warn("replacement alert", "vpn_connection", t.target, "level", string(slackx.LevelWarn), "message", msg)
	t.post(ctx, slackx.LevelWarn, msg)
}

func (t *threadReporter) Error(ctx context.Context, msg string) {
	t.logger.Error("replacement alert", "vpn_connection", t.target, "level", string(slackx.LevelError), "message", msg)
	t.post(ctx, slackx.LevelError, msg)
}

func (t *threadReporter) Critical(ctx context.Context, msg string) {
	t.logger.Error("replacement alert", "vpn_connection", t.target, "level", string(slackx.LevelCritical), "message", msg)
	t.post(ctx, slackx.LevelCritical, msg)
}

// outcomeSummary renders the closing line of a run together with its level. The
// level follows what the outcome demands of a reader: SUCCESS needs nothing, WARN
// means the replacement is done but worth reading, ERROR needs a human while a path
// still exists, and CRITICAL means the connection had none.
// Every branch ends with how long the step took, including the ones that failed: the
// time an unsuccessful replacement burned is what tells an operator whether the window
// still has room for the rest of the connection.
func outcomeSummary(r executor.Result) (slackx.Level, string) {
	took := humanize.Elapsed(r.Duration)
	switch r.Outcome {
	case executor.OutcomeSucceeded:
		s := fmt.Sprintf("*Replaced.* %s in %s.", r.Detail, took)
		if r.PeerDropped {
			return slackx.LevelWarn, s +
				"\nThe peer tunnel also dropped during the replacement, so the connection was briefly without a healthy path. Worth reviewing."
		}
		return slackx.LevelSuccess, s
	case executor.OutcomeDryRun:
		return slackx.LevelSuccess, fmt.Sprintf("*Dry run complete.* %s. Took %s.", r.Detail, took)
	case executor.OutcomeRequestFailed:
		return slackx.LevelError, fmt.Sprintf("*Rejected by AWS after %s.* Nothing was replaced. %s", took, r.Detail)
	case executor.OutcomeVerifyTimeout:
		return slackx.LevelError, fmt.Sprintf("*Replaced but not healthy after %s.* %s. This needs a human because the replacement cannot be undone.", took, r.Detail)
	case executor.OutcomePeerLost:
		return slackx.LevelCritical, fmt.Sprintf("*Both tunnels were down during the replacement.* %s. It ran for %s.", r.Detail, took)
	default:
		return slackx.LevelWarn, fmt.Sprintf("Replacement ended with outcome %s after %s. %s", r.Outcome, took, r.Detail)
	}
}
