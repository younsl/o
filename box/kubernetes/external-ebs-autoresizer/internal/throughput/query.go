package throughput

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// bytesPerMiBQuery is the divisor that converts the byte-rate the node exporter
// counters produce into the MiB/s unit gp3 throughput is provisioned in, applied
// inside the query so the backend returns values in the final unit.
const bytesPerMiBQuery = 1 << 20

// nodeBatch is how many node names go into one query's node matcher. It bounds
// the expression size on a large cluster; the total work is the same either way,
// since each series is still read exactly once.
const nodeBatch = 200

// Query builds the two PromQL expressions the recommender evaluates. The same
// expressions run unchanged against Prometheus and Mimir: both are instant
// queries over a subquery, using only functions in the core PromQL language.
//
// Node exporter is the metric source rather than CloudWatch because throughput
// sizing needs the peak, not the mean. CloudWatch publishes EBS volume metrics at
// 1-minute granularity at best, and a workload that saturates a 125 MiB/s
// baseline for ten seconds averages out to roughly 30 MiB/s over a minute, so the
// burst that actually needs the throughput is invisible. A 15-30s scrape keeps it.
type Query struct {
	// NodeLabel is the label on the node exporter series that carries the
	// Kubernetes Node name. kube-prometheus-stack relabels it to "node"; a plain
	// node exporter scrape config usually leaves only "instance".
	NodeLabel string
	// DeviceRegex selects which block devices count toward a node's throughput,
	// matched against the device label. It must exclude virtual devices (dm-*,
	// loop*) whose IO is already counted on the underlying device.
	DeviceRegex string
	// RateWindow is the range passed to rate(). It must span at least two scrapes.
	RateWindow string
	// Lookback is how far back the observation window reaches.
	Lookback string
	// Step is the subquery resolution: how often the throughput is evaluated
	// inside the window. A step below the scrape interval adds no information and
	// multiplies the query cost.
	Step string
	// Quantile is the quantile of the per-step throughput taken as the peak. 1.0
	// is the true maximum, which a single spike can dominate; 0.99 ignores the
	// top percentile of steps.
	Quantile float64
}

// Peak returns the query for the peak throughput in MiB/s of each named node over
// the observation window.
func (q Query) Peak(nodeNames []string) string {
	return fmt.Sprintf("quantile_over_time(%s, (%s)[%s:%s]) / %d",
		strconv.FormatFloat(q.Quantile, 'f', -1, 64), q.byteRate(nodeNames), q.Lookback, q.Step, bytesPerMiBQuery)
}

// SampleCount returns the query for how many data points back each node's peak.
// It is the confidence signal: a node created an hour ago cannot support a
// recommendation drawn from a seven-day window, and without this the recommender
// would treat its short history as a genuinely quiet workload.
func (q Query) SampleCount(nodeNames []string) string {
	return fmt.Sprintf("count_over_time((%s)[%s:%s])", q.byteRate(nodeNames), q.Lookback, q.Step)
}

// Presence returns a cheap instant query counting how many node exporter disk
// series the backend holds at all, ignoring which node they belong to. It exists
// only to tell "this backend has no node exporter data" apart from "it has data
// but none of it is labelled with these node names", which is the difference
// between a missing scrape and a wrong NodeLabel. It reads no history, so it is
// orders of magnitude cheaper than the observation queries and is only issued when
// they come back empty.
func (q Query) Presence() string {
	return fmt.Sprintf("count(node_disk_read_bytes_total{device=~%s})", strconv.Quote(q.DeviceRegex))
}

// byteRate is the per-node read+write byte rate expression both observation
// queries wrap.
//
// The two-level aggregation is what keeps a shared metrics backend honest without
// asking the operator to configure a tenancy matcher. The inner sum totals a
// node's devices within one scrape target; the outer max then collapses whatever
// targets remain for that node name instead of adding them. That matters in two
// real cases:
//
//   - A backend holding several clusters, where two clusters on the same subnets
//     produce identical node names. Summing would add two unrelated nodes'
//     throughput and overstate the peak; taking the max reports the busier one.
//   - A node exporter Pod that restarted, whose old and new target labels are both
//     inside the staleness window for a few minutes. Summing would double the
//     node's throughput for that period.
func (q Query) byteRate(nodeNames []string) string {
	selector := q.selector(nodeNames)
	inner := q.NodeLabel
	// Grouping by the target as well as the node is what separates two sources for
	// the same node name. When the node name is already carried by the target label
	// there is nothing to separate, and repeating it would be a no-op.
	if q.NodeLabel != "instance" {
		inner += ", instance"
	}
	return fmt.Sprintf(
		"max by (%s) (sum by (%s) (rate(node_disk_read_bytes_total{%s}[%s]) + rate(node_disk_written_bytes_total{%s}[%s])))",
		q.NodeLabel, inner, selector, q.RateWindow, selector, q.RateWindow)
}

// selector renders the label matchers applied to both counters: the device matcher
// and, when node names are given, an exact-alternation matcher on the node label.
//
// Scoping by name is what replaces a configured tenancy matcher. The addon already
// knows every Node in its own cluster, so the backend only ever reads those series
// even when it holds many clusters, and no setting has to name a label the operator
// would have to look up.
func (q Query) selector(nodeNames []string) string {
	device := "device=~" + strconv.Quote(q.DeviceRegex)
	if len(nodeNames) == 0 {
		return device
	}
	return fmt.Sprintf("%s=~%s,%s", q.NodeLabel, strconv.Quote(nodeAlternation(nodeNames)), device)
}

// nodeAlternation builds an anchored alternation of the node names. Every name is
// escaped: a Kubernetes node name is a DNS name, and its dots would otherwise be
// regex wildcards that match unrelated series. Prometheus and Mimir both compile an
// alternation of literals into a set lookup rather than a scan, so a few hundred
// names cost no more than one.
func nodeAlternation(nodeNames []string) string {
	quoted := make([]string, 0, len(nodeNames))
	for _, name := range nodeNames {
		quoted = append(quoted, regexp.QuoteMeta(name))
	}
	return strings.Join(quoted, "|")
}
