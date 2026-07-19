// Package observability provides the Prometheus metrics registry and health
// endpoints exposed by the long-running process.
package observability

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// instanceLabels is the shared identity label set of the per-instance gauges
// (root_usage_percent, root_volume_size_gib). Keeping it identical across both
// gauges lets dashboards join them without relabeling.
var instanceLabels = []string{"instance_id", "device", "volume_id", "name"}

// Metrics holds the application's Prometheus collectors and implements
// resizer.Recorder.
type Metrics struct {
	registry        *prometheus.Registry
	usage           *prometheus.GaugeVec
	volumeSize      *prometheus.GaugeVec
	resizeTotal     *prometheus.CounterVec
	skipTotal       *prometheus.CounterVec
	errorTotal      *prometheus.CounterVec
	reconcileTotal  prometheus.Counter
	policyInstances *prometheus.GaugeVec
}

// NewMetrics builds the collectors and registers them on a private registry.
func NewMetrics() *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		usage: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "external_ebs_autoresizer_root_usage_percent",
			Help: "Most recently measured root filesystem usage percent per instance.",
		}, instanceLabels),
		volumeSize: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "external_ebs_autoresizer_root_volume_size_gib",
			Help: "Most recently observed root EBS volume size in GiB per instance. Size is a gauge value, not a label, so the series identity survives resizes.",
		}, instanceLabels),
		resizeTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "external_ebs_autoresizer_resize_total",
			Help: "Total resize attempts by result and matched resize policy.",
		}, []string{"result", "policy"}),
		skipTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "external_ebs_autoresizer_skip_total",
			Help: "Total instances skipped without a resize attempt, by reason and matched resize policy.",
		}, []string{"reason", "policy"}),
		errorTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "external_ebs_autoresizer_error_total",
			Help: "Total errors by reconcile stage.",
		}, []string{"stage"}),
		reconcileTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "external_ebs_autoresizer_reconcile_total",
			Help: "Total reconcile passes started.",
		}),
		policyInstances: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "external_ebs_autoresizer_policy_instances",
			Help: "Number of discovered instances matched by each resize policy in the latest pass (policy=default for instances matching no named policy).",
		}, []string{"policy"}),
	}
	m.registry.MustRegister(m.usage, m.volumeSize, m.resizeTotal, m.skipTotal, m.errorTotal, m.reconcileTotal, m.policyInstances)
	return m
}

// ObserveUsage records the latest measured usage for an instance.
func (m *Metrics) ObserveUsage(instanceID, device, volumeID, name string, percent float64) {
	m.usage.WithLabelValues(instanceID, device, volumeID, name).Set(percent)
}

// ObserveVolumeSize records the latest known root volume size for an instance.
// The identity labels match ObserveUsage so the two gauges join cleanly.
func (m *Metrics) ObserveVolumeSize(instanceID, device, volumeID, name string, sizeGiB int32) {
	m.volumeSize.WithLabelValues(instanceID, device, volumeID, name).Set(float64(sizeGiB))
}

// ObserveResize counts a resize attempt by outcome and matched policy.
func (m *Metrics) ObserveResize(success bool, policy string) {
	result := "failure"
	if success {
		result = "success"
	}
	m.resizeTotal.WithLabelValues(result, policy).Inc()
}

// ObserveSkip counts an instance skipped without a resize attempt. reason is
// one of: below_threshold, max_size, cooldown, dry_run. policy is the matched
// resize policy.
func (m *Metrics) ObserveSkip(reason, policy string) {
	m.skipTotal.WithLabelValues(reason, policy).Inc()
}

// ObservePolicyInstances records, per resize policy, how many discovered
// instances matched it in the latest reconcile pass. Policies that matched
// nothing this pass are set to 0 so stale counts do not linger.
func (m *Metrics) ObservePolicyInstances(counts map[string]int) {
	m.policyInstances.Reset()
	for policy, n := range counts {
		m.policyInstances.WithLabelValues(policy).Set(float64(n))
	}
}

// ObserveError counts an error in the given reconcile stage.
func (m *Metrics) ObserveError(stage string) {
	m.errorTotal.WithLabelValues(stage).Inc()
}

// ObserveReconcile counts a reconcile pass start.
func (m *Metrics) ObserveReconcile() {
	m.reconcileTotal.Inc()
}

// Serve runs the /metrics HTTP server until ctx is cancelled.
func (m *Metrics) Serve(ctx context.Context, port int) error {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(m.registry, promhttp.HandlerOpts{}))
	return serveUntilDone(ctx, port, mux)
}

func serveUntilDone(ctx context.Context, port int, handler http.Handler) error {
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	case err := <-errCh:
		return err
	}
}
