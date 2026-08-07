// Package window evaluates the maintenance window that gates when a replacement may
// start. It keeps replacements out of business hours and refuses to start work it
// cannot finish verifying before the window closes.
//
// The window is a cron schedule plus a duration: each firing of the schedule opens
// the window for that long. Cron alone only names instants, so the duration is what
// turns those instants into a window.
package window

import (
	"fmt"
	"time"

	"github.com/robfig/cron/v3"
)

// Window is a recurring window compiled from a cron schedule and a duration.
type Window struct {
	loc      *time.Location
	spec     string
	schedule cron.Schedule
	duration time.Duration
	// minRemaining is how much window must be left for Open to report true.
	minRemaining time.Duration
}

// Config is the uncompiled window definition.
type Config struct {
	// Timezone is an IANA name; the schedule is evaluated in it.
	Timezone string
	// CronSchedule is a standard 5-field expression (minute hour dom month dow).
	CronSchedule string
	// Duration is how long the window stays open after each firing.
	Duration time.Duration
	// MinRemaining is the minimum window left for a replacement to start.
	MinRemaining time.Duration
}

// Parse compiles a cron expression, for validating configuration without building a
// whole Window.
func Parse(spec string) (cron.Schedule, error) {
	if spec == "" {
		return nil, fmt.Errorf("cron schedule is required")
	}
	schedule, err := cron.ParseStandard(spec)
	if err != nil {
		return nil, fmt.Errorf("invalid cron schedule %q: %w", spec, err)
	}
	return schedule, nil
}

// New compiles a Config, returning an error for an unknown timezone, a malformed
// cron expression, or a non-positive duration.
func New(cfg Config) (*Window, error) {
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		return nil, fmt.Errorf("timezone %q: %w", cfg.Timezone, err)
	}
	schedule, err := Parse(cfg.CronSchedule)
	if err != nil {
		return nil, err
	}
	if cfg.Duration <= 0 {
		return nil, fmt.Errorf("window duration must be positive, got %s", cfg.Duration)
	}
	return &Window{
		loc:          loc,
		spec:         cfg.CronSchedule,
		schedule:     schedule,
		duration:     cfg.Duration,
		minRemaining: cfg.MinRemaining,
	}, nil
}

// Open reports whether a replacement may start at t, and why not otherwise. Being
// inside the window is not enough: minRemaining must be left.
func (w *Window) Open(t time.Time) (bool, string) {
	opened, ok := w.openedAt(t)
	if !ok {
		next := w.schedule.Next(t.In(w.loc))
		return false, fmt.Sprintf("outside window: schedule %q (%s) next opens at %s",
			w.spec, w.loc, next.Format("2006-01-02 15:04 MST"))
	}
	if left := opened.Add(w.duration).Sub(t); left < w.minRemaining {
		return false, fmt.Sprintf("too little window left: %s remaining, %s required",
			left.Round(time.Minute), w.minRemaining)
	}
	return true, ""
}

// Contains reports whether t fell inside a window, ignoring minRemaining.
//
// Unlike Open, this is asked about the past: it selects which historical samples are
// comparable to the present moment. minRemaining is deliberately not applied, because
// it decides whether work may start, not whether that instant was a window instant.
func (w *Window) Contains(t time.Time) bool {
	_, ok := w.openedAt(t)
	return ok
}

// Remaining returns how long the window stays open from t, or 0 when closed.
func (w *Window) Remaining(t time.Time) time.Duration {
	opened, ok := w.openedAt(t)
	if !ok {
		return 0
	}
	return opened.Add(w.duration).Sub(t)
}

// StartBudget returns how much longer a replacement may still be started at t, which
// is Remaining less minRemaining, and 0 once no start is permitted.
//
// Remaining answers when the window closes; this answers when it stops accepting new
// work, which is the deadline anything waiting for permission to start is really up
// against. It is the same comparison Open makes, exposed as the value rather than the
// verdict, because a caller deciding how long to keep waiting needs the margin and not
// only whether it has run out.
func (w *Window) StartBudget(t time.Time) time.Duration {
	left := w.Remaining(t)
	if left <= w.minRemaining {
		return 0
	}
	return left - w.minRemaining
}

// NextOpen returns the next time the window opens after t.
func (w *Window) NextOpen(t time.Time) time.Time {
	return w.schedule.Next(t.In(w.loc))
}

// Location reports the timezone the schedule is evaluated in.
func (w *Window) Location() *time.Location { return w.loc }

// Duration reports how long each window stays open.
func (w *Window) Duration() time.Duration { return w.duration }

// String renders the window for startup logs and Slack messages.
func (w *Window) String() string {
	return fmt.Sprintf("%q for %s (%s), min remaining %s", w.spec, w.duration, w.loc, w.minRemaining)
}

// openedAt returns the firing whose window covers t.
//
// cron only reports the next firing, so the search starts one duration back: any
// firing whose window still covers t must lie in (t-duration, t]. Walking forward
// from there and keeping the last firing at or before t picks the most recent one,
// which matters when the schedule fires more than once per duration.
func (w *Window) openedAt(t time.Time) (time.Time, bool) {
	local := t.In(w.loc)
	var (
		opened time.Time
		found  bool
	)
	for next := w.schedule.Next(local.Add(-w.duration)); !next.After(local); next = w.schedule.Next(next) {
		opened, found = next, true
	}
	return opened, found
}
