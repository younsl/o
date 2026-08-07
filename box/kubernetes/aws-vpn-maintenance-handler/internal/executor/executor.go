// Package executor performs an approved tunnel replacement and watches it back to
// health. The AWS call is irreversible, so this package cannot fix a bad outcome;
// it separates "replaced and healthy" from "replaced and still down" and alerts
// immediately if the surviving tunnel drops.
package executor

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/humanize"
)

// Outcome is how a replacement ended. The values appear as a Prometheus metric
// label, so they are stable.
type Outcome string

const (
	// OutcomeSucceeded: the tunnel came back UP and carries routes.
	OutcomeSucceeded Outcome = "succeeded"
	// OutcomeDryRun: AWS accepted a dry-run call, nothing was replaced.
	OutcomeDryRun Outcome = "dry_run"
	// OutcomeRequestFailed: the call was rejected, nothing was replaced.
	OutcomeRequestFailed Outcome = "request_failed"
	// OutcomeVerifyTimeout: replaced, but the tunnel never came back. Needs a
	// human, since the replacement cannot be undone.
	OutcomeVerifyTimeout Outcome = "verify_timeout"
	// OutcomePeerLost: the surviving tunnel also dropped, so the connection lost
	// both paths. The worst case, and the reason the preflight checks exist.
	OutcomePeerLost Outcome = "peer_lost"
	// OutcomeAborted: verification stopped on shutdown, but the replacement
	// already happened.
	OutcomeAborted Outcome = "aborted"
)

// Terminal reports whether the outcome means nothing is still in progress.
func (o Outcome) Terminal() bool { return o != OutcomeAborted }

// Healthy reports whether the outcome needs no follow-up.
func (o Outcome) Healthy() bool { return o == OutcomeSucceeded || o == OutcomeDryRun }

// Reporter receives progress updates. The Slack implementation posts each one as
// a reply in the approval thread.
//
// There is one method per severity rather than a single Report with a level
// argument, so a caller cannot report a step without classifying it, and the level
// is visible at the call site when reading the replacement flow.
type Reporter interface {
	// Info reports an expected step that needs nothing from anyone.
	Info(ctx context.Context, msg string)
	// Success reports a step that ended the way it was supposed to.
	Success(ctx context.Context, msg string)
	// Warn reports something worth reading that broke nothing.
	Warn(ctx context.Context, msg string)
	// Error reports a failure that needs a human while a path still exists.
	Error(ctx context.Context, msg string)
	// Critical reports the connection having no healthy tunnel.
	Critical(ctx context.Context, msg string)
}

// VPNAPI is the AWS surface the executor needs.
type VPNAPI interface {
	Replace(ctx context.Context, connectionID, outsideIP string, dryRun bool) error
	Describe(ctx context.Context, connectionID string) (awsx.Connection, error)
}

// Request is one approved replacement.
type Request struct {
	Connection awsx.Connection
	// TunnelIP is the tunnel to replace. The outside IP survives a replacement,
	// so it stays the identifier throughout verification.
	TunnelIP string
	// PeerIP is the tunnel expected to carry traffic meanwhile.
	PeerIP string
	// DryRun sends the AWS DryRun flag instead of really replacing.
	DryRun bool
	// Resuming recovers a replacement from persisted state, where the AWS call
	// may already have happened and must not be repeated.
	Resuming bool
	// AcceptanceUnknown marks a resumed replacement whose AWS call was never seen
	// to be accepted, so a tunnel that never moves is as likely to mean the call
	// never landed as it is to mean the replacement is stuck.
	AcceptanceUnknown bool
	// StartedAt is when the replacement really began, set only on the resume path
	// where that moment belongs to a previous process. Reported times count from
	// it, so how long the tunnel has been out is not reset by a restart.
	StartedAt time.Time
	// OnAccepted is called once AWS has answered that it accepted the request, and
	// only then. It is how the caller learns the moment a replacement is definitely
	// under way, which is a different fact from "the call was issued": the second
	// is what the caller already knew before Run.
	OnAccepted func(ctx context.Context)
}

// Options are the verification thresholds.
type Options struct {
	// VerifyTimeout bounds the wait for the tunnel to return.
	VerifyTimeout time.Duration
	// PollInterval is the delay between telemetry reads.
	PollInterval time.Duration
	// MinAcceptedRoutes is the route count a returned tunnel must carry to count
	// as healthy. Ignored on static-routes-only connections.
	MinAcceptedRoutes int32
	// Heartbeat is how often to report "still waiting" when nothing changed.
	Heartbeat time.Duration
}

// Result describes how a replacement ended.
type Result struct {
	Outcome  Outcome
	Duration time.Duration
	Detail   string
	// PeerDropped records that the surviving tunnel went down at some point, even
	// if it recovered: the connection had no path for a while.
	PeerDropped bool
}

// Executor runs replacements.
type Executor struct {
	api    VPNAPI
	opts   Options
	logger *slog.Logger
}

// New builds an Executor.
func New(api VPNAPI, opts Options, logger *slog.Logger) *Executor {
	return &Executor{api: api, opts: opts, logger: logger}
}

// Run replaces the tunnel and verifies it, reporting each step through r. It
// returns a Result rather than an error: once the tunnel is replaced, the question
// is what state it ended in, which an error return would lose.
func (e *Executor) Run(ctx context.Context, req Request, r Reporter) Result {
	started := time.Now()
	// began is when the replacement itself started, which after a restart is earlier
	// than now. Elapsed times are measured from it so the reported duration is how
	// long the tunnel was actually out, while the verification deadline still counts
	// from now: the tunnel gets the full timeout to come back either way.
	began := started
	if !req.StartedAt.IsZero() {
		began = req.StartedAt
	}
	log := e.logger.With("vpn_connection_id", req.Connection.ID, "tunnel_ip", req.TunnelIP, "peer_ip", req.PeerIP)

	if req.Resuming {
		// Already requested before the restart. Calling again could trigger a
		// second replacement, so verification is the only correct next step.
		r.Info(ctx, fmt.Sprintf("Controller restarted mid-replacement. Resuming verification of tunnel `%s` without re-issuing the AWS call. It has been replacing for %s so far.",
			req.TunnelIP, humanize.Elapsed(time.Since(began))))
		log.Info("resuming verification of an in-flight replacement",
			"acceptance_unknown", req.AcceptanceUnknown, "elapsed", humanize.Elapsed(time.Since(began)))
		return e.verify(ctx, req, r, started, began, req.AcceptanceUnknown, log)
	}

	if req.DryRun {
		r.Info(ctx, fmt.Sprintf("Dry run in progress. Validating `ReplaceVpnTunnel` for tunnel `%s`.", req.TunnelIP))
	} else {
		r.Info(ctx, fmt.Sprintf("Calling `ReplaceVpnTunnel` on tunnel `%s`. It will drop shortly; traffic rides `%s`.", req.TunnelIP, req.PeerIP))
	}

	err := e.api.Replace(ctx, req.Connection.ID, req.TunnelIP, req.DryRun)
	switch {
	case errors.Is(err, awsx.ErrDryRunSucceeded):
		log.Info("dry run accepted by AWS; nothing was replaced", "elapsed", humanize.Elapsed(time.Since(began)))
		r.Success(ctx, fmt.Sprintf("Dry run accepted by AWS in %s. Permissions and arguments are valid; no tunnel was replaced.",
			humanize.Elapsed(time.Since(began))))
		return Result{Outcome: OutcomeDryRun, Duration: time.Since(began),
			Detail: "AWS accepted the dry-run request; nothing was replaced"}
	case errors.Is(err, awsx.ErrReplaceUncertain) && req.DryRun:
		// A dry run changes nothing whatever the transport did, so an unanswered
		// call is simply a failed dry run. Verifying one would watch a tunnel that
		// was never going to move.
		log.Error("dry-run ReplaceVpnTunnel did not return an answer",
			"error", err, "elapsed", humanize.Elapsed(time.Since(began)))
		r.Error(ctx, fmt.Sprintf("The dry run did not get an answer from AWS after %s. Nothing was replaced.\n```%s```",
			humanize.Elapsed(time.Since(began)), err))
		return Result{Outcome: OutcomeRequestFailed, Duration: time.Since(began), Detail: err.Error()}
	case errors.Is(err, awsx.ErrReplaceUncertain):
		// AWS may have accepted the request and only the answer was lost. Reporting
		// "nothing was replaced" here is how a real replacement ends up with nobody
		// watching it, so the run continues into verification as if it had started.
		log.Error("ReplaceVpnTunnel did not return a definite answer; verifying instead of assuming it failed",
			"error", err)
		r.Warn(ctx, fmt.Sprintf("AWS did not answer the replacement request, so it may or may not be under way. "+
			"Watching tunnel `%s` as if it were (timeout %s).\n```%s```", req.TunnelIP, e.opts.VerifyTimeout, err))
		return e.verify(ctx, req, r, started, began, true, log)
	case err != nil:
		log.Error("ReplaceVpnTunnel was rejected", "error", err, "elapsed", humanize.Elapsed(time.Since(began)))
		r.Error(ctx, fmt.Sprintf("AWS rejected the replacement request after %s. Nothing was replaced.\n```%s```",
			humanize.Elapsed(time.Since(began)), err))
		return Result{Outcome: OutcomeRequestFailed, Duration: time.Since(began), Detail: err.Error()}
	}

	log.Info("ReplaceVpnTunnel accepted; verifying")
	// Reported before the first poll, so a crash in the next instant leaves state
	// saying the replacement is definitely under way rather than merely requested.
	if req.OnAccepted != nil {
		req.OnAccepted(ctx)
	}
	r.Info(ctx, fmt.Sprintf("AWS accepted the replacement. Watching tunnel `%s` until it returns (timeout %s).",
		req.TunnelIP, e.opts.VerifyTimeout))
	return e.verify(ctx, req, r, started, began, false, log)
}

// verify polls telemetry until the replaced tunnel is healthy or the timeout
// expires.
//
// Health requires two things: the tunnel is UP with enough routes, and it has
// actually cycled. Without the second condition an immediate poll could see the
// pre-replacement UP state and declare success before the tunnel had even
// dropped.
// uncertain marks a run whose AWS call was never answered, which only changes what a
// timeout means: the tunnel may have been left alone rather than replaced and stuck.
//
// started bounds the wait, began is what every reported duration counts from. They
// differ only on the resume path, where the replacement is older than this watch.
func (e *Executor) verify(ctx context.Context, req Request, r Reporter, started, began time.Time, uncertain bool, log *slog.Logger) Result {
	deadline := started.Add(e.opts.VerifyTimeout)
	ticker := time.NewTicker(e.opts.PollInterval)
	defer ticker.Stop()

	var (
		sawDown       bool
		peerDropped   bool
		peerAlerted   bool
		lastReported  string
		lastHeartbeat = time.Now()
	)

	for {
		select {
		case <-ctx.Done():
			log.Warn("verification aborted by shutdown; the replacement itself already happened",
				"elapsed", humanize.Elapsed(time.Since(began)))
			r.Warn(ctx, fmt.Sprintf("Controller is shutting down while verifying tunnel `%s`, %s into the replacement. "+
				"The replacement already happened; verification resumes when the controller comes back.",
				req.TunnelIP, humanize.Elapsed(time.Since(began))))
			return Result{Outcome: OutcomeAborted, Duration: time.Since(began), PeerDropped: peerDropped,
				Detail: "verification interrupted by shutdown"}
		case <-ticker.C:
		}

		conn, err := e.api.Describe(ctx, req.Connection.ID)
		if err != nil {
			// A transient describe failure is not a verdict. Keep polling until
			// the timeout rather than declaring an outcome from missing data.
			log.Warn("failed to read VPN telemetry while verifying; will retry", "error", err)
			if time.Now().After(deadline) {
				return e.timeout(ctx, req, r, began, peerDropped, uncertain, "telemetry could not be read. "+err.Error())
			}
			continue
		}

		target, ok := conn.Tunnel(req.TunnelIP)
		if !ok {
			// The outside IP survives an endpoint replacement, so losing it
			// means the connection itself changed under us.
			msg := fmt.Sprintf("tunnel %s is no longer reported by the connection", req.TunnelIP)
			log.Error("target tunnel disappeared during verification", "elapsed", humanize.Elapsed(time.Since(began)))
			r.Error(ctx, fmt.Sprintf("Tunnel `%s` is no longer reported by `%s`, %s into the replacement. The connection changed during the replacement.",
				req.TunnelIP, conn.ID, humanize.Elapsed(time.Since(began))))
			return Result{Outcome: OutcomeVerifyTimeout, Duration: time.Since(began), PeerDropped: peerDropped, Detail: msg}
		}
		peer, hasPeer := conn.Tunnel(req.PeerIP)

		if !target.Up {
			sawDown = true
		}

		// The surviving tunnel dropping is the failure the preflight checks
		// exist to prevent, so it is reported the moment it is seen rather than
		// at the end.
		if hasPeer && !peer.Up && !peerAlerted {
			peerDropped = true
			peerAlerted = true
			log.Error("peer tunnel went DOWN during the replacement; the connection has no healthy path")
			r.Critical(ctx, fmt.Sprintf("*Peer tunnel `%s` just went DOWN while `%s` is being replaced.* "+
				"This connection currently has no healthy tunnel. %s",
				req.PeerIP, req.TunnelIP, statusDetail(peer)))
		}
		if hasPeer && peer.Up && peerAlerted {
			peerAlerted = false
			r.Success(ctx, fmt.Sprintf("Peer tunnel `%s` is back UP (%d route(s)).", req.PeerIP, peer.AcceptedRoutes))
		}

		if e.healthy(conn, target, sawDown, started) {
			elapsed := time.Since(began)
			log.Info("replacement verified", "elapsed", humanize.Elapsed(elapsed),
				"elapsed_seconds", elapsed.Seconds(), "accepted_routes", target.AcceptedRoutes)
			r.Success(ctx, fmt.Sprintf("Tunnel `%s` is back UP with %d route(s). The replacement took %s.",
				req.TunnelIP, target.AcceptedRoutes, humanize.Elapsed(elapsed)))
			return Result{Outcome: OutcomeSucceeded, Duration: elapsed, PeerDropped: peerDropped,
				Detail: fmt.Sprintf("tunnel UP with %d accepted route(s)", target.AcceptedRoutes)}
		}

		// Report on change, and on a heartbeat otherwise, so the thread neither
		// floods nor goes quiet during a long replacement.
		summary := progressLine(target, peer, hasPeer, time.Since(began))
		if summary != lastReported || time.Since(lastHeartbeat) >= e.opts.Heartbeat {
			r.Info(ctx, summary)
			lastReported = summary
			lastHeartbeat = time.Now()
		}

		if time.Now().After(deadline) {
			// The detail carries no time of its own: every place that renders it
			// states how long the attempt ran, and two different renderings of the
			// same duration in one sentence read as two facts.
			return e.timeout(ctx, req, r, began, peerDropped, uncertain,
				"the tunnel never came back UP with enough accepted routes")
		}
	}
}

// healthy reports whether the replaced tunnel counts as recovered: UP, carrying
// enough routes, and demonstrably cycled since the replacement began.
func (e *Executor) healthy(conn awsx.Connection, target awsx.Tunnel, sawDown bool, started time.Time) bool {
	if !target.Up {
		return false
	}
	if !conn.StaticRoutesOnly && target.AcceptedRoutes < e.opts.MinAcceptedRoutes {
		return false
	}
	return sawDown || target.LastStatusChange.After(started)
}

func (e *Executor) timeout(ctx context.Context, req Request, r Reporter, began time.Time, peerDropped, uncertain bool, detail string) Result {
	elapsed := time.Since(began)
	e.logger.Error("replacement verification timed out",
		"vpn_connection_id", req.Connection.ID, "tunnel_ip", req.TunnelIP,
		"elapsed", humanize.Elapsed(elapsed), "elapsed_seconds", elapsed.Seconds(),
		"uncertain", uncertain, "detail", detail)

	advice := "The replacement cannot be rolled back. Check the customer gateway side and the tunnel's IKE/IPsec status."
	if uncertain {
		// The call was never answered, so an unchanged tunnel is the likely case
		// rather than a stuck replacement. Saying otherwise sends the operator to
		// the customer gateway for a problem that is not there.
		detail += ", and the AWS call was never answered, so it may never have started"
		advice = "Check whether the tunnel still has pending maintenance before retrying. " +
			"If it does, nothing was replaced."
	}
	r.Error(ctx, fmt.Sprintf("*Gave up on tunnel `%s` after %s.* %s\n%s",
		req.TunnelIP, humanize.Elapsed(elapsed), detail, advice))
	return Result{Outcome: OutcomeVerifyTimeout, Duration: elapsed, PeerDropped: peerDropped, Detail: detail}
}

// progressLine renders the current state of both tunnels as sentences, since it is
// posted to a Slack thread rather than to a log.
func progressLine(target, peer awsx.Tunnel, hasPeer bool, elapsed time.Duration) string {
	line := fmt.Sprintf("Tunnel `%s` is %s.", target.OutsideIP, upDown(target.Up))
	if target.StatusMessage != "" {
		line += " " + statusDetail(target)
	}
	if hasPeer {
		line += fmt.Sprintf(" Peer tunnel `%s` is %s with %d route(s).",
			peer.OutsideIP, upDown(peer.Up), peer.AcceptedRoutes)
	}
	return line + fmt.Sprintf(" %s elapsed so far.", humanize.Elapsed(elapsed))
}

func upDown(up bool) string {
	if up {
		return "UP"
	}
	return "DOWN"
}

func statusDetail(t awsx.Tunnel) string {
	if t.StatusMessage == "" {
		return ""
	}
	return "AWS reports " + t.StatusMessage + "."
}
