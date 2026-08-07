package promx

import (
	"fmt"
	"sort"
	"time"
)

// History shaping constants. They are not configuration because they are properties
// of the question rather than of a cluster: how far back is worth trusting, how long
// "now" lasts, and how few samples make a distribution meaningless. The one number an
// operator does decide is which share of that distribution counts as quiet.
const (
	// lookback is how much history the distribution is drawn from. Four weeks covers
	// four occurrences of a weekly window, so one unusual week cannot define normal.
	lookback = 28 * 24 * time.Hour
	// step is the resolution of the historical range. It matches sampleWindow, so a
	// historical point and the current one measure the same span.
	step = 5 * time.Minute
	// sustain is how far back "now" reaches. The maximum over it, not the last
	// sample, is what gets judged: a transfer that started three minutes ago is
	// traffic the replacement would interrupt.
	sustain = 15 * time.Minute
	// minSamples is the smallest distribution worth a percentile. Below it the
	// history is treated as unreadable, which onError then decides.
	minSamples = 24
	// urgentPercentile is the target the gate falls back to once AWS is about to
	// apply the maintenance itself. Waiting for the quietest fifth of the window
	// stops being the safer choice when the alternative is AWS picking the moment.
	urgentPercentile = 50
)

// history is the traffic distribution of one connection during its maintenance
// window, plus where the present moment sits inside it.
type history struct {
	// values are the in-window samples, sorted ascending.
	values []float64
	// slots groups the same samples by clock time, for the recommendation.
	slots map[string][]float64
}

// newHistory keeps the samples that fell inside a past maintenance window.
//
// Filtering by the window is what makes the percentile answer the right question.
// Comparing a midday moment against a distribution that includes every night would
// judge business hours against sleeping hours, and no percentile of that mixture is
// ever reached while the office is awake.
func newHistory(samples []Sample, inWindow func(time.Time) bool, loc *time.Location) history {
	if loc == nil {
		loc = time.Local
	}
	h := history{slots: make(map[string][]float64)}
	for _, s := range samples {
		if inWindow != nil && !inWindow(s.At) {
			continue
		}
		h.values = append(h.values, s.V)
		key := s.At.In(loc).Truncate(step).Format("15:04")
		h.slots[key] = append(h.slots[key], s.V)
	}
	sort.Float64s(h.values)
	return h
}

// percentile returns the value at p percent of the distribution, interpolating
// between the two neighbouring samples.
func (h history) percentile(p float64) float64 {
	if len(h.values) == 0 {
		return 0
	}
	switch {
	case p <= 0:
		return h.values[0]
	case p >= 100:
		return h.values[len(h.values)-1]
	}
	pos := (p / 100) * float64(len(h.values)-1)
	lower := int(pos)
	if lower >= len(h.values)-1 {
		return h.values[len(h.values)-1]
	}
	frac := pos - float64(lower)
	return h.values[lower] + frac*(h.values[lower+1]-h.values[lower])
}

// rank reports what share of the distribution v is at or above, so a verdict can say
// where the moment sits rather than only whether it passed.
func (h history) rank(v float64) float64 {
	if len(h.values) == 0 {
		return 0
	}
	below := sort.SearchFloat64s(h.values, v)
	return 100 * float64(below) / float64(len(h.values))
}

// quietest returns the clock time of the window's calmest slot and its median, for
// the recommendation shown while the gate is holding. Empty when the history is too
// thin to name one.
//
// The median per slot rather than the minimum: one quiet Tuesday is luck, and a
// recommendation an approver is meant to act on should point at a habit.
func (h history) quietest() (string, float64, bool) {
	var (
		bestAt     string
		bestMedian float64
		found      bool
	)
	for at, values := range h.slots {
		// A slot seen once carries no information about what usually happens then.
		if len(values) < 2 {
			continue
		}
		sorted := append([]float64(nil), values...)
		sort.Float64s(sorted)
		median := sorted[len(sorted)/2]
		if !found || median < bestMedian || (median == bestMedian && at < bestAt) {
			bestAt, bestMedian, found = at, median, true
		}
	}
	return bestAt, bestMedian, found
}

// sustainedNow returns the highest traffic seen in the last sustain window, and false
// when nothing was scraped in it.
//
// Missing recent samples are not the same as an idle tunnel: a broken exporter would
// otherwise read as perfectly quiet, which is the one wrong answer that leads to a
// replacement during a peak.
func sustainedNow(samples []Sample, now time.Time) (float64, bool) {
	cutoff := now.Add(-sustain)
	var (
		peak  float64
		found bool
	)
	for _, s := range samples {
		if s.At.Before(cutoff) {
			continue
		}
		if !found || s.V > peak {
			peak, found = s.V, true
		}
	}
	return peak, found
}

// formatClock renders a recommended slot with its timezone, since an approver reading
// the card needs to know which clock 11:35 is on.
func formatClock(at string, loc *time.Location, now time.Time) string {
	if loc == nil {
		return at
	}
	return fmt.Sprintf("%s %s", at, now.In(loc).Format("MST"))
}
