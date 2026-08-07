// Package humanize renders measured times the way an operator reads them.
package humanize

import (
	"fmt"
	"time"
)

// Elapsed renders how long something took, for a Slack thread or a log line.
//
// Seconds are kept at every scale, unlike the minute-rounded horizons on the approval
// card: a replacement that took 3m 07s and one that took 3m 52s are different facts,
// and the difference is exactly what someone reading a replacement report is after.
func Elapsed(d time.Duration) string {
	if d <= 0 {
		return "0s"
	}
	if d < time.Second {
		// Sub-second only happens on a rejected call, where "0s" would read as if
		// nothing had been measured at all.
		return d.Round(time.Millisecond).String()
	}

	d = d.Round(time.Second)
	h := int(d / time.Hour)
	m := int(d % time.Hour / time.Minute)
	s := int(d % time.Minute / time.Second)
	switch {
	case h > 0:
		return fmt.Sprintf("%dh %02dm %02ds", h, m, s)
	case m > 0:
		return fmt.Sprintf("%dm %02ds", m, s)
	default:
		return fmt.Sprintf("%ds", s)
	}
}
