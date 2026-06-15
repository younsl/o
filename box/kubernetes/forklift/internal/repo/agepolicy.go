package repo

import (
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// ageDecision is the outcome of an age-policy evaluation.
type ageDecision int

const (
	ageAllow ageDecision = iota // policy disabled, satisfied, or no release time known
	ageWarn                     // violates policy but action is "warn"
	ageBlock                    // violates policy and action is "block"
)

// evaluateAge applies a repository's age policy to an upstream release time. The
// primary use is a cooldown window (MinAge): freshly published versions are
// quarantined to mitigate supply-chain attacks. If publishedAt is nil the
// release time is unknown and the artifact is allowed (we never block on missing
// data, only on a known-too-new release).
func evaluateAge(cfg repoconfig.AgePolicyConfig, publishedAt *time.Time, now time.Time) (ageDecision, string) {
	if !cfg.Enabled || publishedAt == nil {
		return ageAllow, ""
	}
	age := now.Sub(*publishedAt)

	violated := ""
	if min := cfg.MinAge.D(); min > 0 && age < min {
		violated = "release is newer than min_age cooldown"
	}
	if max := cfg.MaxAge.D(); max > 0 && age > max {
		violated = "release is older than max_age"
	}
	if violated == "" {
		return ageAllow, ""
	}
	if cfg.Action == repoconfig.ActionWarn {
		return ageWarn, violated
	}
	return ageBlock, violated
}
