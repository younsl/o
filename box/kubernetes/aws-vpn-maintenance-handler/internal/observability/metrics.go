// Package observability holds the Prometheus metrics and the health endpoints
// exposed by the controller.
package observability

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// tunnelLabels is shared by every per-tunnel gauge, so a dashboard can join health
// against pending maintenance without relabeling.
var tunnelLabels = []string{"vpn_connection_id", "vpn_connection_name", "tunnel_ip"}

// Metrics holds the collectors on a private registry.
type Metrics struct {
	registry *prometheus.Registry

	reconcileTotal  prometheus.Counter
	reconcileErrors *prometheus.CounterVec
	connections     prometheus.Gauge

	tunnelUp        *prometheus.GaugeVec
	tunnelRoutes    *prometheus.GaugeVec
	tunnelPending   *prometheus.GaugeVec
	tunnelDeadline  *prometheus.GaugeVec
	tunnelLifecycle *prometheus.GaugeVec
	blockedTunnels  *prometheus.GaugeVec
	blockedTotal    *prometheus.CounterVec
	windowOpen      prometheus.Gauge
	windowRemaining prometheus.Gauge

	noticeTotal         *prometheus.CounterVec
	trafficGateTotal    *prometheus.CounterVec
	trafficRatio        prometheus.Gauge
	trafficPercentile   prometheus.Gauge
	approvalTotal       *prometheus.CounterVec
	replacementTotal    *prometheus.CounterVec
	replacementDuration prometheus.Histogram
	replacementInFlight prometheus.Gauge
	peerDroppedTotal    prometheus.Counter
}

// NewMetrics builds and registers the collectors.
func NewMetrics() *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		reconcileTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "aws_vpn_maintenance_handler_reconcile_total",
			Help: "Total reconcile passes started.",
		}),
		reconcileErrors: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "aws_vpn_maintenance_handler_reconcile_errors_total",
			Help: "Total reconcile errors by stage.",
		}, []string{"stage"}),
		connections: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_managed_connections",
			Help: "Number of tag-matched Site-to-Site VPN connections discovered in the latest pass.",
		}),
		tunnelUp: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_tunnel_up",
			Help: "Tunnel telemetry status: 1 when UP, 0 when DOWN.",
		}, tunnelLabels),
		tunnelRoutes: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_tunnel_accepted_routes",
			Help: "BGP routes accepted on the tunnel. Always 0 on static-routes-only connections, where it carries no health information.",
		}, tunnelLabels),
		tunnelPending: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_tunnel_pending_maintenance",
			Help: "1 when AWS reports pending endpoint maintenance for the tunnel, 0 otherwise.",
		}, tunnelLabels),
		tunnelDeadline: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_tunnel_maintenance_deadline_seconds",
			Help: "Unix timestamp after which AWS applies the pending maintenance itself. 0 when no deadline is published. Alert on this approaching to catch unanswered approvals.",
		}, tunnelLabels),
		tunnelLifecycle: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_tunnel_lifecycle_control",
			Help: "1 when tunnel endpoint lifecycle control is enabled on the tunnel, 0 otherwise. A 0 means AWS applies that tunnel's maintenance on its own schedule and this controller cannot take it over. Alert on this.",
		}, tunnelLabels),
		blockedTunnels: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_blocked_tunnels",
			Help: "Tunnels with pending maintenance currently held back by a preflight rule, by reason.",
		}, []string{"reason"}),
		blockedTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "aws_vpn_maintenance_handler_blocked_total",
			Help: "Total preflight rejections of a tunnel with pending maintenance, by reason.",
		}, []string{"reason"}),
		windowOpen: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_window_open",
			Help: "1 when the maintenance window is open and long enough to start a replacement, 0 otherwise.",
		}),
		windowRemaining: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_window_remaining_seconds",
			Help: "Seconds left in the current maintenance window, 0 when closed.",
		}),
		noticeTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "aws_vpn_maintenance_handler_detection_notices_total",
			Help: "Total detection notices sent to the approvers, by the reason the tunnel was not being replaced at the time. One per tunnel per maintenance cycle.",
		}, []string{"reason"}),
		trafficGateTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "aws_vpn_maintenance_handler_traffic_gate_total",
			Help: "Total traffic gate evaluations by verdict (allowed, blocked).",
		}, []string{"verdict"}),
		trafficRatio: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_traffic_ratio",
			Help: "Most recent traffic over the quiet threshold from the traffic gate. Below 1 means the gate would open. Only set when the window's traffic history was readable.",
		}),
		trafficPercentile: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_traffic_percentile",
			Help: "Where the most recently measured traffic falls in what the connection carries during its maintenance window, in percent. Compare against the configured quietPercentile.",
		}),
		approvalTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "aws_vpn_maintenance_handler_approval_total",
			Help: "Total approval requests resolved, by decision (approved, denied, timeout, expired, aborted). timeout means nobody answered; expired means the preconditions lapsed while the request was outstanding.",
		}, []string{"decision"}),
		replacementTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "aws_vpn_maintenance_handler_replacement_total",
			Help: "Total tunnel replacements attempted, by outcome.",
		}, []string{"outcome"}),
		replacementDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name: "aws_vpn_maintenance_handler_replacement_duration_seconds",
			Help: "Time from the ReplaceVpnTunnel call until the tunnel was verified healthy or gave up.",
			// Replacements usually finish in single-digit minutes; the upper
			// buckets show a run heading for a timeout.
			Buckets: []float64{30, 60, 120, 300, 600, 900, 1800, 3600},
		}),
		replacementInFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "aws_vpn_maintenance_handler_replacement_in_flight",
			Help: "1 while a tunnel replacement is being performed or verified, 0 otherwise.",
		}),
		peerDroppedTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "aws_vpn_maintenance_handler_peer_dropped_total",
			Help: "Total replacements during which the surviving tunnel also went DOWN, leaving the connection with no healthy path. Should stay at 0.",
		}),
	}

	m.registry.MustRegister(
		m.reconcileTotal, m.reconcileErrors, m.connections,
		m.tunnelUp, m.tunnelRoutes, m.tunnelPending, m.tunnelDeadline, m.tunnelLifecycle,
		m.blockedTunnels, m.blockedTotal, m.noticeTotal, m.windowOpen, m.windowRemaining,
		m.trafficGateTotal, m.trafficRatio, m.trafficPercentile,
		m.approvalTotal, m.replacementTotal, m.replacementDuration,
		m.replacementInFlight, m.peerDroppedTotal,
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return m
}

// ObserveReconcile counts a reconcile pass.
func (m *Metrics) ObserveReconcile() { m.reconcileTotal.Inc() }

// ObserveReconcileError counts a failure in a named reconcile stage.
func (m *Metrics) ObserveReconcileError(stage string) { m.reconcileErrors.WithLabelValues(stage).Inc() }

// SetConnections records how many managed connections were discovered.
func (m *Metrics) SetConnections(n int) { m.connections.Set(float64(n)) }

// ResetTunnels clears the per-tunnel series before a pass repopulates them, so an
// untagged or deleted connection stops reporting instead of freezing.
func (m *Metrics) ResetTunnels() {
	m.tunnelUp.Reset()
	m.tunnelRoutes.Reset()
	m.tunnelPending.Reset()
	m.tunnelDeadline.Reset()
	m.tunnelLifecycle.Reset()
	m.blockedTunnels.Reset()
}

// TunnelSample is one tunnel's state for a single pass.
type TunnelSample struct {
	ConnectionID   string
	ConnectionName string
	TunnelIP       string
	Up             bool
	Routes         int32
	Pending        bool
	Deadline       time.Time
	// LifecycleControl reports whether this controller can manage the tunnel at all.
	LifecycleControl bool
}

// SetTunnel records one tunnel's telemetry and maintenance state.
func (m *Metrics) SetTunnel(s TunnelSample) {
	labels := prometheus.Labels{
		"vpn_connection_id":   s.ConnectionID,
		"vpn_connection_name": s.ConnectionName,
		"tunnel_ip":           s.TunnelIP,
	}
	m.tunnelUp.With(labels).Set(boolGauge(s.Up))
	m.tunnelRoutes.With(labels).Set(float64(s.Routes))
	m.tunnelPending.With(labels).Set(boolGauge(s.Pending))
	m.tunnelLifecycle.With(labels).Set(boolGauge(s.LifecycleControl))
	var deadlineSecs float64
	if !s.Deadline.IsZero() {
		deadlineSecs = float64(s.Deadline.Unix())
	}
	m.tunnelDeadline.With(labels).Set(deadlineSecs)
}

// ObserveBlocked records a tunnel with pending maintenance held back by a rule.
func (m *Metrics) ObserveBlocked(reason string) {
	m.blockedTunnels.WithLabelValues(reason).Inc()
	m.blockedTotal.WithLabelValues(reason).Inc()
}

// ObserveDetectionNotice records a detection notice delivered to the approvers.
func (m *Metrics) ObserveDetectionNotice(reason string) { m.noticeTotal.WithLabelValues(reason).Inc() }

// ObserveTrafficGate records one traffic gate verdict.
//
// The two gauges are only set when the verdict came from a distribution: an onError
// verdict has no measured position, and leaving the previous value in place is more
// honest than writing a zero that would read as a perfectly quiet tunnel.
func (m *Metrics) ObserveTrafficGate(allowed bool, ratio, percentile float64, hasHistory bool) {
	verdict := "blocked"
	if allowed {
		verdict = "allowed"
	}
	m.trafficGateTotal.WithLabelValues(verdict).Inc()
	if hasHistory {
		m.trafficRatio.Set(ratio)
		m.trafficPercentile.Set(percentile)
	}
}

// SetWindow records the maintenance window state.
func (m *Metrics) SetWindow(open bool, remaining time.Duration) {
	m.windowOpen.Set(boolGauge(open))
	m.windowRemaining.Set(remaining.Seconds())
}

// ObserveApproval counts a resolved approval request.
func (m *Metrics) ObserveApproval(decision string) { m.approvalTotal.WithLabelValues(decision).Inc() }

// ObserveReplacement records a finished replacement.
func (m *Metrics) ObserveReplacement(outcome string, d time.Duration, peerDropped bool) {
	m.replacementTotal.WithLabelValues(outcome).Inc()
	m.replacementDuration.Observe(d.Seconds())
	if peerDropped {
		m.peerDroppedTotal.Inc()
	}
}

// SetInFlight records whether a replacement is running.
func (m *Metrics) SetInFlight(inFlight bool) { m.replacementInFlight.Set(boolGauge(inFlight)) }

// Serve runs the metrics HTTP server until ctx is cancelled.
func (m *Metrics) Serve(ctx context.Context, port int) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{}))
	return serveUntilDone(ctx, port, mux)
}

func boolGauge(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

// serveUntilDone runs srv on port and shuts it down when ctx is cancelled.
func serveUntilDone(ctx context.Context, port int, handler http.Handler) error {
	srv := &http.Server{
		Addr:    fmt.Sprintf(":%d", port),
		Handler: handler,
		// Keeps a slow client from holding a connection open.
		ReadHeaderTimeout: 5 * time.Second,
		// The server's own complaints (bad handshakes, hijack failures) belong in
		// the same structured stream as everything else, at ERROR rather than the
		// INFO the default log-package bridge would give them.
		ErrorLog: slog.NewLogLogger(slog.Default().Handler(), slog.LevelError),
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("listen on :%d: %w", port, err)
	}
	return nil
}
