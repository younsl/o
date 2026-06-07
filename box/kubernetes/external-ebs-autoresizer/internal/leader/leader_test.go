package leader

import (
	"context"
	"io"
	"log/slog"
	"testing"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestRunRequiresIdentityNamespaceLease(t *testing.T) {
	cases := []Config{
		{Identity: "", Namespace: "ns", LeaseName: "lease"},
		{Identity: "id", Namespace: "", LeaseName: "lease"},
		{Identity: "id", Namespace: "ns", LeaseName: ""},
	}
	for _, cfg := range cases {
		if err := Run(context.Background(), cfg, discardLogger(), func(context.Context) {}); err == nil {
			t.Errorf("Run(%+v) = nil error, want validation error", cfg)
		}
	}
}

func TestRunOutsideClusterReturnsError(t *testing.T) {
	// With no in-cluster service env, rest.InClusterConfig fails and Run returns
	// before contending for the lease, so the reconcile fn never runs.
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	t.Setenv("KUBERNETES_SERVICE_PORT", "")

	called := false
	cfg := Config{Identity: "id", Namespace: "ns", LeaseName: "lease"}
	err := Run(context.Background(), cfg, discardLogger(), func(context.Context) { called = true })
	if err == nil {
		t.Fatal("Run = nil error, want in-cluster config error")
	}
	if called {
		t.Error("reconcile fn ran despite leader election setup failure")
	}
}
