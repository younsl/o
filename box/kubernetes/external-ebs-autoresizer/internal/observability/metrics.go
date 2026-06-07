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

// Metrics holds the application's Prometheus collectors and implements
// resizer.Recorder.
type Metrics struct {
	registry       *prometheus.Registry
	usage          *prometheus.GaugeVec
	resizeTotal    *prometheus.CounterVec
	errorTotal     *prometheus.CounterVec
	reconcileTotal prometheus.Counter
}

// NewMetrics builds the collectors and registers them on a private registry.
func NewMetrics() *Metrics {
	m := &Metrics{
		registry: prometheus.NewRegistry(),
		usage: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "external_ebs_autoresizer_root_usage_percent",
			Help: "Most recently measured root filesystem usage percent per instance.",
		}, []string{"instance_id", "device", "volume_id", "name"}),
		resizeTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "external_ebs_autoresizer_resize_total",
			Help: "Total resize attempts by result.",
		}, []string{"result"}),
		errorTotal: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "external_ebs_autoresizer_error_total",
			Help: "Total errors by reconcile stage.",
		}, []string{"stage"}),
		reconcileTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "external_ebs_autoresizer_reconcile_total",
			Help: "Total reconcile passes started.",
		}),
	}
	m.registry.MustRegister(m.usage, m.resizeTotal, m.errorTotal, m.reconcileTotal)
	return m
}

// ObserveUsage records the latest measured usage for an instance.
func (m *Metrics) ObserveUsage(instanceID, device, volumeID, name string, percent float64) {
	m.usage.WithLabelValues(instanceID, device, volumeID, name).Set(percent)
}

// ObserveResize counts a resize attempt by outcome.
func (m *Metrics) ObserveResize(success bool) {
	result := "failure"
	if success {
		result = "success"
	}
	m.resizeTotal.WithLabelValues(result).Inc()
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
