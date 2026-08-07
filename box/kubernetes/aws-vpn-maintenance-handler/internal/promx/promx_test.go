package promx

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// vectorBody is a one-series instant vector response.
func vectorBody(value string) string {
	return `{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1750000000,"` + value + `"]}]}}`
}

// emptyVectorBody is a successful query that matched nothing.
const emptyVectorBody = `{"status":"success","data":{"resultType":"vector","result":[]}}`

// matrixBody renders samples as the range response the gate reads.
func matrixBody(samples []Sample) string {
	points := make([]string, 0, len(samples))
	for _, s := range samples {
		points = append(points, fmt.Sprintf(`[%d,"%g"]`, s.At.Unix(), s.V))
	}
	return `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[` +
		strings.Join(points, ",") + `]}]}}`
}

// promStub serves canned responses and records the queries it received.
type promStub struct {
	server  *httptest.Server
	queries []string
	paths   []string
	respond func(query string) (int, string)
}

func newStub(t *testing.T, respond func(query string) (int, string)) *promStub {
	t.Helper()
	s := &promStub{respond: respond}
	s.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		query := r.FormValue("query")
		s.queries = append(s.queries, query)
		s.paths = append(s.paths, r.URL.Path)
		code, body := s.respond(query)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(s.server.Close)
	return s
}

func (s *promStub) client(t *testing.T, headers map[string]string) *Client {
	t.Helper()
	c, err := New(Config{Endpoint: s.server.URL, Headers: headers})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	return c
}

func TestQueryReadsASingleSample(t *testing.T) {
	stub := newStub(t, func(string) (int, string) { return http.StatusOK, vectorBody("1234.5") })

	got, err := stub.client(t, nil).Query(context.Background(), "up")
	if err != nil {
		t.Fatalf("Query returned error: %v", err)
	}
	if got != 1234.5 {
		t.Fatalf("Query = %v, want 1234.5", got)
	}
}

// Tenant headers are how a Mimir query reaches the right tenant, so they must be sent.
func TestQuerySendsConfiguredHeaders(t *testing.T) {
	var seen string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = r.Header.Get("X-Scope-OrgID")
		_, _ = w.Write([]byte(vectorBody("1")))
	}))
	defer server.Close()

	c, err := New(Config{Endpoint: server.URL, Headers: map[string]string{"X-Scope-OrgID": "team-a"}})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if _, err := c.Query(context.Background(), "up"); err != nil {
		t.Fatalf("Query returned error: %v", err)
	}
	if seen != "team-a" {
		t.Fatalf("X-Scope-OrgID = %q, want team-a", seen)
	}
}

func TestQueryReportsNoData(t *testing.T) {
	stub := newStub(t, func(string) (int, string) { return http.StatusOK, emptyVectorBody })

	_, err := stub.client(t, nil).Query(context.Background(), "up")
	if !errors.Is(err, ErrNoData) {
		t.Fatalf("error = %v, want ErrNoData", err)
	}
}

// Several series means the query is missing an aggregation. Taking the first would
// gate an irreversible operation on an arbitrary series.
func TestQueryRejectsMultipleSeries(t *testing.T) {
	stub := newStub(t, func(string) (int, string) {
		return http.StatusOK, `{"status":"success","data":{"resultType":"vector","result":[
			{"metric":{"a":"1"},"value":[1750000000,"1"]},
			{"metric":{"a":"2"},"value":[1750000000,"2"]}]}}`
	})

	_, err := stub.client(t, nil).Query(context.Background(), "rate(x[5m])")
	if err == nil || !strings.Contains(err.Error(), "aggregate") {
		t.Fatalf("error = %v, want it to demand aggregation", err)
	}
}

// NaN is what Prometheus returns for an undefined expression; comparing it against a
// threshold would silently pass.
func TestQueryTreatsNaNAsNoData(t *testing.T) {
	stub := newStub(t, func(string) (int, string) { return http.StatusOK, vectorBody("NaN") })

	_, err := stub.client(t, nil).Query(context.Background(), "up")
	if !errors.Is(err, ErrNoData) {
		t.Fatalf("error = %v, want ErrNoData", err)
	}
}

func TestQueryReportsHTTPAndAPIErrors(t *testing.T) {
	tests := []struct {
		name string
		code int
		body string
		want string
	}{
		{"http error", http.StatusBadRequest, `{"status":"error","error":"parse error"}`, "400"},
		{"api error", http.StatusOK, `{"status":"error","error":"query timed out"}`, "query timed out"},
		{"unsupported type", http.StatusOK, `{"status":"success","data":{"resultType":"matrix","result":[]}}`, "instant vector"},
		{"malformed json", http.StatusOK, `{`, "decode"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub(t, func(string) (int, string) { return tc.code, tc.body })
			_, err := stub.client(t, nil).Query(context.Background(), "up")
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestQueryRangeReadsTheSeries(t *testing.T) {
	now := time.Now().Truncate(time.Minute)
	stub := newStub(t, func(string) (int, string) {
		return http.StatusOK, matrixBody([]Sample{
			{At: now.Add(-10 * time.Minute), V: 1},
			{At: now.Add(-5 * time.Minute), V: 2},
			{At: now, V: 3},
		})
	})

	got, err := stub.client(t, nil).QueryRange(context.Background(), "x", now.Add(-time.Hour), now, 5*time.Minute)
	if err != nil {
		t.Fatalf("QueryRange returned error: %v", err)
	}
	if len(got) != 3 || got[2].V != 3 || !got[0].At.Equal(now.Add(-10*time.Minute)) {
		t.Fatalf("QueryRange = %+v", got)
	}
	if stub.paths[0] != "/api/v1/query_range" {
		t.Fatalf("path = %q, want the range endpoint", stub.paths[0])
	}
}

// A gap inside the range is not a failure: the exporter may simply not have been
// scraped then, and the rest of the distribution is still usable.
func TestQueryRangeSkipsGaps(t *testing.T) {
	now := time.Now().Truncate(time.Minute)
	stub := newStub(t, func(string) (int, string) {
		return http.StatusOK, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{},"values":[` +
			fmt.Sprintf(`[%d,"NaN"],[%d,"7"]`, now.Add(-5*time.Minute).Unix(), now.Unix()) + `]}]}}`
	})

	got, err := stub.client(t, nil).QueryRange(context.Background(), "x", now.Add(-time.Hour), now, 5*time.Minute)
	if err != nil {
		t.Fatalf("QueryRange returned error: %v", err)
	}
	if len(got) != 1 || got[0].V != 7 {
		t.Fatalf("QueryRange = %+v, want only the readable point", got)
	}
}

func TestQueryRangeRejectsAnInstantResult(t *testing.T) {
	stub := newStub(t, func(string) (int, string) { return http.StatusOK, vectorBody("1") })

	_, err := stub.client(t, nil).QueryRange(context.Background(), "x", time.Now().Add(-time.Hour), time.Now(), time.Minute)
	if err == nil || !strings.Contains(err.Error(), "matrix") {
		t.Fatalf("error = %v, want it to demand a matrix", err)
	}
}

func TestNewRejectsAMissingEndpoint(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("an empty endpoint must be rejected")
	}
}

// A disabled gate must not need a client, so nothing is dialed when it is off.
func TestDisabledGateAllowsWithoutQuerying(t *testing.T) {
	gate, err := NewGate(nil, GateConfig{Enabled: false}, testLogger())
	if err != nil {
		t.Fatalf("NewGate returned error: %v", err)
	}
	a := gate.Evaluate(context.Background(), Vars{})
	if !a.Allowed {
		t.Fatal("a disabled gate must allow")
	}
	if a.Evaluated {
		t.Fatal("Evaluated must be false so callers can tell 'passed' from 'not checked'")
	}
	if gate.Enabled() {
		t.Fatal("Enabled() should be false")
	}
}

func TestNewGateRejectsIncompleteConfig(t *testing.T) {
	stub := newStub(t, func(string) (int, string) { return http.StatusOK, vectorBody("1") })
	client := stub.client(t, nil)

	if _, err := NewGate(nil, GateConfig{Enabled: true, Percentile: 20}, testLogger()); err == nil {
		t.Fatal("an enabled gate without a client must be rejected")
	}
	if _, err := NewGate(client, GateConfig{Enabled: true, Percentile: 140}, testLogger()); err == nil {
		t.Fatal("a percentile outside 0..100 must be rejected")
	}
	// Left unset, the default is what the operator gets rather than a gate that
	// compares against a zero threshold and never opens.
	gate, err := NewGate(client, GateConfig{Enabled: true}, testLogger())
	if err != nil {
		t.Fatalf("NewGate returned error: %v", err)
	}
	if gate.Percentile() != DefaultPercentile {
		t.Fatalf("Percentile() = %v, want the default %v", gate.Percentile(), DefaultPercentile)
	}
}

// rampStub answers detection and then serves a synthetic window history: values 0..99
// spread over past days, all of them inside the window, plus one current sample.
func rampStub(t *testing.T, current float64) *promStub {
	t.Helper()
	now := time.Now().Truncate(time.Minute)
	samples := make([]Sample, 0, 101)
	for i := range 100 {
		samples = append(samples, Sample{At: now.Add(-time.Duration(i+1) * time.Hour), V: float64(i)})
	}
	samples = append(samples, Sample{At: now, V: current})

	return newStub(t, func(query string) (int, string) {
		if strings.HasPrefix(query, "count(") {
			return http.StatusOK, vectorBody("1")
		}
		return http.StatusOK, matrixBody(samples)
	})
}

func quietGate(t *testing.T, stub *promStub, percentile float64) *Gate {
	t.Helper()
	gate, err := NewGate(stub.client(t, nil), GateConfig{
		Enabled: true, Percentile: percentile, OnError: OnErrorBlock,
	}, testLogger())
	if err != nil {
		t.Fatalf("NewGate returned error: %v", err)
	}
	return gate
}

// The gate's whole point: quiet means quiet for this connection, judged against its
// own history rather than a number somebody had to pick.
func TestGateAllowsInsideTheQuietPercentile(t *testing.T) {
	stub := rampStub(t, 5)
	a := quietGate(t, stub, 20).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})

	if !a.Allowed {
		t.Fatalf("5 is inside the quietest fifth of 0..99; detail: %s", a.Detail)
	}
	if !a.HasHistory || a.Samples < minSamples {
		t.Fatalf("assessment = %+v", a)
	}
	if a.Threshold < 19 || a.Threshold > 20 {
		t.Fatalf("Threshold = %v, want P20 of 0..99", a.Threshold)
	}
	if a.Rank > 10 {
		t.Fatalf("Rank = %v, want a low percentile", a.Rank)
	}
	// The query has to scope to the connection, or every tunnel would be judged by
	// the same series.
	for _, q := range stub.queries {
		if !strings.Contains(q, "vpn-a") {
			t.Fatalf("query %q is not scoped to the connection", q)
		}
	}
}

func TestGateBlocksAboveTheQuietPercentile(t *testing.T) {
	a := quietGate(t, rampStub(t, 80), 20).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})

	if a.Allowed {
		t.Fatalf("80 is nowhere near the quietest fifth of 0..99; detail: %s", a.Detail)
	}
	if !strings.Contains(a.Detail, "above the P20 target") {
		t.Fatalf("detail = %q, want it to name what was missed", a.Detail)
	}
	if a.Rank < 70 {
		t.Fatalf("Rank = %v, want it to report how busy the moment is", a.Rank)
	}
}

// Comparing a window moment against the whole day is the mistake this avoids: the
// distribution must be built from moments the replacement could actually happen in.
func TestGateJudgesAgainstWindowSamplesOnly(t *testing.T) {
	now := time.Now().Truncate(time.Minute)
	samples := make([]Sample, 0, 121)
	for i := range 60 {
		// Busy in-window history.
		samples = append(samples, Sample{At: now.Add(-time.Duration(i+1) * time.Hour), V: 1000})
	}
	for i := range 60 {
		// Idle out-of-window history, which must not drag the target down.
		samples = append(samples, Sample{At: now.Add(-time.Duration(i+1)*time.Hour - 30*time.Minute), V: 0})
	}
	samples = append(samples, Sample{At: now, V: 900})

	stub := newStub(t, func(query string) (int, string) {
		if strings.HasPrefix(query, "count(") {
			return http.StatusOK, vectorBody("1")
		}
		return http.StatusOK, matrixBody(samples)
	})
	// Only the samples on the hour count as window samples.
	inWindow := func(at time.Time) bool { return at.Minute() == now.Minute() }

	a := quietGate(t, stub, 50).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a", InWindow: inWindow})
	if !a.Allowed {
		t.Fatalf("900 is below the in-window median of 1000; detail: %s", a.Detail)
	}
	if a.Samples != 61 {
		t.Fatalf("Samples = %d, want only the in-window points", a.Samples)
	}
}

// A transfer that started three minutes ago is traffic the replacement would
// interrupt, so the peak over the recent window is what gets judged.
func TestGateUsesTheSustainedPeakNotTheLastSample(t *testing.T) {
	now := time.Now().Truncate(time.Minute)
	samples := make([]Sample, 0, 102)
	for i := range 100 {
		samples = append(samples, Sample{At: now.Add(-time.Duration(i+1) * time.Hour), V: float64(i)})
	}
	samples = append(samples,
		Sample{At: now.Add(-3 * time.Minute), V: 95},
		Sample{At: now, V: 1},
	)
	stub := newStub(t, func(query string) (int, string) {
		if strings.HasPrefix(query, "count(") {
			return http.StatusOK, vectorBody("1")
		}
		return http.StatusOK, matrixBody(samples)
	})

	a := quietGate(t, stub, 20).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})
	if a.Allowed {
		t.Fatalf("a burst three minutes ago must still count; detail: %s", a.Detail)
	}
	if a.Current != 95 {
		t.Fatalf("Current = %v, want the peak over the last %s", a.Current, sustain)
	}
}

// A silent exporter reads exactly like an idle tunnel, and that is the one wrong
// answer that leads to a replacement during a peak.
func TestGateBlocksWhenNothingWasScrapedRecently(t *testing.T) {
	now := time.Now().Truncate(time.Minute)
	samples := make([]Sample, 0, 100)
	for i := range 100 {
		samples = append(samples, Sample{At: now.Add(-time.Duration(i+1) * time.Hour), V: float64(i)})
	}
	stub := newStub(t, func(query string) (int, string) {
		if strings.HasPrefix(query, "count(") {
			return http.StatusOK, vectorBody("1")
		}
		return http.StatusOK, matrixBody(samples)
	})

	a := quietGate(t, stub, 20).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})
	if a.Allowed {
		t.Fatalf("stale samples must not read as quiet; detail: %s", a.Detail)
	}
	if !strings.Contains(a.Detail, "not reporting") {
		t.Fatalf("detail = %q, want it to blame the exporter", a.Detail)
	}
}

// Too few window samples make a percentile meaningless, so it is an onError case
// rather than a verdict.
func TestGateBlocksWhenTheHistoryIsTooThin(t *testing.T) {
	now := time.Now().Truncate(time.Minute)
	samples := []Sample{{At: now.Add(-time.Hour), V: 1}, {At: now, V: 1}}
	stub := newStub(t, func(query string) (int, string) {
		if strings.HasPrefix(query, "count(") {
			return http.StatusOK, vectorBody("1")
		}
		return http.StatusOK, matrixBody(samples)
	})

	a := quietGate(t, stub, 20).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})
	if a.Allowed || a.HasHistory {
		t.Fatalf("two samples cannot decide a percentile; assessment = %+v", a)
	}
	if !strings.Contains(a.Detail, "sample(s) fall inside past maintenance windows") {
		t.Fatalf("detail = %q", a.Detail)
	}
}

// Holding out for the calmest fifth stops being the safer choice once AWS is about to
// pick the moment itself.
func TestGateRelaxesToTheMedianWhenUrgent(t *testing.T) {
	stub := rampStub(t, 40)
	gate := quietGate(t, stub, 20)

	if a := gate.Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"}); a.Allowed {
		t.Fatalf("40 is above P20 of 0..99; detail: %s", a.Detail)
	}
	a := gate.Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a", Urgent: true})
	if !a.Allowed {
		t.Fatalf("40 is below the median, which urgency relaxes to; detail: %s", a.Detail)
	}
	if !strings.Contains(a.Detail, "relaxed") {
		t.Fatalf("detail = %q, want the relaxation stated", a.Detail)
	}
}

// While the gate holds, an approver needs to know when the next opportunity is
// expected rather than only that this moment failed.
func TestGateRecommendsTheCalmestSlot(t *testing.T) {
	now := time.Now().Truncate(time.Minute)
	samples := make([]Sample, 0, 121)
	// Two clock times, one habitually calm, each seen on several days.
	for day := 1; day <= 30; day++ {
		base := now.AddDate(0, 0, -day)
		samples = append(samples,
			Sample{At: base, V: 900},
			Sample{At: base.Add(-time.Hour), V: 10},
		)
	}
	samples = append(samples, Sample{At: now, V: 900})
	stub := newStub(t, func(query string) (int, string) {
		if strings.HasPrefix(query, "count(") {
			return http.StatusOK, vectorBody("1")
		}
		return http.StatusOK, matrixBody(samples)
	})

	loc := time.FixedZone("KST", 9*3600)
	a := quietGate(t, stub, 20).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a", Loc: loc})
	if a.Allowed {
		t.Fatalf("900 is the busy slot; detail: %s", a.Detail)
	}
	want := now.Add(-time.Hour).In(loc).Truncate(5 * time.Minute).Format("15:04")
	if a.RecommendedAt != want {
		t.Fatalf("RecommendedAt = %q, want the calm slot %q", a.RecommendedAt, want)
	}
	if !strings.Contains(a.Detail, "usually calmest around") || !strings.Contains(a.Detail, "KST") {
		t.Fatalf("detail = %q, want the recommendation in the window's timezone", a.Detail)
	}
}

// An unreadable metric source is not evidence that the tunnel is quiet.
func TestGateBlocksOnQueryFailureByDefault(t *testing.T) {
	stub := newStub(t, func(string) (int, string) { return http.StatusInternalServerError, "boom" })
	a := quietGate(t, stub, 20).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})

	if a.Allowed {
		t.Fatal("a failed query must block when onError is block")
	}
	if !a.Evaluated || !strings.Contains(a.Detail, "held until metrics are readable") {
		t.Fatalf("assessment = %+v", a)
	}
}

func TestGateAllowsOnQueryFailureWhenConfigured(t *testing.T) {
	stub := newStub(t, func(string) (int, string) { return http.StatusInternalServerError, "boom" })
	gate, _ := NewGate(stub.client(t, nil), GateConfig{
		Enabled: true, Percentile: 20, OnError: OnErrorAllow,
	}, testLogger())

	a := gate.Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})
	if !a.Allowed {
		t.Fatal("onError allow must fall through when metrics are unavailable")
	}
	if !strings.Contains(a.Detail, "skipped") {
		t.Fatalf("detail = %q", a.Detail)
	}
}

// Detection is cached: probing on every pass would multiply queries for an answer
// that does not change while the exporter stays the same.
func TestDetectionHappensOnlyOnce(t *testing.T) {
	stub := rampStub(t, 5)
	gate := quietGate(t, stub, 20)

	for range 3 {
		gate.Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})
	}

	probes := 0
	for _, q := range stub.queries {
		if strings.HasPrefix(q, "count(") {
			probes++
		}
	}
	if probes != 1 {
		t.Fatalf("expected exactly one detection probe, got %d", probes)
	}
}

// No known metric is an onError case, not a silent pass: without a metric there is no
// evidence the tunnel is quiet.
func TestGateBlocksWhenNoMetricIsFound(t *testing.T) {
	stub := newStub(t, func(string) (int, string) { return http.StatusOK, emptyVectorBody })
	a := quietGate(t, stub, 20).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})

	if a.Allowed {
		t.Fatal("an undetectable metric must block")
	}
	if !strings.Contains(a.Detail, "metric discovery") {
		t.Fatalf("detail = %q, want it to name discovery as the failure", a.Detail)
	}
}

// Detection walks the profiles in order, so an exporter further down the list still
// wins when the ones before it have no data.
func TestDetectionTriesEveryProfile(t *testing.T) {
	stub := newStub(t, func(query string) (int, string) {
		switch {
		case strings.HasPrefix(query, "count(aws_ec2_vpn_tunnel_data_out_sum"):
			return http.StatusOK, emptyVectorBody
		case strings.HasPrefix(query, "count("):
			return http.StatusOK, vectorBody("2")
		default:
			return http.StatusOK, matrixBody([]Sample{{At: time.Now(), V: 1}})
		}
	})
	quietGate(t, stub, 20).Evaluate(context.Background(), Vars{VPNConnectionID: "vpn-a"})

	probes := 0
	for _, q := range stub.queries {
		if strings.HasPrefix(q, "count(") {
			probes++
		}
	}
	if probes < 2 {
		t.Fatalf("expected the first profile to be rejected and the next tried, probes = %d", probes)
	}
}

func TestProfileQueryShape(t *testing.T) {
	v := Vars{VPNConnectionID: "vpn-a"}

	oneWay := Profile{Metric: "out", VPNLabel: "vpn"}
	if got, want := oneWay.TrafficQuery(v), `(sum(avg_over_time(out{vpn="vpn-a"}[5m])) or vector(0))`; got != want {
		t.Fatalf("TrafficQuery = %q, want %q", got, want)
	}

	// Both directions count, and a missing one must not empty the whole expression.
	bothWays := Profile{Metric: "out", MetricIn: "in", VPNLabel: "vpn"}
	got := bothWays.TrafficQuery(v)
	if !strings.Contains(got, `out{vpn="vpn-a"}`) || !strings.Contains(got, `in{vpn="vpn-a"}`) ||
		strings.Count(got, "or vector(0)") != 2 {
		t.Fatalf("TrafficQuery = %q", got)
	}

	// rate() on a gauge would be meaningless, so the counter case must differ.
	counter := Profile{Metric: "out", VPNLabel: "vpn", Counter: true}
	if got, want := counter.TrafficQuery(v), `(sum(rate(out{vpn="vpn-a"}[5m])) or vector(0))`; got != want {
		t.Fatalf("counter TrafficQuery = %q, want %q", got, want)
	}

	if !strings.Contains(oneWay.String(), "gauge") || !strings.Contains(counter.String(), "counter") {
		t.Fatal("String() should state the metric kind")
	}
}

func TestPercentileInterpolatesAndRankReportsPosition(t *testing.T) {
	h := history{values: []float64{0, 10, 20, 30, 40, 50, 60, 70, 80, 90}}

	for p, want := range map[float64]float64{0: 0, 50: 45, 100: 90} {
		if got := h.percentile(p); got != want {
			t.Fatalf("percentile(%v) = %v, want %v", p, got, want)
		}
	}
	if got := h.rank(45); got != 50 {
		t.Fatalf("rank(45) = %v, want 50", got)
	}
	// An empty distribution has no position to report, and must not panic.
	if got := (history{}).percentile(20); got != 0 {
		t.Fatalf("percentile of an empty history = %v, want 0", got)
	}
}

// One quiet day is luck; a recommendation is about a habit, so a slot seen once is
// not offered.
func TestQuietestIgnoresSlotsSeenOnce(t *testing.T) {
	now := time.Now().Truncate(time.Minute)
	h := newHistory([]Sample{
		{At: now, V: 1},
		{At: now.AddDate(0, 0, -1).Add(time.Hour), V: 500},
		{At: now.AddDate(0, 0, -2).Add(time.Hour), V: 500},
	}, nil, time.UTC)

	at, level, found := h.quietest()
	if !found {
		t.Fatal("a slot seen on two days must be offered")
	}
	if level != 500 || at != now.Add(time.Hour).In(time.UTC).Truncate(step).Format("15:04") {
		t.Fatalf("quietest = %q at %v, want the repeated slot", at, level)
	}
}

func TestParseOnError(t *testing.T) {
	for input, want := range map[string]OnError{
		"":      OnErrorBlock,
		"block": OnErrorBlock,
		"allow": OnErrorAllow,
		"ALLOW": OnErrorAllow,
	} {
		got, err := ParseOnError(input)
		if err != nil {
			t.Fatalf("ParseOnError(%q) returned error: %v", input, err)
		}
		if got != want {
			t.Fatalf("ParseOnError(%q) = %q, want %q", input, got, want)
		}
	}
	if _, err := ParseOnError("maybe"); err == nil {
		t.Fatal("an unknown onError value must be rejected")
	}
}

func TestFormatValue(t *testing.T) {
	for in, want := range map[float64]string{
		0: "0", 12.5: "12.50", 1500: "1.50k", 2_500_000: "2.50M", 3_000_000_000: "3.00G",
	} {
		if got := formatValue(in); got != want {
			t.Fatalf("formatValue(%v) = %q, want %q", in, got, want)
		}
	}
}

func testLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}
