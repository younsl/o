package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
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
