package throughput

import (
	"math"
	"time"
)

// Fixed policy. These were configuration once and are constants now: every one of
// them is either an AWS limit, a value derived from how node exporter works, or a
// judgement call that does not vary per cluster. Exposing them as settings only
// created ways to configure the recommender into producing nothing.
const (
	// AnnotationPrefix is the prefix of every annotation key written on a Node. A
	// single DNS label is a valid annotation key prefix, so this needs no domain.
	// It is a constant because the keys are this addon's published interface:
	// changing the prefix orphans every annotation already on every Node, which is
	// not a per-install decision.
	AnnotationPrefix = "external-ebs-autoresizer"

	// deviceRegex selects which block devices count toward a node's throughput. It
	// covers every device naming AWS produces (NVMe on Nitro, xvd and sd
	// elsewhere) and excludes dm-*, loop*, and md*, whose IO is already counted on
	// the underlying device.
	deviceRegex = "nvme[0-9]+n[0-9]+|xvd[a-z]+|sd[a-z]+"

	// rateWindow is the range passed to rate(). It must span at least two scrapes,
	// and 1m covers every common scrape interval (15s, 30s, 60s).
	rateWindow = "1m"

	// queryStep is the subquery resolution. Below the scrape interval it adds no
	// information and multiplies query cost; above it, bursts start averaging away,
	// which is the whole failure this feature exists to avoid.
	queryStep = "1m"

	// quantile is the quantile of per-step throughput taken as the peak. 1.0 would
	// let a single spike set the recommendation for the whole window.
	quantile = 0.99

	// headroomPercent is added on top of the observed peak.
	headroomPercent = 30

	// stepMiBps quantizes the recommendation, and is the hysteresis that keeps it
	// from flapping: a decrease needs a full step of slack. 125 is the gp3 baseline
	// throughput, so every recommendation is a whole number of baselines.
	stepMiBps = 125

	// minSampleCoverage is the fraction of the observation window that must
	// actually hold data before a recommendation is trusted.
	//
	// This is a fraction rather than a sample count because the two are not
	// independent: a 7d window at a 1m step holds 10080 points, but a 12h window
	// holds 720. A fixed count of 1000 would silently make every short window
	// permanently untrustworthy. 0.3 of a 7d window is about 2 days of history.
	minSampleCoverage = 0.3

	// queryTimeout bounds each query. It is well above the other sinks' timeouts
	// because a multi-day subquery over every node is genuinely expensive on both
	// Prometheus and Mimir.
	queryTimeout = 60 * time.Second
)

// QueryTimeout is the per-query timeout the recommender uses. Exported so the
// process can build its metrics client with the same bound.
func QueryTimeout() time.Duration { return queryTimeout }

// Config is the recommender's operator-facing configuration: only the values a
// cluster genuinely differs on. Everything else is fixed policy above.
type Config struct {
	// MetricNodeNameLabel is the metric label carrying the Kubernetes node name.
	// kube-prometheus-stack relabels it to "node"; a plain node exporter scrape
	// leaves only "instance". There is no default that is right for both.
	MetricNodeNameLabel string
	// Lookback is how far back the observation window reaches, as a Prometheus
	// duration. It varies because it is bounded by the backend's retention.
	Lookback string
	// LookbackDuration is Lookback parsed, used to derive how many data points a
	// full window holds.
	LookbackDuration time.Duration
	// DryRun computes and reports recommendations without writing any annotation.
	DryRun bool
}

// query builds the PromQL for this configuration.
func (c Config) query() Query {
	return Query{
		NodeLabel:   c.MetricNodeNameLabel,
		DeviceRegex: deviceRegex,
		RateWindow:  rateWindow,
		Lookback:    c.Lookback,
		Step:        queryStep,
		Quantile:    quantile,
	}
}

// settings builds the decision tunables for this configuration, deriving the
// minimum sample count from the window length so the confidence gate scales with
// whatever lookback the operator chose.
func (c Config) settings() Settings {
	return Settings{
		HeadroomPercent:    headroomPercent,
		StepMiBps:          stepMiBps,
		MinThroughputMiBps: gp3MinThroughputMiBps,
		MaxThroughputMiBps: gp3MaxThroughputMiBps,
		MinSamples:         minSamples(c.LookbackDuration),
	}
}

// minNodeAge is how old a Node must be before it is worth querying at all.
//
// It is derived from the same fraction as the sample gate, which is what makes the
// filter free of accuracy loss: a node younger than this cannot possibly hold
// minSamples data points, so querying it can only ever produce
// insufficient_samples. The converse does not hold, so the sample gate still runs
// for every node that passes this one: an old node whose node exporter was down for
// days has the age but not the history.
func (c Config) minNodeAge() time.Duration {
	return time.Duration(float64(c.LookbackDuration) * minSampleCoverage)
}

// minSamples returns how many data points the window must hold to be trusted:
// minSampleCoverage of the points a fully populated window would contain. It is
// never below 2, since a single point cannot describe a peak.
func minSamples(lookback time.Duration) int {
	step := time.Minute // queryStep
	if lookback <= 0 {
		return 2
	}
	full := float64(lookback) / float64(step)
	return max(int(math.Ceil(full*minSampleCoverage)), 2)
}

// Window is the human-readable observation window, written to the annotation so a
// reader knows which lookback and quantile produced the numbers.
func (c Config) Window() string {
	return c.Lookback + "/p99"
}
