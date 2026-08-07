package main

import (
	"context"
	"errors"
	"log/slog"
	"maps"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/throughput"
)

// healthyServer serves 200 on every path, satisfying both the Alertmanager and
// Grafana preflight endpoints.
func healthyServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestBuildSinksAllDisabled(t *testing.T) {
	cfg := &config.Config{} // PodName empty, Alertmanager/Grafana disabled
	s := buildSinks(context.Background(), cfg, testLogger())

	// Disabled sinks must be nil interfaces (not typed nils), so the resizer's
	// nil checks short-circuit correctly.
	if s.emitter != nil {
		t.Errorf("emitter = %v, want nil", s.emitter)
	}
	if s.notifier != nil {
		t.Errorf("notifier = %v, want nil", s.notifier)
	}
	if s.annotator != nil {
		t.Errorf("annotator = %v, want nil", s.annotator)
	}
	if s.shutdown == nil {
		t.Fatal("shutdown hook is nil, want a callable no-op")
	}
	s.shutdown() // must not panic
}

func TestBuildSinksEmitterDisabledOutsideCluster(t *testing.T) {
	// POD_NAME is set but there is no in-cluster config, so events.New fails
	// and the emitter must stay a nil interface rather than crash startup.
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	t.Setenv("KUBERNETES_SERVICE_PORT", "")
	cfg := &config.Config{PodName: "pod-1", PodNamespace: "ns", PodUID: "uid"}

	s := buildSinks(context.Background(), cfg, testLogger())
	if s.emitter != nil {
		t.Errorf("emitter = %v, want nil outside a cluster", s.emitter)
	}
	s.shutdown()
}

func TestBuildSinksAlertmanagerEnabled(t *testing.T) {
	srv := healthyServer(t)
	cfg := &config.Config{
		AlertmanagerEnabled: true,
		AlertmanagerURL:     srv.URL,
		AlertmanagerTimeout: time.Second,
	}

	s := buildSinks(context.Background(), cfg, testLogger())
	if s.notifier == nil {
		t.Error("notifier = nil, want Alertmanager client")
	}
	if s.annotator != nil {
		t.Errorf("annotator = %v, want nil when Grafana is disabled", s.annotator)
	}
}

func TestBuildSinksGrafanaEnabled(t *testing.T) {
	srv := healthyServer(t)
	cfg := &config.Config{
		GrafanaAnnotationEnabled: true,
		GrafanaURL:               srv.URL,
		GrafanaAPIToken:          "token",
		GrafanaTimeout:           time.Second,
	}

	s := buildSinks(context.Background(), cfg, testLogger())
	if s.annotator == nil {
		t.Error("annotator = nil, want Grafana client")
	}
	if s.notifier != nil {
		t.Errorf("notifier = %v, want nil when Alertmanager is disabled", s.notifier)
	}
}

func TestRecommenderConfigMapping(t *testing.T) {
	cfg := &config.Config{
		DryRun: true,
		ThroughputRecommendation: config.ThroughputRecommendation{
			MetricNodeNameLabel: "instance",
			LookbackWindow:      "14d",
			LookbackDuration:    14 * 24 * time.Hour,
		},
	}

	got := recommenderConfig(cfg)
	if got.MetricNodeNameLabel != "instance" {
		t.Errorf("node label = %q, want it carried over", got.MetricNodeNameLabel)
	}
	if got.Lookback != "14d" || got.LookbackDuration != 14*24*time.Hour {
		t.Errorf("window = %s (%s), want both forms carried over", got.Lookback, got.LookbackDuration)
	}
	// The recommender never mutates AWS, but annotating Nodes is still a cluster
	// write, so a global dry run has to reach it.
	if !got.DryRun {
		t.Error("dryRun = false, want the global dry run inherited")
	}
}

// stubProber returns a canned startup probe result.
type stubProber struct {
	probe throughput.Probe
	err   error
}

func (s stubProber) Probe(context.Context) (throughput.Probe, error) { return s.probe, s.err }

func TestLogProbe(t *testing.T) {
	tests := []struct {
		name      string
		prober    stubProber
		wantLevel string
		wantParts []string
	}{
		{
			name: "usable series log at info with the busiest node",
			prober: stubProber{probe: throughput.Probe{
				Query: "quantile_over_time(...)", Series: 12, Nodes: 12,
				MaxNode: "ip-10-0-1-5", MaxPeakMiBps: 287.44,
			}},
			wantLevel: "INFO",
			// The rounded peak is what an operator compares against a dashboard, so
			// the log must not print the full float.
			wantParts: []string{"metrics check succeeded", "nodes=12", "busiest_node=ip-10-0-1-5", "busiest_node_peak_mibps=287.4"},
		},
		{
			name: "series without the node label are an error, not a warning",
			prober: stubProber{probe: throughput.Probe{
				Series: 12, Nodes: 0, Dropped: 12,
			}},
			// This misconfiguration produces no recommendations at all while every
			// connectivity check passes, so it has to be loud and name the fix.
			wantLevel: "ERROR",
			wantParts: []string{"no usable series", "metric_node_name_label=node", "metricNodeNameLabel"},
		},
		{
			name:      "an empty backend is a warning about scraping",
			prober:    stubProber{probe: throughput.Probe{Series: 0, Nodes: 0}},
			wantLevel: "WARN",
			wantParts: []string{"returned no data", "node exporter is scraped"},
		},
		{
			name:      "a query failure does not stop startup",
			prober:    stubProber{err: errors.New("connection refused")},
			wantLevel: "ERROR",
			wantParts: []string{"metrics check failed", "will retry on its interval", "connection refused"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var logged strings.Builder
			logger := slog.New(slog.NewTextHandler(&logged, &slog.HandlerOptions{Level: slog.LevelDebug}))

			logProbe(context.Background(), tt.prober, time.Second, "node", logger)

			out := logged.String()
			if !strings.Contains(out, "level="+tt.wantLevel) {
				t.Errorf("log = %q, want level %s", out, tt.wantLevel)
			}
			for _, part := range tt.wantParts {
				if !strings.Contains(out, part) {
					t.Errorf("log = %q, want it to contain %q", out, part)
				}
			}
		})
	}
}

func TestLogProbeHonoursTheQueryTimeout(t *testing.T) {
	// The probe must not be able to hang startup on a backend that accepts the
	// connection and never answers.
	var gotDeadline bool
	blocking := probeFunc(func(ctx context.Context) (throughput.Probe, error) {
		_, gotDeadline = ctx.Deadline()
		<-ctx.Done()
		return throughput.Probe{}, ctx.Err()
	})
	var logged strings.Builder
	logger := slog.New(slog.NewTextHandler(&logged, nil))

	logProbe(context.Background(), blocking, 10*time.Millisecond, "node", logger)

	if !gotDeadline {
		t.Error("the probe context carried no deadline")
	}
	if !strings.Contains(logged.String(), "metrics check failed") {
		t.Errorf("log = %q, want the timeout reported", logged.String())
	}
}

// probeFunc adapts a function to the prober interface.
type probeFunc func(context.Context) (throughput.Probe, error)

func (f probeFunc) Probe(ctx context.Context) (throughput.Probe, error) { return f(ctx) }

func TestQueryHeaders(t *testing.T) {
	// No token means no headers. The tenant header is the promql client's own
	// concern, so this function has nothing to add without a credential.
	if got := queryHeaders(config.ThroughputRecommendation{}); got != nil {
		t.Errorf("queryHeaders() = %v, want nil without a token", got)
	}

	// The token arrives from a Secret through the environment, never the config
	// file, so it cannot land in the ConfigMap.
	want := map[string]string{"Authorization": "Bearer s3cr3t"}
	got := queryHeaders(config.ThroughputRecommendation{PrometheusBearerToken: "s3cr3t"})
	if !maps.Equal(got, want) {
		t.Errorf("queryHeaders() = %v, want %v", got, want)
	}
}
