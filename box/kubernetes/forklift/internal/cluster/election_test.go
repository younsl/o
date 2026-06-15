package cluster

import (
	"io"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/config"
)

// New requires in-cluster config; outside a cluster it must fail cleanly rather
// than panic. (Unset any service-account env that could be picked up.)
func TestNewOutsideClusterFails(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	t.Setenv("KUBERNETES_SERVICE_PORT", "")
	if _, err := os.Stat("/var/run/secrets/kubernetes.io/serviceaccount/token"); err == nil {
		t.Skip("running inside a cluster")
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := New(config.HAConfig{
		LeaseName: "forklift", LeaseNamespace: "default", Identity: "pod-0",
		LeaseDuration: 15 * time.Second, RenewDeadline: 10 * time.Second, RetryPeriod: 2 * time.Second,
	}, log); err == nil {
		t.Fatal("expected error outside a cluster")
	}
}
