package main

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/config"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/gate"
)

func TestEnvOr(t *testing.T) {
	const key = "ARGOCD_PROMOTION_GATE_TEST_ENV"

	if got := envOr(key, "fallback"); got != "fallback" {
		t.Errorf("envOr() with an unset key = %q, want fallback", got)
	}

	t.Setenv(key, "  ")
	if got := envOr(key, "fallback"); got != "fallback" {
		t.Errorf("envOr() with a blank value = %q, want fallback", got)
	}

	t.Setenv(key, " value ")
	if got := envOr(key, "fallback"); got != "value" {
		t.Errorf("envOr() = %q, want the trimmed value", got)
	}
}

func TestNewLogger(t *testing.T) {
	cases := map[string]slog.Level{
		"debug":    slog.LevelDebug,
		"info":     slog.LevelInfo,
		"warn":     slog.LevelWarn,
		"error":    slog.LevelError,
		"":         slog.LevelInfo,
		"nonsense": slog.LevelInfo,
	}
	for level, want := range cases {
		t.Run("level "+level, func(t *testing.T) {
			logger := newLogger(level, "json")
			if logger == nil {
				t.Fatal("newLogger() = nil")
			}
			if !logger.Enabled(nil, want) {
				t.Errorf("logger is not enabled at %v for level %q", want, level)
			}
			if want > slog.LevelDebug && logger.Enabled(nil, want-4) {
				t.Errorf("logger for %q is enabled below %v", level, want)
			}
		})
	}

	for _, format := range []string{"json", "text", "TEXT", "unknown"} {
		if newLogger("info", format) == nil {
			t.Errorf("newLogger() = nil for format %q", format)
		}
	}
}

func TestRestConfigFromKubeconfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "kubeconfig")
	raw := `apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: https://kubernetes.example.com
contexts:
- name: test
  context:
    cluster: test
    user: test
current-context: test
users:
- name: test
  user:
    token: token
`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}

	cfg, err := restConfig(path)
	if err != nil {
		t.Fatalf("restConfig() error = %v", err)
	}
	if cfg.Host != "https://kubernetes.example.com" {
		t.Errorf("Host = %q", cfg.Host)
	}

	if _, err := restConfig(filepath.Join(dir, "missing")); err == nil {
		t.Error("restConfig() with a missing kubeconfig = nil error, want failure")
	}
}

func TestRestConfigOutsideClusterFails(t *testing.T) {
	// With no kubeconfig and no service account projected, in-cluster
	// discovery must fail loudly rather than produce a half-configured client.
	if _, err := restConfig(""); err == nil {
		t.Skip("running inside a cluster; in-cluster config resolved")
	}
}

func TestExemptNames(t *testing.T) {
	cfg := config.Default()
	cfg.Chain = []string{"stage", "prod"}
	cfg.GatedEnvs = []string{"prod"}

	apps := []gate.AppSnapshot{
		{Name: "prod-payment-api", Project: "prod", SkipRequested: true},
		{Name: "prod-batch", Project: "prod"},
		// Annotated but in an environment the gate ignores anyway, so it counts
		// towards the total and not towards the bypasses that matter.
		{Name: "stage-payment-api", Project: "stage", SkipRequested: true},
		{Name: "shared-tools", Project: "shared", SkipRequested: true},
	}

	all, gated := exemptNames(cfg, apps)
	if len(all) != 3 {
		t.Errorf("all = %v, want three annotated apps", all)
	}
	if len(gated) != 1 || gated[0] != "prod-payment-api" {
		t.Errorf("gated = %v, want only prod-payment-api", gated)
	}
	// Sorted, so a restart does not reshuffle the line for no reason.
	if all[0] != "prod-payment-api" || all[1] != "shared-tools" {
		t.Errorf("all = %v, want sorted names", all)
	}
}

func TestExemptNamesWithNothingAnnotated(t *testing.T) {
	cfg := config.Default()
	cfg.Chain = []string{"stage", "prod"}
	all, gated := exemptNames(cfg, []gate.AppSnapshot{{Name: "prod-app", Project: "prod"}})
	if len(all) != 0 || len(gated) != 0 {
		t.Errorf("expected no exemptions, got %v and %v", all, gated)
	}
}

func TestTruncateNames(t *testing.T) {
	short := []string{"a", "b"}
	if got := truncateNames(short); len(got) != 2 {
		t.Errorf("truncateNames() shortened a short list: %v", got)
	}

	long := make([]string, maxExemptNamesLogged+5)
	for i := range long {
		long[i] = "app"
	}
	got := truncateNames(long)
	if len(got) != maxExemptNamesLogged+1 {
		t.Fatalf("truncateNames() = %d entries, want %d", len(got), maxExemptNamesLogged+1)
	}
	if got[len(got)-1] != "and 5 more" {
		t.Errorf("last entry = %q, want a remainder note", got[len(got)-1])
	}
}
