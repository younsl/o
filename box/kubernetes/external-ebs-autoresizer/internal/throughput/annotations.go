package throughput

import (
	"math"
	"slices"
	"strconv"
	"time"
)

// Annotation key suffixes written on each Node, joined to the configured prefix
// as "<prefix>/<suffix>". Keys are stable identifiers: renaming one orphans the
// old key on every already-annotated Node.
const (
	keyVolumeID       = "volume-id"
	keyCurrentMiBps   = "throughput-current-mibps"
	keyPeakMiBps      = "throughput-observed-peak-mibps"
	keyUtilization    = "throughput-utilization-percent"
	keyRecommendMiBps = "throughput-recommended-mibps"
	keyCurrentIOPS    = "iops-current"
	keyRecommendIOPS  = "iops-recommended"
	keyRecommendation = "throughput-recommendation"
	keyReason         = "throughput-recommendation-reason"
	keyWindow         = "throughput-observation-window"
	keySamples        = "throughput-observation-samples"
	keyObservedAt     = "throughput-observed-at"
)

// dataKeys are every key except throughput-observed-at, in a fixed order. It is
// excluded because it changes on every pass and would make every comparison
// report a difference, defeating the skip-unchanged check.
var dataKeys = []string{
	keyVolumeID, keyCurrentMiBps, keyPeakMiBps, keyUtilization,
	keyRecommendMiBps, keyCurrentIOPS, keyRecommendIOPS, keyRecommendation,
	keyReason, keyWindow, keySamples,
}

// refreshInterval is how stale throughput-observed-at may get before the annotations are
// rewritten even though nothing changed. Without it a steady-state cluster would
// show a timestamp from the day the recommendation first settled, leaving an
// operator unable to tell a current reading from a stopped recommender.
const refreshInterval = 24 * time.Hour

// annotationSet is one Node's desired annotations: values to write and keys to
// remove. Removal matters when a Node drops from a full recommendation to
// unknown (its volume was detached, or its metrics disappeared): leaving the last
// numbers behind would present a stale recommendation as a current one.
type annotationSet struct {
	set    map[string]string
	remove []string
}

// buildAnnotations renders one node's decision into annotation values. Numeric
// keys are only written when the underlying value is actually known; every other
// key in dataKeys is queued for removal so no stale value survives.
func (r *Recommender) buildAnnotations(obs observation, d Decision) annotationSet {
	key := func(suffix string) string { return AnnotationPrefix + "/" + suffix }

	set := map[string]string{
		key(keyRecommendation): d.Action,
		key(keyReason):         d.Reason,
		key(keyWindow):         r.cfg.Window(),
	}
	if obs.volume.ID != "" {
		set[key(keyVolumeID)] = obs.volume.ID
		set[key(keyCurrentMiBps)] = strconv.FormatInt(int64(obs.volume.ThroughputMiBps), 10)
		set[key(keyCurrentIOPS)] = strconv.FormatInt(int64(obs.volume.IOPS), 10)
	}
	if obs.hasMetrics {
		set[key(keyPeakMiBps)] = strconv.FormatFloat(obs.input.PeakMiBps, 'f', 1, 64)
		set[key(keySamples)] = strconv.Itoa(obs.input.Samples)
	}
	// Utilization is derivable from the two keys above, but only outside kubectl:
	// custom-columns cannot divide. Writing it is what makes a fleet sortable by how
	// close each node runs to its provisioning. It needs a volume with a provisioned
	// throughput to divide by and a finite peak: a NaN peak is missing data, and
	// publishing "NaN" as a utilization reads like a broken volume rather than a
	// broken query.
	if obs.volume.ID != "" && obs.hasMetrics && obs.volume.ThroughputMiBps > 0 &&
		!math.IsNaN(obs.input.PeakMiBps) && !math.IsInf(obs.input.PeakMiBps, 0) {
		utilization := obs.input.PeakMiBps / float64(obs.volume.ThroughputMiBps) * 100
		set[key(keyUtilization)] = strconv.FormatFloat(utilization, 'f', 1, 64)
	}
	if d.Action == ActionIncrease || d.Action == ActionDecrease || d.Action == ActionNone {
		set[key(keyRecommendMiBps)] = strconv.FormatInt(int64(d.RecommendedThroughputMiBps), 10)
		set[key(keyRecommendIOPS)] = strconv.FormatInt(int64(d.RecommendedIOPS), 10)
	}

	var remove []string
	for _, suffix := range dataKeys {
		if _, ok := set[key(suffix)]; !ok {
			remove = append(remove, key(suffix))
		}
	}
	return annotationSet{set: set, remove: remove}
}

// needsWrite reports whether the Node's annotations have to be patched: any data
// value differs, a key queued for removal is still present, or throughput-observed-at has
// gone stale past refreshInterval.
func (a annotationSet) needsWrite(existing map[string]string, observedAtKey string, now time.Time) bool {
	for k, v := range a.set {
		if existing[k] != v {
			return true
		}
	}
	if slices.ContainsFunc(a.remove, func(k string) bool { _, ok := existing[k]; return ok }) {
		return true
	}
	last, err := time.Parse(time.RFC3339, existing[observedAtKey])
	if err != nil {
		return true
	}
	return now.Sub(last) >= refreshInterval
}
