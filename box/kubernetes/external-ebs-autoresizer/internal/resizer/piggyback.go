package resizer

import (
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/recstore"
)

// This file decides whether a volume modification should carry the throughput
// recommender's latest increase recommendation along with the size change. EC2
// allows one modification per volume per 6 hours, so a size expansion is the
// only free ride a throughput change ever gets; a volume whose disk never
// fills simply keeps its recommendation as an annotation, exactly as before.

// staleFactor scales the recommender's interval into the maximum age a
// recommendation may have and still be applied. Two intervals tolerate one
// missed pass; anything older means the recommender has stopped and its last
// output no longer describes the present.
const staleFactor = 2

// Outcomes of one piggyback decision. Attempts and skips are separate metrics
// (throughput_apply_total{result} and throughput_apply_skip_total{reason}),
// mirroring the resize_total / skip_total split: an attempt sent a combined
// request to EC2, a skip never did, and mixing different units of work under
// one metric would make its sum meaningless.
const (
	// applyResultApplied and applyResultFallback describe an attempted
	// piggyback: the combined request succeeded, or was rejected and the resize
	// retried size-only.
	applyResultApplied  = "applied"
	applyResultFallback = "fallback_size_only"
	// applySkipNoRecommendation: the recommender has never evaluated this
	// volume (standalone instance, multiple volumes, node too young).
	applySkipNoRecommendation = "no_recommendation"
	// applySkipStale: a recommendation exists but is older than the freshness
	// bound, which means the recommender has stopped producing while the
	// resizer kept going. The one skip worth alerting on.
	applySkipStale = "stale"
	// applySkipNotIncrease: a fresh recommendation exists and asks for no
	// raise (none, decrease, or not above the provisioned value). The healthy
	// steady state.
	applySkipNotIncrease = "not_increase"
)

// RecommendationMaxAge is the freshness bound derived from the recommender's
// interval. Exported so the startup log can report the same number the apply
// gate actually enforces.
func RecommendationMaxAge(interval time.Duration) time.Duration {
	return staleFactor * interval
}

// throughputPiggyback returns the recommendation to fold into a volume
// modification and whether there is one, plus the skip reason when there is
// not (one of the applySkip* values, or "" when the feature is off
// entirely, which is a configuration state rather than a per-volume outcome).
// It only ever returns an increase: applying a decrease as a side effect of a
// size expansion would cut bandwidth at the exact moment the instance is busy
// enough to be filling its disk.
func (r *Resizer) throughputPiggyback(volumeID string) (recstore.Entry, bool, string) {
	tr := r.cfg.ThroughputRecommendation
	if !tr.ApplyOnResize || r.recs == nil {
		return recstore.Entry{}, false, ""
	}
	rec, ok := r.recs.Lookup(volumeID, RecommendationMaxAge(tr.Interval))
	if !ok {
		// NodeRef ignores entry age, so it distinguishes "the recommender has
		// never seen this volume" from "it has, but its output has gone stale".
		if _, _, exists := r.recs.NodeRef(volumeID); exists {
			return recstore.Entry{}, false, applySkipStale
		}
		return recstore.Entry{}, false, applySkipNoRecommendation
	}
	// The direction is re-checked against the provisioning observed with the
	// recommendation, so a malformed entry can never lower a volume's
	// throughput even if a bug upstream mislabels its action.
	if rec.Action != recstore.ActionIncrease || rec.ThroughputMiBps <= rec.CurrentMiBps {
		return recstore.Entry{}, false, applySkipNotIncrease
	}
	return rec, true, ""
}
