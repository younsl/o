package throughput

import "math"

// EBS gp3 provisioning limits. gp3 is the only volume type this package
// recommends for, because it is the only one where throughput is provisioned
// independently: gp2 derives throughput from volume size, and io1/io2 derive it
// from provisioned IOPS, so on those types a throughput recommendation is really
// a size or IOPS recommendation and is out of scope here.
const (
	// VolumeTypeGP3 is the only supported EBS volume type.
	VolumeTypeGP3 = "gp3"

	gp3MinThroughputMiBps = 125
	gp3MaxThroughputMiBps = 1000
	gp3MinIOPS            = 3000
	gp3MaxIOPS            = 16000

	// gp3IOPSPerMiBps encodes the AWS rule that a gp3 volume may provision at
	// most 0.25 MiB/s of throughput per provisioned IOPS. Throughput therefore
	// cannot be raised past IOPS/4, which is why a throughput recommendation must
	// carry an IOPS recommendation with it: at the default 3000 IOPS the volume
	// is capped at 750 MiB/s no matter what throughput is requested.
	gp3IOPSPerMiBps = 4
)

// Unit conversion. DescribeInstanceTypes reports instance EBS bandwidth in MB/s
// (decimal megabytes), while gp3 throughput is provisioned in MiB/s (binary
// mebibytes). Comparing the two numbers directly overstates the instance's
// headroom by about 4.9%, which is enough to recommend a throughput the instance
// cannot actually drive.
const (
	bytesPerMB  = 1_000_000
	bytesPerMiB = 1 << 20
)

// MBpsToMiBps converts decimal MB/s to binary MiB/s.
func MBpsToMiBps(mbps float64) float64 {
	return mbps * bytesPerMB / bytesPerMiB
}

// Recommendation actions, published as the recommendation annotation.
const (
	// ActionIncrease means the observed demand needs more throughput than is
	// provisioned.
	ActionIncrease = "increase"
	// ActionDecrease means the volume is provisioned at least one full step above
	// what the observed demand needs.
	ActionDecrease = "decrease"
	// ActionNone means the current provisioning already fits.
	ActionNone = "none"
	// ActionUnknown means no recommendation could be made; Reason says why.
	ActionUnknown = "unknown"
)

// Reasons explaining an action, published as the throughput-recommendation-reason
// annotation. Every ActionUnknown carries one of the non-fitted reasons, so an
// operator never sees an unexplained "unknown".
const (
	ReasonFits                  = "observed_peak_within_provisioned"
	ReasonBelowProvisioned      = "observed_peak_far_below_provisioned"
	ReasonAboveProvisioned      = "observed_peak_above_provisioned"
	ReasonInstanceBandwidthCap  = "clamped_to_instance_bandwidth"
	ReasonVolumeMaxCap          = "clamped_to_gp3_maximum"
	ReasonInsufficientData      = "insufficient_samples"
	ReasonNodeTooYoung          = "node_younger_than_window"
	ReasonUnsupportedVolumeType = "unsupported_volume_type"
	ReasonMultipleVolumes       = "multiple_attached_volumes"
	ReasonNoVolume              = "no_attached_volume"
	ReasonNotEC2Node            = "not_an_ec2_node"
	ReasonNoMetrics             = "no_metrics_for_node"
)

// Settings are the tunables of the decision, resolved from config.
type Settings struct {
	// HeadroomPercent is added on top of the observed peak so the recommendation
	// leaves room above measured demand.
	HeadroomPercent int
	// StepMiBps quantizes the recommendation. It also provides the hysteresis
	// that keeps a recommendation from flapping: a decrease is only recommended
	// when the target is at least one full step below the current value.
	StepMiBps int32
	// MinThroughputMiBps is a floor below which no recommendation is made, never
	// less than the gp3 minimum of 125.
	MinThroughputMiBps int32
	// MaxThroughputMiBps is a ceiling, never more than the gp3 maximum of 1000.
	MaxThroughputMiBps int32
	// MinSamples is how many data points the observation window must contain
	// before a recommendation is trusted. Below it the decision is unknown with
	// reason insufficient_samples, which is what a node created minutes ago hits.
	MinSamples int
}

// Input is everything the decision needs about one node's volume.
type Input struct {
	// VolumeType is the EBS volume type of the node's volume.
	VolumeType string
	// CurrentThroughputMiBps and CurrentIOPS are the volume's provisioned values.
	CurrentThroughputMiBps int32
	CurrentIOPS            int32
	// PeakMiBps is the observed peak throughput of the node in MiB/s (the
	// configured quantile over the observation window, not the mean).
	PeakMiBps float64
	// Samples is how many data points backed PeakMiBps.
	Samples int
	// InstanceMaxMiBps is the instance type's EBS bandwidth ceiling in MiB/s.
	// Zero means unknown, in which case no instance clamp is applied.
	InstanceMaxMiBps float64
	// InstanceBaselineMiBps is the bandwidth the instance sustains indefinitely,
	// in MiB/s. Zero means unknown. It does not clamp the recommendation, since a
	// bursty workload can legitimately provision above it, but it is reported so
	// an operator can see when the volume is no longer the bottleneck.
	InstanceBaselineMiBps float64
}

// Decision is the outcome of one node's evaluation.
type Decision struct {
	Action string
	Reason string
	// RecommendedThroughputMiBps and RecommendedIOPS are only meaningful when
	// Action is increase or decrease. RecommendedIOPS equals CurrentIOPS unless
	// the gp3 throughput-to-IOPS ratio forces an IOPS bump as well.
	RecommendedThroughputMiBps int32
	RecommendedIOPS            int32
	// Capped reports that the observed demand asked for more throughput than the
	// recommendation grants, because a ceiling intervened. The recommendation is
	// still the best available, but the node stays throughput-bound: Reason names
	// the ceiling.
	Capped bool
}

// Decide turns one node's observation into a recommendation. It is pure: no
// clock, no I/O, no AWS. Every ceiling and ratio rule lives here so the whole
// policy is testable in isolation.
func Decide(in Input, s Settings) Decision {
	if in.VolumeType != VolumeTypeGP3 {
		return Decision{Action: ActionUnknown, Reason: ReasonUnsupportedVolumeType}
	}
	if in.Samples < s.MinSamples {
		return Decision{Action: ActionUnknown, Reason: ReasonInsufficientData}
	}
	// A NaN peak reaches here when the query returned a value for the node but
	// the underlying series had no data in the window (e.g. every scrape was a
	// counter reset). Treating it as zero would recommend the floor; it is
	// missing data, not idleness.
	if math.IsNaN(in.PeakMiBps) || math.IsInf(in.PeakMiBps, 0) || in.PeakMiBps < 0 {
		return Decision{Action: ActionUnknown, Reason: ReasonInsufficientData}
	}

	desired := in.PeakMiBps * (1 + float64(s.HeadroomPercent)/100)
	target := ceilToStep(desired, s.StepMiBps)

	floor, ceiling, capReason := bounds(s, in.InstanceMaxMiBps)
	capped := target > ceiling
	target = min(max(target, floor), ceiling)

	d := Decision{
		RecommendedThroughputMiBps: target,
		RecommendedIOPS:            requiredIOPS(target, in.CurrentIOPS),
		Capped:                     capped,
	}
	switch {
	case target > in.CurrentThroughputMiBps:
		d.Action = ActionIncrease
		d.Reason = ReasonAboveProvisioned
		if capped {
			d.Reason = capReason
		}
	case target <= in.CurrentThroughputMiBps-s.StepMiBps:
		d.Action = ActionDecrease
		d.Reason = ReasonBelowProvisioned
	default:
		d.Action = ActionNone
		d.Reason = ReasonFits
		// Nothing to change, so the recommendation is the current provisioning.
		// Reporting the computed target here would read as a pending change.
		d.RecommendedThroughputMiBps = in.CurrentThroughputMiBps
		d.RecommendedIOPS = in.CurrentIOPS
		// A volume already at the ceiling while demand exceeds it is still capped:
		// there is no action to recommend, but the node is throughput-bound and
		// that must stay visible.
		if capped {
			d.Reason = capReason
		}
	}
	return d
}

// bounds resolves the effective floor and ceiling of a recommendation: the
// configured range, tightened to the gp3 limits and to what the instance type can
// actually drive. capReason names whichever ceiling is binding, so a clamped
// recommendation can say why the node stays throughput-bound.
func bounds(s Settings, instanceMaxMiBps float64) (floor, ceiling int32, capReason string) {
	floor = max(s.MinThroughputMiBps, gp3MinThroughputMiBps)
	ceiling, capReason = int32(gp3MaxThroughputMiBps), ReasonVolumeMaxCap
	if s.MaxThroughputMiBps > 0 && s.MaxThroughputMiBps < ceiling {
		ceiling = s.MaxThroughputMiBps
	}
	// The instance clamp is checked last and reported only when it is strictly
	// tighter than the volume-side ceiling, so "clamped to instance bandwidth"
	// never appears for a node the gp3 maximum alone would have capped.
	if instanceMaxMiBps > 0 {
		if instanceCeiling := int32(math.Floor(instanceMaxMiBps)); instanceCeiling < ceiling {
			ceiling, capReason = instanceCeiling, ReasonInstanceBandwidthCap
		}
	}
	// A misconfigured range (floor above ceiling) collapses to the ceiling rather
	// than producing a recommendation outside what EBS or the instance accepts.
	if floor > ceiling {
		floor = ceiling
	}
	return floor, ceiling, capReason
}

// requiredIOPS returns the IOPS the recommended throughput needs. gp3 allows at
// most 0.25 MiB/s per provisioned IOPS, so raising throughput past IOPS/4 is
// rejected by EC2 unless IOPS is raised with it. IOPS is never recommended
// downward here: it is a separate dimension with its own demand signal, and
// lowering it as a side effect of a throughput change could throttle a
// small-random-IO workload that never shows up in a throughput metric.
func requiredIOPS(throughputMiBps, currentIOPS int32) int32 {
	needed := throughputMiBps * gp3IOPSPerMiBps
	return min(max(currentIOPS, needed, gp3MinIOPS), gp3MaxIOPS)
}

// ceilToStep rounds v up to the next multiple of step. A non-positive step means
// no quantization.
func ceilToStep(v float64, step int32) int32 {
	if step <= 0 {
		return int32(math.Ceil(v))
	}
	steps := math.Ceil(v / float64(step))
	return int32(steps) * step
}
