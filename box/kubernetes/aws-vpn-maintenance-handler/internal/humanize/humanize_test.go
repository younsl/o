package humanize

import (
	"testing"
	"time"
)

func TestElapsed(t *testing.T) {
	for in, want := range map[time.Duration]string{
		0:                             "0s",
		-time.Second:                  "0s",
		812 * time.Millisecond:        "812ms",
		time.Second:                   "1s",
		59 * time.Second:              "59s",
		time.Minute:                   "1m 00s",
		3*time.Minute + 7*time.Second: "3m 07s",
		time.Hour:                     "1h 00m 00s",
		time.Hour + 5*time.Minute:     "1h 05m 00s",
		2*time.Hour + 34*time.Minute + 5*time.Second: "2h 34m 05s",
	} {
		if got := Elapsed(in); got != want {
			t.Errorf("Elapsed(%s) = %q, want %q", in, got, want)
		}
	}
}

// Sub-second values round rather than truncate, so a call that took just under a
// second does not report as "0s" and read like nothing was measured.
func TestElapsedRoundsSubSecondUp(t *testing.T) {
	if got := Elapsed(999*time.Millisecond + 800*time.Microsecond); got != "1s" {
		t.Fatalf("Elapsed(999.8ms) = %q, want %q", got, "1s")
	}
}
