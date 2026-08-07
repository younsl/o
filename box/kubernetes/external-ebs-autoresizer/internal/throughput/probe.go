package throughput

import (
	"context"
	"math"
	"time"
)

// Probe is the outcome of the one-time startup metrics check. It exists because
// connectivity alone does not mean the recommender will work: the preflight
// proves the backend answers, while this proves the configured node label and the
// generated query actually return this cluster's nodes. The common
// misconfiguration (a metricNodeNameLabel of "node" against a node exporter that only
// carries "instance") passes every connectivity check and yields nothing.
type Probe struct {
	// Query is the expression that was evaluated, scoped to the first batch of
	// this cluster's node names. It is the query an operator pastes into Grafana.
	Query string
	// ClusterNodes is how many Nodes the cluster has.
	ClusterNodes int
	// EligibleNodes is how many of them are old enough to hold enough history and
	// are therefore queried at all.
	EligibleNodes int
	// Series is how many series the query returned.
	Series int
	// Nodes is how many of those carried the configured node label. A gap between
	// Series and Nodes means the node label is wrong for this cluster.
	Nodes int
	// Dropped is Series minus Nodes.
	Dropped int
	// BackendSeries is how many node exporter disk series the backend holds
	// regardless of node name, filled in only when the scoped query returned
	// nothing. A non-zero value there means the data exists but is not labelled
	// with these node names, which is a different fix from a missing scrape.
	BackendSeries int
	// Latency is how long the observation query took, which is the real cost signal
	// for the interval: a multi-day subquery is the most expensive query the addon
	// issues.
	Latency time.Duration
	// MaxNode and MaxPeakMiBps are the busiest node the probe saw, so the startup
	// log carries a value an operator can sanity-check against a dashboard.
	// MaxNode is empty when no node returned a finite value.
	MaxNode      string
	MaxPeakMiBps float64
}

// Probe lists the cluster's Nodes and runs the peak query for the first batch of
// them, then summarizes the result. It is read-only and never mutates anything.
// Errors are returned rather than logged so the caller decides how loud to be; the
// recommender starts either way, because a backend that is briefly unavailable at
// startup is not a reason to give up on every later pass.
//
// Only the first batch is queried. The point is to prove the query shape works
// against this backend, and doing that does not require paying for the whole
// cluster before the first reconcile pass.
func (r *Recommender) Probe(ctx context.Context) (Probe, error) {
	var p Probe

	nodeList, err := r.nodes.List(ctx, "")
	if err != nil {
		return p, err
	}
	p.ClusterNodes = len(nodeList)
	names, _ := r.splitByAge(nodeList)
	p.EligibleNodes = len(names)
	if len(names) > nodeBatch {
		names = names[:nodeBatch]
	}
	p.Query = r.query.Peak(names)
	if len(names) == 0 {
		return p, nil
	}

	start := time.Now()
	samples, err := r.prom.Query(ctx, p.Query)
	p.Latency = time.Since(start)
	if err != nil {
		return p, err
	}

	p.Series = len(samples)
	for _, s := range samples {
		name := s.Labels[r.query.NodeLabel]
		if name == "" {
			continue
		}
		p.Nodes++
		// NaN and Inf never win the comparison, so the reported peak is always a
		// number an operator can compare against a dashboard.
		if math.IsNaN(s.Value) || math.IsInf(s.Value, 0) {
			continue
		}
		if p.MaxNode == "" || s.Value > p.MaxPeakMiBps {
			p.MaxNode, p.MaxPeakMiBps = name, s.Value
		}
	}
	p.Dropped = p.Series - p.Nodes

	// Scoping the query by node name means a wrong node label yields no series at
	// all rather than series that cannot be attributed, so the two failures look
	// identical from here. One cheap instant query separates them: it reads no
	// history and is only issued when there is already nothing to report.
	if p.Series == 0 {
		p.BackendSeries = r.countBackendSeries(ctx)
	}
	return p, nil
}

// countBackendSeries returns how many node exporter disk series the backend holds
// at all, or 0 when the query fails. A failure here is not worth surfacing: this
// runs only to improve a diagnostic that is already being logged.
func (r *Recommender) countBackendSeries(ctx context.Context) int {
	samples, err := r.prom.Query(ctx, r.query.Presence())
	if err != nil || len(samples) == 0 {
		return 0
	}
	// count() returns a single scalar-shaped series, so the first sample is the
	// answer; the max guards against a backend returning more than one.
	value := samples[0].Value
	for _, s := range samples[1:] {
		value = math.Max(value, s.Value)
	}
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0
	}
	return int(value)
}
