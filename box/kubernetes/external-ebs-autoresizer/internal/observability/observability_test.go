package observability

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func TestMetricsObservations(t *testing.T) {
	m := NewMetrics()
	m.ObserveResize(true, "default")
	m.ObserveResize(false, "db")
	m.ObserveResize(true, "default")
	m.ObserveError("measure")
	m.ObserveReconcile()
	m.ObserveSkip("cooldown", "default")
	m.ObserveSkip("max_size", "db")
	m.ObserveSkip("max_size", "db")
	m.ObserveUsage("i-1", "/dev/xvda", "vol-1", "web-1", 73)
	m.ObserveVolumeSize("i-1", "/dev/xvda", "vol-1", "web-1", 100)
	m.ObserveVolumeSize("i-1", "/dev/xvda", "vol-1", "web-1", 110)
	m.ObservePolicyInstances(map[string]int{"default": 3, "db": 2})

	if got := testutil.ToFloat64(m.resizeTotal.WithLabelValues("success", "default")); got != 2 {
		t.Errorf("resize success = %v, want 2", got)
	}
	if got := testutil.ToFloat64(m.resizeTotal.WithLabelValues("failure", "db")); got != 1 {
		t.Errorf("resize failure = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.errorTotal.WithLabelValues("measure")); got != 1 {
		t.Errorf("error measure = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.skipTotal.WithLabelValues("cooldown", "default")); got != 1 {
		t.Errorf("skip cooldown = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.skipTotal.WithLabelValues("max_size", "db")); got != 2 {
		t.Errorf("skip max_size = %v, want 2", got)
	}
	if got := testutil.ToFloat64(m.reconcileTotal); got != 1 {
		t.Errorf("reconcile total = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.usage.WithLabelValues("i-1", "/dev/xvda", "vol-1", "web-1")); got != 73 {
		t.Errorf("usage = %v, want 73", got)
	}
	if got := testutil.ToFloat64(m.volumeSize.WithLabelValues("i-1", "/dev/xvda", "vol-1", "web-1")); got != 110 {
		t.Errorf("volume size = %v, want 110 (latest observation wins)", got)
	}
	if got := testutil.ToFloat64(m.policyInstances.WithLabelValues("db")); got != 2 {
		t.Errorf("policy_instances{db} = %v, want 2", got)
	}
}

func TestMetricsNodeThroughputObservations(t *testing.T) {
	m := NewMetrics()
	m.ObserveNodeThroughput("ip-10-0-1-5", "i-1", "vol-1", 125, 287.5, 375)
	m.ObserveRecommendation("increase", "observed_peak_above_provisioned")
	m.ObserveRecommendation("increase", "observed_peak_above_provisioned")
	m.ObserveRecommendation("none", "observed_peak_within_provisioned")

	labels := []string{"ip-10-0-1-5", "i-1", "vol-1"}
	if got := testutil.ToFloat64(m.nodeCurrentMiBps.WithLabelValues(labels...)); got != 125 {
		t.Errorf("current throughput = %v, want 125", got)
	}
	if got := testutil.ToFloat64(m.nodePeakMiBps.WithLabelValues(labels...)); got != 287.5 {
		t.Errorf("observed peak = %v, want 287.5", got)
	}
	if got := testutil.ToFloat64(m.nodeRecommendedMiBps.WithLabelValues(labels...)); got != 375 {
		t.Errorf("recommended throughput = %v, want 375", got)
	}
	if got := testutil.ToFloat64(m.recommendationTotal.WithLabelValues("increase", "observed_peak_above_provisioned")); got != 2 {
		t.Errorf("increase recommendations = %v, want 2", got)
	}
	if got := testutil.ToFloat64(m.recommendationTotal.WithLabelValues("none", "observed_peak_within_provisioned")); got != 1 {
		t.Errorf("none recommendations = %v, want 1", got)
	}

	// A terminated node's last reading must not stay exported: under Karpenter the
	// node set turns over constantly, and a stale gauge reads as a live node.
	m.ResetNodeThroughput()
	if got := testutil.CollectAndCount(m.nodeCurrentMiBps); got != 0 {
		t.Errorf("current throughput series after reset = %d, want 0", got)
	}
	if got := testutil.CollectAndCount(m.nodePeakMiBps); got != 0 {
		t.Errorf("observed peak series after reset = %d, want 0", got)
	}
	if got := testutil.CollectAndCount(m.nodeRecommendedMiBps); got != 0 {
		t.Errorf("recommended series after reset = %d, want 0", got)
	}
	// Counters survive the reset: they are cumulative across passes.
	if got := testutil.ToFloat64(m.recommendationTotal.WithLabelValues("none", "observed_peak_within_provisioned")); got != 1 {
		t.Errorf("recommendation counter after reset = %v, want it preserved", got)
	}
}

func TestMetricsThroughputApply(t *testing.T) {
	m := NewMetrics()
	m.ObserveThroughputApply("applied")
	m.ObserveThroughputApply("applied")
	m.ObserveThroughputApply("fallback_size_only")
	m.ObserveThroughputApplySkip("stale")
	m.ObserveThroughputApplySkip("not_increase")

	if got := testutil.ToFloat64(m.throughputApplyTotal.WithLabelValues("applied")); got != 2 {
		t.Errorf("throughput_apply_total{applied} = %v, want 2", got)
	}
	if got := testutil.ToFloat64(m.throughputApplyTotal.WithLabelValues("fallback_size_only")); got != 1 {
		t.Errorf("throughput_apply_total{fallback_size_only} = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.throughputApplySkipTotal.WithLabelValues("stale")); got != 1 {
		t.Errorf("throughput_apply_skip_total{stale} = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.throughputApplySkipTotal.WithLabelValues("not_increase")); got != 1 {
		t.Errorf("throughput_apply_skip_total{not_increase} = %v, want 1", got)
	}
}

func TestMetricsRecommenderReconcile(t *testing.T) {
	m := NewMetrics()
	m.ObserveRecommenderReconcile()
	m.ObserveRecommenderReconcile()
	if got := testutil.ToFloat64(m.recommenderReconcileTotal); got != 2 {
		t.Errorf("recommender_reconcile_total = %v, want 2", got)
	}
}

func TestHealthReadiness(t *testing.T) {
	h := NewHealth()
	if h.ready.Load() {
		t.Error("new Health should start not-ready")
	}
	h.SetReady(true)
	if !h.ready.Load() {
		t.Error("SetReady(true) did not flip readiness")
	}
}

func TestHealthServeEndpoints(t *testing.T) {
	h := NewHealth()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const port = 18099
	go func() { _ = h.Serve(ctx, port) }()
	waitForListener(t, port)

	// Liveness always 200.
	if code := getStatus(t, "http://127.0.0.1:18099/healthz"); code != http.StatusOK {
		t.Errorf("/healthz = %d, want 200", code)
	}
	// Readiness 503 until ready.
	if code := getStatus(t, "http://127.0.0.1:18099/readyz"); code != http.StatusServiceUnavailable {
		t.Errorf("/readyz (not ready) = %d, want 503", code)
	}
	h.SetReady(true)
	if code := getStatus(t, "http://127.0.0.1:18099/readyz"); code != http.StatusOK {
		t.Errorf("/readyz (ready) = %d, want 200", code)
	}
}

func TestMetricsServeEndpoint(t *testing.T) {
	m := NewMetrics()
	m.ObserveReconcile()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	const port = 18098
	go func() { _ = m.Serve(ctx, port) }()
	waitForListener(t, port)

	if code := getStatus(t, "http://127.0.0.1:18098/metrics"); code != http.StatusOK {
		t.Errorf("/metrics = %d, want 200", code)
	}
}

func waitForListener(t *testing.T, port int) {
	t.Helper()
	url := "http://127.0.0.1:" + itoa(port) + "/healthz"
	for i := 0; i < 50; i++ {
		if resp, err := http.Get(url); err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func getStatus(t *testing.T, url string) int {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
