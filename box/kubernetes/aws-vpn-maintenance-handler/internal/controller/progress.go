package controller

import (
	"fmt"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/humanize"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
)

// runPhase is one leg of replacing a single tunnel, in the order they happen.
//
// The values are counters, not identifiers: a percentage over them is only meaningful
// because every tunnel of a run passes through the same four in the same order, so one
// finished tunnel is always worth exactly as much as any other.
//
// Deliberately not state.Phase, which is the narrower question a restart asks: whether
// an AWS call may already have landed. That has three values and no notion of the
// checking or recording legs, which is most of the wall clock an operator waits through.
type runPhase int

const (
	// phaseChecking re-applies the preflight rules to the tunnel that is next.
	phaseChecking runPhase = iota + 1
	// phaseReplacing has the in-flight record written and the AWS call outstanding.
	phaseReplacing
	// phaseVerifying is AWS having accepted, with the tunnel being watched back to health.
	phaseVerifying
	// phaseRecorded is the outcome persisted and the step closed out.
	phaseRecorded
)

// phasesPerTunnel is how much of a run one tunnel accounts for.
const phasesPerTunnel = int(phaseRecorded)

// progress is where a run has got to, shared between the controller that advances it
// and the reporter that renders it.
//
// A run is one approval, which covers every tunnel of one connection. The tunnel count
// is fixed when the run starts, so the percentage only ever moves forward: a figure that
// could be revised downward mid-run would be worse than no figure at all.
//
// Only the run's own goroutine touches this. The controller advances it between calls
// into the executor, and the executor reports back through the same goroutine, so the
// phase a message carries is the phase that produced it.
type progress struct {
	// tunnels is how many tunnels this approval covers. Zero until the run starts,
	// which is what keeps the footer off the approval card's own replies.
	tunnels int
	// done is how many tunnels are completely finished, so phase describes tunnel
	// number done+1.
	done  int
	phase runPhase
	// startedAt is when the run began, which after a restart is earlier than this
	// process. It is what the closing report measures from, so a rollout mid-run does
	// not make the connection look faster than it was.
	startedAt time.Time
	// finished counts tunnels whose outcome was recorded, across restarts. Separate
	// from done, which is an index into the run rather than a count of results.
	finished int
	// unhealthy counts those that did not end healthy, which is what decides whether a
	// finished run is worth reading.
	unhealthy int
}

// start fixes the size of the run and puts it at the first phase of its first tunnel.
func (p *progress) start(tunnels int) {
	p.tunnels, p.done, p.phase = tunnels, 0, phaseChecking
	if p.startedAt.IsZero() {
		p.startedAt = time.Now()
	}
}

// resume starts a run that a previous process already got part-way through. startedAt
// comes from the persisted record, so the run is still timed from its real beginning.
func (p *progress) resume(tunnels, done int, phase runPhase, startedAt time.Time) {
	p.tunnels, p.done, p.phase = tunnels, done, phase
	p.finished = done
	p.startedAt = startedAt
	if p.startedAt.IsZero() {
		p.startedAt = time.Now()
	}
}

// at moves the run to a phase of the tunnel after done finished ones.
func (p *progress) at(done int, phase runPhase) {
	p.done, p.phase = done, phase
}

// record marks the tunnel after done finished ones as finished itself.
func (p *progress) record(done int, healthy bool) {
	p.done, p.phase = done, phaseRecorded
	p.finished = done + 1
	if !healthy {
		p.unhealthy++
	}
}

// line renders the footer, or empty when there is no run to report on.
func (p *progress) line() string {
	if p == nil || p.tunnels <= 0 {
		return ""
	}
	total := p.tunnels * phasesPerTunnel
	current := min(p.done*phasesPerTunnel+int(p.phase), total)
	// Rounded rather than truncated, so the last phase of a run reads as 100% and the
	// first of many does not read as 0%.
	return fmt.Sprintf("Progress: %d/%d (%d%%)", current, total, (current*200+total)/(total*2))
}

// report closes out a run with what it achieved and how long the whole thing took, or
// false when there is nothing to close out.
//
// The per-tunnel lines already state each replacement's own duration, and on a chain
// that is never the number anyone actually wants: an approver who clicked once wants to
// know how long the connection took, including the wait between tunnels, which is the
// largest part of it and appears in none of the per-tunnel figures.
//
// Withheld for a single-tunnel run. There, the run and its one replacement differ only
// by the re-check, and restating a duration already posted one line above reads as a
// second measurement of something else.
func (p *progress) report(elapsed time.Duration) (slackx.Level, string, bool) {
	if p == nil || p.tunnels < 2 || p.finished == 0 {
		return "", "", false
	}
	took := humanize.Elapsed(elapsed)

	switch {
	case p.finished < p.tunnels:
		return slackx.LevelWarn, fmt.Sprintf(
			"*Run ended early.* %d of %d tunnel(s) replaced, and the whole run took %s. "+
				"The rest keep their queued maintenance and are proposed again in a later window.",
			p.finished, p.tunnels, took), true
	case p.unhealthy > 0:
		return slackx.LevelWarn, fmt.Sprintf(
			"*Run finished.* All %d tunnel(s) were replaced in %s, but %d did not end healthy. "+
				"Read the steps above before treating this connection as done.",
			p.tunnels, took, p.unhealthy), true
	default:
		return slackx.LevelSuccess, fmt.Sprintf(
			"*Run complete.* All %d tunnel(s) of this connection are done. The whole run took %s.",
			p.tunnels, took), true
	}
}

// withProgress puts the footer on its own line under a message, so a reply found on its
// own says how much of the approved work stands behind it. Messages posted when no run
// is under way are returned untouched.
func withProgress(msg string, p *progress) string {
	line := p.line()
	if line == "" {
		return msg
	}
	return msg + "\n" + line
}
