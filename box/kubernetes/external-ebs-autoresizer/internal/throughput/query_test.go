package throughput

import (
	"strconv"
	"strings"
	"testing"
)

func testQuery() Query {
	return Query{
		NodeLabel:   "node",
		DeviceRegex: "nvme[0-9]+n[0-9]+",
		RateWindow:  "1m",
		Lookback:    "7d",
		Step:        "1m",
		Quantile:    0.99,
	}
}

// testNodes are two node names in the DNS form EKS produces.
var testNodes = []string{"ip-10-0-1-5.ap-northeast-2.compute.internal", "ip-10-0-2-7.ap-northeast-2.compute.internal"}

func TestQueryPeak(t *testing.T) {
	want := `quantile_over_time(0.99, (max by (node) (sum by (node, instance) ` +
		`(rate(node_disk_read_bytes_total{node=~"ip-10-0-1-5\\.ap-northeast-2\\.compute\\.internal|ip-10-0-2-7\\.ap-northeast-2\\.compute\\.internal",device=~"nvme[0-9]+n[0-9]+"}[1m]) + ` +
		`rate(node_disk_written_bytes_total{node=~"ip-10-0-1-5\\.ap-northeast-2\\.compute\\.internal|ip-10-0-2-7\\.ap-northeast-2\\.compute\\.internal",device=~"nvme[0-9]+n[0-9]+"}[1m]))))[7d:1m]) / 1048576`
	if got := testQuery().Peak(testNodes); got != want {
		t.Errorf("Peak() =\n%s\nwant\n%s", got, want)
	}
}

func TestQuerySampleCount(t *testing.T) {
	got := testQuery().SampleCount(testNodes)
	if !strings.HasPrefix(got, "count_over_time((max by (node) (sum by (node, instance) (rate(node_disk_read_bytes_total{node=~") {
		t.Errorf("SampleCount() = %s, want the same expression wrapped in count_over_time", got)
	}
	if !strings.HasSuffix(got, "[7d:1m])") {
		t.Errorf("SampleCount() = %s, want the same window as the peak query", got)
	}
	// The confidence signal must count the same series the peak came from, or it is
	// counting something else.
	if !strings.Contains(got, testQuery().byteRate(testNodes)) {
		t.Errorf("SampleCount() = %s, want it to wrap the peak's byte-rate expression", got)
	}
}

func TestQueryScopesToTheClusterNodes(t *testing.T) {
	// Scoping by the node names the addon already knows is what removes the need
	// for a configured tenancy matcher: a backend shared by several clusters only
	// reads the series belonging to this one.
	got := testQuery().Peak(testNodes)
	if strings.Count(got, `node=~"`) != 2 {
		t.Errorf("Peak() = %s, want the node matcher on both counters", got)
	}
	// Node names are DNS names, so their dots must be escaped or they would be
	// regex wildcards matching unrelated series.
	if strings.Contains(got, "ip-10-0-1-5.ap-northeast-2") {
		t.Errorf("Peak() = %s, want the dots in node names escaped", got)
	}

	// With no names the query falls back to the device matcher alone, which is what
	// an empty cluster produces.
	bare := testQuery().Peak(nil)
	if strings.Contains(bare, "node=~") {
		t.Errorf("Peak(nil) = %s, want no node matcher", bare)
	}
}

func TestQueryTakesTheMaxAcrossDuplicateTargets(t *testing.T) {
	// Two sources for one node name must not be added together. That happens when a
	// backend holds two clusters whose node names collide, and for a few minutes
	// after a node exporter Pod restarts while both target labels are still inside
	// the staleness window. Summing would double the node's throughput.
	got := testQuery().byteRate(testNodes)
	if !strings.HasPrefix(got, "max by (node) (sum by (node, instance) (") {
		t.Errorf("byteRate() = %s, want an inner per-target sum under an outer max", got)
	}
}

func TestQueryGroupsByNodeAloneWhenTheNodeLabelIsTheTarget(t *testing.T) {
	// With nodeLabel=instance there is no second label to separate targets by, and
	// repeating it would be a no-op that only makes the query harder to read.
	q := testQuery()
	q.NodeLabel = "instance"
	got := q.byteRate(testNodes)
	if !strings.HasPrefix(got, "max by (instance) (sum by (instance) (") {
		t.Errorf("byteRate() = %s, want grouping by instance alone", got)
	}
}

func TestQueryPresenceReadsNoHistory(t *testing.T) {
	// The presence check exists to be cheap: it must not carry a range, a subquery,
	// or a node matcher, since it runs precisely when the scoped query found nothing.
	got := testQuery().Presence()
	// No range selector, no subquery, no node matcher. The device regex legitimately
	// contains brackets, so the check is for a range after a selector rather than
	// for a bracket anywhere.
	for _, unwanted := range []string{"}[", ":1m]", "quantile_over_time", "count_over_time", "node=~"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("Presence() = %s, want no %q", got, unwanted)
		}
	}
	if !strings.HasPrefix(got, "count(node_disk_read_bytes_total{device=~") {
		t.Errorf("Presence() = %s, want a bare count of the disk series", got)
	}
}

func TestQueryQuantileIsNotWrittenInExponentialNotation(t *testing.T) {
	// A quantile formatted as "1e-04" is still valid PromQL, but a 0.999 rendered
	// as "0.999" is what an operator expects to see in the logged query, and %v on
	// a float64 does not guarantee it.
	q := testQuery()
	q.Quantile = 0.999
	if !strings.Contains(q.Peak(testNodes), "quantile_over_time(0.999,") {
		t.Errorf("Peak() = %s, want the quantile rendered as 0.999", q.Peak(testNodes))
	}
	q.Quantile = 1
	if !strings.Contains(q.Peak(testNodes), "quantile_over_time(1,") {
		t.Errorf("Peak() = %s, want the quantile rendered as 1", q.Peak(testNodes))
	}
}

func TestQueryDeviceRegexCannotBreakOutOfTheStringLiteral(t *testing.T) {
	// The device matcher is a package constant now, but it is still interpolated
	// into a string literal, so the escaping stays under test: a future change to
	// the constant must not be able to append expression text to every query.
	q := testQuery()
	q.DeviceRegex = `nvme.+" or up{job="x`
	got := q.Peak(testNodes)
	if !strings.Contains(got, strconv.Quote(q.DeviceRegex)) {
		t.Errorf("Peak() = %s, want the regex quoted and escaped", got)
	}
}

func TestNodeAlternationEscapesEveryName(t *testing.T) {
	got := nodeAlternation([]string{"a.b", "c+d"})
	if got != `a\.b|c\+d` {
		t.Errorf("nodeAlternation() = %s, want every metacharacter escaped", got)
	}
}
