package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/policy"
)

func writeCfg(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

const validCfg = `
region: ap-northeast-2
defaultPolicy:
  usageThresholdPercent: 80
  growMode: percent
  growPercent: 10
policies:
  - name: db
    weight: 5
    instanceSelector:
      tags:
        Role: database
      nameRegex: "^prod-db-"
    resize:
      paused: true
      growMode: absolute
      growAmount: 50GiB
  - name: batch
    weight: 1
    instanceSelector:
      nameRegex: "^batch-"
    resize:
      growPercent: 30
`

func TestConfigFilePath(t *testing.T) {
	t.Setenv("CONFIG_FILE", "/custom/path.yaml")
	if got := configFilePath(); got != "/custom/path.yaml" {
		t.Errorf("configFilePath() = %q, want /custom/path.yaml", got)
	}
	os.Unsetenv("CONFIG_FILE")
	if got := configFilePath(); got != config.DefaultConfigFile {
		t.Errorf("configFilePath() = %q, want %q", got, config.DefaultConfigFile)
	}
}

func TestRunValidate(t *testing.T) {
	if err := runValidate(writeCfg(t, validCfg)); err != nil {
		t.Errorf("runValidate(valid) = %v, want nil", err)
	}
	if err := runValidate("/nonexistent/config.yaml"); err == nil {
		t.Error("runValidate(missing) = nil, want error")
	}
	// Valid YAML, invalid policy (no selector) -> caught by policy.New.
	bad := writeCfg(t, "region: r\npolicies:\n  - name: x\n")
	if err := runValidate(bad); err == nil {
		t.Error("runValidate(bad policy) = nil, want error")
	}
	// Invalid config value -> caught by config.Load.
	badCfg := writeCfg(t, "region: r\ndefaultPolicy:\n  growMode: sideways\n")
	if err := runValidate(badCfg); err == nil {
		t.Error("runValidate(bad growMode) = nil, want error")
	}
}

func TestRunPolicies(t *testing.T) {
	if err := runPolicies(context.Background(), writeCfg(t, validCfg), false); err != nil {
		t.Errorf("runPolicies(valid) = %v, want nil", err)
	}
	if err := runPolicies(context.Background(), "/nonexistent/config.yaml", false); err == nil {
		t.Error("runPolicies(missing) = nil, want error")
	}
}

func TestRootCommandWiring(t *testing.T) {
	root := newRootCommand()
	got := map[string]bool{}
	for _, c := range root.Commands() {
		got[c.Name()] = true
	}
	for _, want := range []string{"run", "validate", "policies", "instances"} {
		if !got[want] {
			t.Errorf("root command missing subcommand %q", want)
		}
	}
	if root.PersistentFlags().Lookup("config") == nil {
		t.Error("root missing persistent --config flag")
	}
}

func TestGrowSummary(t *testing.T) {
	pct := policy.Effective{GrowMode: config.GrowModePercent, GrowPercent: 15}
	if got := growSummary(pct); got != "percent +15%" {
		t.Errorf("growSummary(percent) = %q", got)
	}
	abs := policy.Effective{GrowMode: config.GrowModeAbsolute, GrowAmountGiB: 40}
	if got := growSummary(abs); got != "absolute +40GiB" {
		t.Errorf("growSummary(absolute) = %q", got)
	}
}

func TestWeightAndSelectorOf(t *testing.T) {
	cfg, err := config.Load(writeCfg(t, validCfg))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := weightOf(cfg, "db"); got != 5 {
		t.Errorf("weightOf(db) = %d, want 5", got)
	}
	if got := weightOf(cfg, "missing"); got != 0 {
		t.Errorf("weightOf(missing) = %d, want 0", got)
	}
	// Tags rendered sorted and ANDed with the name regex.
	if got := selectorOf(cfg, "db"); got != "Role=database & name~^prod-db-" {
		t.Errorf("selectorOf(db) = %q", got)
	}
	if got := selectorOf(cfg, "batch"); got != "name~^batch-" {
		t.Errorf("selectorOf(batch) = %q", got)
	}
	if got := selectorOf(cfg, "missing"); got != "" {
		t.Errorf("selectorOf(missing) = %q, want empty", got)
	}
}
