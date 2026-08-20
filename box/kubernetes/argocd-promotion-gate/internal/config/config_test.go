package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseMinimalAppliesDefaults(t *testing.T) {
	cfg, err := Parse([]byte("chain: [dev, sb, stg, prd]\n"))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if len(cfg.GatedEnvs) != 0 {
		t.Errorf("GatedEnvs = %v, want empty", cfg.GatedEnvs)
	}
	if !cfg.Require.Sync || !cfg.Require.Health {
		t.Errorf("Require = %+v, want both true", cfg.Require)
	}
	if !cfg.ImageTag.Enabled {
		t.Error("ImageTag.Enabled = false, want true")
	}
	// warn is the deliberate default: enforcing tag equality on an estate that
	// never had it can block every pending production sync at once.
	if cfg.ImageTag.Mode != ImageTagModeWarn {
		t.Errorf("ImageTag.Mode = %q, want %q", cfg.ImageTag.Mode, ImageTagModeWarn)
	}
	if cfg.ImageTag.OnError != OnErrorDeny {
		t.Errorf("ImageTag.OnError = %q, want %q", cfg.ImageTag.OnError, OnErrorDeny)
	}
	if cfg.ArgoCD.Namespace != "argocd" {
		t.Errorf("ArgoCD.Namespace = %q, want argocd", cfg.ArgoCD.Namespace)
	}
	if cfg.ArgoCD.InsecureSkipVerify {
		t.Error("ArgoCD.InsecureSkipVerify = true, want false by default")
	}
	if len(cfg.Exempt.Usernames) != 1 || cfg.Exempt.Usernames[0] != "system:serviceaccount:argocd:argocd-application-controller" {
		t.Errorf("Exempt.Usernames = %v, want the application controller", cfg.Exempt.Usernames)
	}
}

func TestParseFullConfig(t *testing.T) {
	raw := []byte(`
chain: [dev, stg, prd]
gatedEnvs: [prd]
require:
  sync: true
  health: false
imageTag:
  enabled: true
  mode: enforce
  kinds: [Deployment]
  ignoreRepos: [nginx, 'autoinstrumentation-*']
  onError: allow
exempt:
  usernames: [system:serviceaccount:argocd:argocd-application-controller]
  automated: false
  annotation: gate.example.com/skip
argocd:
  namespace: gitops
  serverAddress: https://argocd.example.com
  caFile: /run/ca.crt
  insecureSkipVerify: false
  tokenPath: /run/token
  timeoutSeconds: 5
  cacheTtlSeconds: 60
`)
	cfg, err := Parse(raw)
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if cfg.Require.Health {
		t.Error("Require.Health = true, want false")
	}
	if cfg.ImageTag.Mode != ImageTagModeEnforce {
		t.Errorf("ImageTag.Mode = %q, want enforce", cfg.ImageTag.Mode)
	}
	if cfg.ImageTag.OnError != OnErrorAllow {
		t.Errorf("ImageTag.OnError = %q, want allow", cfg.ImageTag.OnError)
	}
	if len(cfg.ImageTag.IgnoreRepos) != 2 {
		t.Errorf("ImageTag.IgnoreRepos = %v, want 2 entries", cfg.ImageTag.IgnoreRepos)
	}
	if cfg.Exempt.Automated {
		t.Error("Exempt.Automated = true, want false")
	}
	if cfg.ArgoCD.CAFile != "/run/ca.crt" {
		t.Errorf("ArgoCD.CAFile = %q", cfg.ArgoCD.CAFile)
	}
	if cfg.ArgoCD.TimeoutSeconds != 5 || cfg.ArgoCD.CacheTTLSeconds != 60 {
		t.Errorf("ArgoCD timing = %d/%d, want 5/60", cfg.ArgoCD.TimeoutSeconds, cfg.ArgoCD.CacheTTLSeconds)
	}
}

func TestParseRejectsInvalidConfig(t *testing.T) {
	cases := map[string]string{
		"empty chain":              "chain: []\n",
		"single entry chain":       "chain: [prd]\n",
		"duplicate chain entry":    "chain: [dev, dev, prd]\n",
		"empty chain entry":        "chain: ['', prd]\n",
		"gated env outside chain":  "chain: [dev, prd]\ngatedEnvs: [stg]\n",
		"gated chain head":         "chain: [dev, prd]\ngatedEnvs: [dev]\n",
		"unknown key":              "chain: [dev, prd]\nnope: true\n",
		"missingUpstream is gone":  "chain: [dev, prd]\nmissingUpstream: allow\n",
		"bad imageTag mode":        "chain: [dev, prd]\nimageTag:\n  mode: sometimes\n",
		"bad imageTag onError":     "chain: [dev, prd]\nimageTag:\n  onError: sometimes\n",
		"empty kinds when enabled": "chain: [dev, prd]\nimageTag:\n  kinds: []\n",
		"empty serverAddress":      "chain: [dev, prd]\nargocd:\n  serverAddress: ''\n",
		"empty annotation":         "chain: [dev, prd]\nexempt:\n  annotation: ''\n",
		"empty namespace":          "chain: [dev, prd]\nargocd:\n  namespace: ''\n",
		"zero timeout":             "chain: [dev, prd]\nargocd:\n  timeoutSeconds: 0\n",
		"negative cache ttl":       "chain: [dev, prd]\nargocd:\n  cacheTtlSeconds: -1\n",
		"malformed yaml":           "chain: [dev\n",
	}
	for name, raw := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(raw)); err == nil {
				t.Fatalf("Parse(%q) = nil error, want failure", raw)
			}
		})
	}
}

func TestParseAllowsEmptyKindsWhenImageCheckDisabled(t *testing.T) {
	cfg, err := Parse([]byte("chain: [dev, prd]\nimageTag:\n  enabled: false\n  kinds: []\n"))
	if err != nil {
		t.Fatalf("Parse() error = %v", err)
	}
	if cfg.ImageTag.Enabled {
		t.Error("ImageTag.Enabled = true, want false")
	}
}

func TestLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("chain: [dev, prd]\ngatedEnvs: [prd]\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if len(cfg.Chain) != 2 {
		t.Errorf("Chain = %v, want 2 entries", cfg.Chain)
	}

	if _, err := Load(filepath.Join(dir, "missing.yaml")); err == nil {
		t.Error("Load() on a missing file = nil error, want failure")
	}

	bad := filepath.Join(dir, "bad.yaml")
	if err := os.WriteFile(bad, []byte("chain: [prd]\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := Load(bad); err == nil {
		t.Error("Load() on an invalid config = nil error, want failure")
	}
}

func TestUpstreamEnv(t *testing.T) {
	cfg := Config{Chain: []string{"dev", "sb", "stg", "prd"}}
	cases := []struct {
		env      string
		upstream string
		ok       bool
	}{
		{"prd", "stg", true},
		{"stg", "sb", true},
		{"sb", "dev", true},
		{"dev", "", false},
		{"shared", "", false},
	}
	for _, tc := range cases {
		got, ok := cfg.UpstreamEnv(tc.env)
		if got != tc.upstream || ok != tc.ok {
			t.Errorf("UpstreamEnv(%q) = (%q, %v), want (%q, %v)", tc.env, got, ok, tc.upstream, tc.ok)
		}
	}
}

func TestIsGated(t *testing.T) {
	chain := []string{"dev", "sb", "stg", "prd"}

	explicit := Config{Chain: chain, GatedEnvs: []string{"prd"}}
	if !explicit.IsGated("prd") {
		t.Error("IsGated(prd) = false with prd listed, want true")
	}
	if explicit.IsGated("stg") {
		t.Error("IsGated(stg) = true with only prd listed, want false")
	}

	// An empty list means the whole chain except the head, which has nothing
	// upstream to wait for.
	implicit := Config{Chain: chain}
	for _, env := range []string{"prd", "stg", "sb"} {
		if !implicit.IsGated(env) {
			t.Errorf("IsGated(%q) = false with an empty GatedEnvs, want true", env)
		}
	}
	if implicit.IsGated("dev") {
		t.Error("IsGated(dev) = true for the chain head, want false")
	}
	if implicit.IsGated("shared") {
		t.Error("IsGated(shared) = true for an env outside the chain, want false")
	}
}

func TestDefaultIsValidOnceChainIsSet(t *testing.T) {
	cfg := Default()
	cfg.Chain = []string{"dev", "prd"}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("Default().Validate() error = %v", err)
	}
}
