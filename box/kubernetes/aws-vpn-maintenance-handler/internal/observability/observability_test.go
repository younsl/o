package observability

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"
)

func sample() TunnelSample {
	return TunnelSample{
		ConnectionID:     "vpn-a",
		ConnectionName:   "prod-dc",
		TunnelIP:         "203.0.113.10",
		Up:               true,
		Routes:           12,
		Pending:          true,
		Deadline:         time.Unix(1785000000, 0),
		LifecycleControl: true,
	}
}

func TestSetTunnelPublishesEveryGauge(t *testing.T) {
	m := NewMetrics()
	m.SetTunnel(sample())

	labels := []string{"vpn-a", "prod-dc", "203.0.113.10"}
	for name, want := range map[string]float64{
		"aws_vpn_maintenance_handler_tunnel_up":                           1,
		"aws_vpn_maintenance_handler_tunnel_accepted_routes":              12,
		"aws_vpn_maintenance_handler_tunnel_pending_maintenance":          1,
		"aws_vpn_maintenance_handler_tunnel_lifecycle_control":            1,
		"aws_vpn_maintenance_handler_tunnel_maintenance_deadline_seconds": 1785000000,
	} {
		if got := gaugeValue(t, m, name, labels...); got != want {
			t.Fatalf("%s = %v, want %v", name, got, want)
		}
	}
}

// An unpublished deadline must read as 0, not as a timestamp near the epoch that an
// alert would treat as long overdue.
func TestSetTunnelHandlesAMissingDeadline(t *testing.T) {
	m := NewMetrics()
	s := sample()
	s.Deadline = time.Time{}
	m.SetTunnel(s)

	if got := gaugeValue(t, m, "aws_vpn_maintenance_handler_tunnel_maintenance_deadline_seconds", "vpn-a", "prod-dc", "203.0.113.10"); got != 0 {
		t.Fatalf("deadline gauge = %v, want 0", got)
	}
}

// Series are reset each pass so a connection that was untagged or deleted stops
// reporting instead of freezing at its last value.
func TestResetTunnelsClearsStaleSeries(t *testing.T) {
	m := NewMetrics()
	m.SetTunnel(sample())
	if n := testutil.CollectAndCount(m.tunnelUp); n != 1 {
		t.Fatalf("expected 1 series, got %d", n)
	}

	m.ResetTunnels()
	if n := testutil.CollectAndCount(m.tunnelUp); n != 0 {
		t.Fatalf("expected the series to be cleared, got %d", n)
	}
}

func TestCounters(t *testing.T) {
	m := NewMetrics()

	m.ObserveReconcile()
	m.ObserveReconcile()
	if got := testutil.ToFloat64(m.reconcileTotal); got != 2 {
		t.Fatalf("reconcile_total = %v, want 2", got)
	}

	m.ObserveReconcileError("discover")
	if got := testutil.ToFloat64(m.reconcileErrors.WithLabelValues("discover")); got != 1 {
		t.Fatalf("reconcile_errors_total{discover} = %v, want 1", got)
	}

	m.ObserveBlocked("peer_down")
	if got := testutil.ToFloat64(m.blockedTotal.WithLabelValues("peer_down")); got != 1 {
		t.Fatalf("blocked_total{peer_down} = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.blockedTunnels.WithLabelValues("peer_down")); got != 1 {
		t.Fatalf("blocked_tunnels{peer_down} = %v, want 1", got)
	}

	m.ObserveApproval("approved")
	if got := testutil.ToFloat64(m.approvalTotal.WithLabelValues("approved")); got != 1 {
		t.Fatalf("approval_total{approved} = %v, want 1", got)
	}

	m.SetConnections(3)
	if got := testutil.ToFloat64(m.connections); got != 3 {
		t.Fatalf("managed_connections = %v, want 3", got)
	}
}

func TestSetWindow(t *testing.T) {
	m := NewMetrics()
	m.SetWindow(true, 90*time.Minute)

	if got := testutil.ToFloat64(m.windowOpen); got != 1 {
		t.Fatalf("window_open = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.windowRemaining); got != 5400 {
		t.Fatalf("window_remaining_seconds = %v, want 5400", got)
	}

	m.SetWindow(false, 0)
	if got := testutil.ToFloat64(m.windowOpen); got != 0 {
		t.Fatalf("window_open = %v, want 0", got)
	}
}

func TestObserveTrafficGate(t *testing.T) {
	m := NewMetrics()

	m.ObserveTrafficGate(true, 0.2, 12, true)
	if got := testutil.ToFloat64(m.trafficGateTotal.WithLabelValues("allowed")); got != 1 {
		t.Fatalf("traffic_gate_total{allowed} = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.trafficRatio); got != 0.2 {
		t.Fatalf("traffic_ratio = %v, want 0.2", got)
	}
	if got := testutil.ToFloat64(m.trafficPercentile); got != 12 {
		t.Fatalf("traffic_percentile = %v, want 12", got)
	}

	// Without a readable history there is no measured position, so the gauges must
	// keep their last real value rather than being reset to a meaningless 0.
	m.ObserveTrafficGate(false, 0, 0, false)
	if got := testutil.ToFloat64(m.trafficGateTotal.WithLabelValues("blocked")); got != 1 {
		t.Fatalf("traffic_gate_total{blocked} = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.trafficRatio); got != 0.2 {
		t.Fatalf("traffic_ratio = %v, want it unchanged at 0.2", got)
	}
}

func TestObserveReplacement(t *testing.T) {
	m := NewMetrics()

	m.ObserveReplacement("succeeded", 90*time.Second, false)
	if got := testutil.ToFloat64(m.replacementTotal.WithLabelValues("succeeded")); got != 1 {
		t.Fatalf("replacement_total{succeeded} = %v, want 1", got)
	}
	if got := testutil.ToFloat64(m.peerDroppedTotal); got != 0 {
		t.Fatalf("peer_dropped_total = %v, want 0", got)
	}

	m.ObserveReplacement("succeeded", time.Minute, true)
	if got := testutil.ToFloat64(m.peerDroppedTotal); got != 1 {
		t.Fatalf("peer_dropped_total = %v, want 1 once the peer dropped", got)
	}
}

func TestSetInFlight(t *testing.T) {
	m := NewMetrics()
	m.SetInFlight(true)
	if got := testutil.ToFloat64(m.replacementInFlight); got != 1 {
		t.Fatalf("replacement_in_flight = %v, want 1", got)
	}
	m.SetInFlight(false)
	if got := testutil.ToFloat64(m.replacementInFlight); got != 0 {
		t.Fatalf("replacement_in_flight = %v, want 0", got)
	}
}

func TestMetricsServeExposesTheRegistry(t *testing.T) {
	m := NewMetrics()
	m.SetTunnel(sample())

	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = m.Serve(ctx, port) }()

	body := get(t, port, "/metrics")
	for _, want := range []string{
		"aws_vpn_maintenance_handler_tunnel_up",
		"aws_vpn_maintenance_handler_tunnel_lifecycle_control",
		"go_goroutines",
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("/metrics is missing %q", want)
		}
	}
}

// /healthz must stay 200 while the replica waits for leadership, or the kubelet would
// restart a perfectly healthy standby.
func TestHealthLivenessIsAlwaysOK(t *testing.T) {
	h := NewHealth()
	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = h.Serve(ctx, port) }()

	if code, _ := status(t, port, "/healthz"); code != http.StatusOK {
		t.Fatalf("/healthz = %d, want 200 before readiness", code)
	}
}

// Readiness needs both the controller and a live approval channel: one that cannot
// receive approvals cannot do its job.
func TestHealthReadinessRequiresSlack(t *testing.T) {
	h := NewHealth()
	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = h.Serve(ctx, port) }()

	if code, _ := status(t, port, "/readyz"); code != http.StatusServiceUnavailable {
		t.Fatalf("/readyz = %d, want 503 before readiness", code)
	}

	h.SetReady(true)
	code, body := status(t, port, "/readyz")
	if code != http.StatusServiceUnavailable || !strings.Contains(body, "slack") {
		t.Fatalf("/readyz = %d (%s), want 503 naming Slack", code, body)
	}

	h.SetSlackConnected(true)
	if code, _ := status(t, port, "/readyz"); code != http.StatusOK {
		t.Fatalf("/readyz = %d, want 200 once both are up", code)
	}

	// A dropped Socket Mode connection must take the Pod out of the endpoints.
	h.SetSlackConnected(false)
	if code, _ := status(t, port, "/readyz"); code != http.StatusServiceUnavailable {
		t.Fatalf("/readyz = %d, want 503 after Slack disconnected", code)
	}
}

func TestServeShutsDownWithTheContext(t *testing.T) {
	h := NewHealth()
	port := freePort(t)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() { done <- h.Serve(ctx, port) }()
	waitForPort(t, port)
	cancel()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve returned %v, want a clean shutdown", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return after cancellation")
	}
}

// freePort reserves a port and releases it, so the server can bind it.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port
}

func waitForPort(t *testing.T, port int) {
	t.Helper()
	for range 200 {
		conn, err := net.DialTimeout("tcp", addr(port), 50*time.Millisecond)
		if err == nil {
			_ = conn.Close()
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("nothing listening on %d", port)
}

func addr(port int) string {
	return net.JoinHostPort("127.0.0.1", itoa(port))
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	var buf []byte
	for v > 0 {
		buf = append([]byte{byte('0' + v%10)}, buf...)
		v /= 10
	}
	return string(buf)
}

func status(t *testing.T, port int, path string) (int, string) {
	t.Helper()
	waitForPort(t, port)
	resp, err := http.Get("http://" + addr(port) + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	// Read the whole body: /metrics runs to tens of kilobytes, and a truncated read
	// would fail on collectors that simply sort late.
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return resp.StatusCode, string(body)
}

func get(t *testing.T, port int, path string) string {
	t.Helper()
	_, body := status(t, port, path)
	return body
}

// gaugeValue reads one labelled gauge out of the private registry.
func gaugeValue(t *testing.T, m *Metrics, name string, labels ...string) float64 {
	t.Helper()
	switch name {
	case "aws_vpn_maintenance_handler_tunnel_up":
		return testutil.ToFloat64(m.tunnelUp.WithLabelValues(labels...))
	case "aws_vpn_maintenance_handler_tunnel_accepted_routes":
		return testutil.ToFloat64(m.tunnelRoutes.WithLabelValues(labels...))
	case "aws_vpn_maintenance_handler_tunnel_pending_maintenance":
		return testutil.ToFloat64(m.tunnelPending.WithLabelValues(labels...))
	case "aws_vpn_maintenance_handler_tunnel_lifecycle_control":
		return testutil.ToFloat64(m.tunnelLifecycle.WithLabelValues(labels...))
	case "aws_vpn_maintenance_handler_tunnel_maintenance_deadline_seconds":
		return testutil.ToFloat64(m.tunnelDeadline.WithLabelValues(labels...))
	default:
		t.Fatalf("unknown gauge %q", name)
		return 0
	}
}
