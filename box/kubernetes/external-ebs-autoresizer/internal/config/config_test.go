package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeConfig writes body to a temp config.yaml and returns its path. When the
// body declares no defaultPolicy at all, a minimal one carrying the two
// required fields (usageThresholdPercent, growMode) is appended so tests that
// exercise unrelated settings need not repeat it. Tests that declare their own
// defaultPolicy must include the required fields themselves.
func writeConfig(t *testing.T, body string) string {
	t.Helper()
	if !strings.Contains(body, "defaultPolicy:") {
		body += "\ndefaultPolicy:\n  usageThresholdPercent: 80\n  growMode: percent\n"
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

func TestLoadDefaults(t *testing.T) {
	path := writeConfig(t, `
region: ap-northeast-2
tagFilters: "Environment=production"
`)
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if c.Region != "ap-northeast-2" {
		t.Errorf("Region = %q, want ap-northeast-2", c.Region)
	}
	if c.ReconcileInterval != 5*time.Minute {
		t.Errorf("ReconcileInterval = %s, want 5m", c.ReconcileInterval)
	}
	if c.ReconcileConcurrency != 10 {
		t.Errorf("ReconcileConcurrency = %d, want 10", c.ReconcileConcurrency)
	}
	if c.UsageThresholdPercent != 80 {
		t.Errorf("UsageThresholdPercent = %d, want 80", c.UsageThresholdPercent)
	}
	if c.GrowPercent != 10 {
		t.Errorf("GrowPercent = %d, want 10", c.GrowPercent)
	}
	if c.MaxVolumeSizeGiB != 1000 {
		t.Errorf("MaxVolumeSizeGiB = %d, want 1000", c.MaxVolumeSizeGiB)
	}
	if c.HealthPort != 8080 || c.MetricsPort != 8081 {
		t.Errorf("ports = %d/%d, want 8080/8081", c.HealthPort, c.MetricsPort)
	}
	if len(c.TagFilters) != 1 || c.TagFilters[0].Key != "Environment" || c.TagFilters[0].Value != "production" {
		t.Errorf("TagFilters = %+v, want [{Environment production}]", c.TagFilters)
	}
	if !c.ExcludeEKSNodes {
		t.Error("ExcludeEKSNodes = false, want true by default")
	}
	if !c.LeaderElect {
		t.Error("LeaderElect = false, want true by default")
	}
	if c.LeaseName != "external-ebs-autoresizer" {
		t.Errorf("LeaseName = %q, want external-ebs-autoresizer", c.LeaseName)
	}
	if c.LogLevel != "info" || c.LogFormat != "json" {
		t.Errorf("log = %q/%q, want info/json", c.LogLevel, c.LogFormat)
	}
	if c.AlertmanagerEnabled {
		t.Error("AlertmanagerEnabled = true, want false by default")
	}
	if c.AlertmanagerTimeout != 5*time.Second {
		t.Errorf("AlertmanagerTimeout = %s, want 5s", c.AlertmanagerTimeout)
	}
	if c.AlertmanagerNotifyOn != NotifyOnSuccess {
		t.Errorf("AlertmanagerNotifyOn = %q, want %q", c.AlertmanagerNotifyOn, NotifyOnSuccess)
	}
}

// TestLoadExplicitZeros verifies that explicit falsey values in the file win
// over the pre-filled defaults.
func TestLoadExplicitZeros(t *testing.T) {
	path := writeConfig(t, `
region: r
excludeEKSNodes: false
leaderElect: false
defaultPolicy:
  usageThresholdPercent: 0
  growMode: percent
`)
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if c.ExcludeEKSNodes {
		t.Error("ExcludeEKSNodes = true, want false (explicit)")
	}
	if c.LeaderElect {
		t.Error("LeaderElect = true, want false (explicit)")
	}
	if c.UsageThresholdPercent != 0 {
		t.Errorf("UsageThresholdPercent = %d, want 0 (explicit)", c.UsageThresholdPercent)
	}
}

func TestLoadAlertmanagerLabels(t *testing.T) {
	path := writeConfig(t, `
region: ap-northeast-2
alertmanager:
  url: "http://alertmanager:9093"
  labels:
    cluster: prod
    env: production
`)
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if c.AlertmanagerURL != "http://alertmanager:9093" {
		t.Errorf("AlertmanagerURL = %q", c.AlertmanagerURL)
	}
	if c.AlertmanagerLabels["cluster"] != "prod" || c.AlertmanagerLabels["env"] != "production" {
		t.Errorf("AlertmanagerLabels = %v, want cluster=prod env=production", c.AlertmanagerLabels)
	}
}

func TestLoadGrafanaAnnotation(t *testing.T) {
	t.Setenv("GRAFANA_API_TOKEN", "secret")
	path := writeConfig(t, `
region: ap-northeast-2
grafanaAnnotation:
  enabled: true
  url: "http://grafana:3000"
  tags:
    - event:ebs-resize
    - app:external-ebs-autoresizer
  annotateOn: failure
`)
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if !c.GrafanaAnnotationEnabled || c.GrafanaURL != "http://grafana:3000" || c.GrafanaAPIToken != "secret" {
		t.Errorf("grafana fields = (%v, %q, %q)", c.GrafanaAnnotationEnabled, c.GrafanaURL, c.GrafanaAPIToken)
	}
	if len(c.GrafanaAnnotationTags) != 2 || c.GrafanaAnnotationTags[0] != "event:ebs-resize" {
		t.Errorf("GrafanaAnnotationTags = %v", c.GrafanaAnnotationTags)
	}
	if c.GrafanaAnnotateOn != AnnotateOnFailure {
		t.Errorf("GrafanaAnnotateOn = %q, want failure", c.GrafanaAnnotateOn)
	}
}

func TestLoadGrafanaDefaultsDisabled(t *testing.T) {
	path := writeConfig(t, "region: ap-northeast-2\n")
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if c.GrafanaAnnotationEnabled {
		t.Error("GrafanaAnnotationEnabled should default to false")
	}
	if c.GrafanaAnnotateOn != AnnotateOnAll {
		t.Errorf("GrafanaAnnotateOn = %q, want all", c.GrafanaAnnotateOn)
	}
	// Default base tag is the dashboard-subscription tag.
	if len(c.GrafanaAnnotationTags) != 1 || c.GrafanaAnnotationTags[0] != "event:ebs-resize" {
		t.Errorf("GrafanaAnnotationTags = %v, want [event:ebs-resize]", c.GrafanaAnnotationTags)
	}
}

func TestLoadAllowsEmptyTagFilters(t *testing.T) {
	path := writeConfig(t, "region: ap-northeast-2\n")
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(c.TagFilters) != 0 {
		t.Errorf("TagFilters = %+v, want empty (scan all instances)", c.TagFilters)
	}
}

func TestLoadOverrides(t *testing.T) {
	path := writeConfig(t, `
region: us-east-1
tagFilters: "App=web, Tier=db"
reconcileInterval: 30s
dryRun: true
logFormat: text
defaultPolicy:
  usageThresholdPercent: 90
  growMode: percent
  growPercent: 25
`)
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if c.ReconcileInterval != 30*time.Second {
		t.Errorf("ReconcileInterval = %s, want 30s", c.ReconcileInterval)
	}
	if c.UsageThresholdPercent != 90 {
		t.Errorf("UsageThresholdPercent = %d, want 90", c.UsageThresholdPercent)
	}
	if c.GrowPercent != 25 {
		t.Errorf("GrowPercent = %d, want 25", c.GrowPercent)
	}
	if !c.DryRun {
		t.Error("DryRun = false, want true")
	}
	if c.LogFormat != "text" {
		t.Errorf("LogFormat = %q, want text", c.LogFormat)
	}
	if len(c.TagFilters) != 2 {
		t.Fatalf("TagFilters len = %d, want 2", len(c.TagFilters))
	}
	if c.TagFilters[1].Key != "Tier" || c.TagFilters[1].Value != "db" {
		t.Errorf("TagFilters[1] = %+v, want {Tier db}", c.TagFilters[1])
	}
}

func TestLoadReconcileIntervalUnits(t *testing.T) {
	cases := map[string]time.Duration{
		"30s":      30 * time.Second,
		"5m":       5 * time.Minute,
		"1h":       time.Hour,
		"1h30m":    90 * time.Minute,
		"2h15m30s": 2*time.Hour + 15*time.Minute + 30*time.Second,
	}
	for in, want := range cases {
		t.Run(in, func(t *testing.T) {
			path := writeConfig(t, fmt.Sprintf("region: ap-northeast-2\nreconcileInterval: %q\n", in))
			c, err := Load(path)
			if err != nil {
				t.Fatalf("Load returned error: %v", err)
			}
			if c.ReconcileInterval != want {
				t.Errorf("ReconcileInterval = %s, want %s", c.ReconcileInterval, want)
			}
		})
	}
}

func TestLoadInvalidDurationFails(t *testing.T) {
	for _, bad := range []string{"1hour", "5min", "300", "abc"} {
		t.Run(bad, func(t *testing.T) {
			path := writeConfig(t, fmt.Sprintf("region: ap-northeast-2\nreconcileInterval: %q\n", bad))
			if _, err := Load(path); err == nil {
				t.Errorf("Load with reconcileInterval=%q = nil error, want failure", bad)
			}
		})
	}
}

func TestLoadMissingFile(t *testing.T) {
	if _, err := Load("/nonexistent/config.yaml"); err == nil {
		t.Error("Load missing file = nil error, want error")
	}
}

func TestLoadUnknownFieldFails(t *testing.T) {
	path := writeConfig(t, "region: r\nbogusField: 1\n")
	if _, err := Load(path); err == nil {
		t.Error("Load with unknown field = nil error, want strict-parse error")
	}
}

func TestLoadPolicies(t *testing.T) {
	path := writeConfig(t, `
region: ap-northeast-2
policies:
  - name: db-nodes
    weight: 10
    instanceSelector:
      tags:
        Role: database
      nameRegex: "^prod-db-.*"
    resize:
      usageThresholdPercent: 70
      growMode: absolute
      growAmount: 50GiB
      maxVolumeSizeGiB: 2000
  - name: batch
    weight: 1
    instanceSelector:
      nameRegex: "^batch-.*"
    resize:
      growPercent: 30
`)
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(c.Policies) != 2 {
		t.Fatalf("Policies len = %d, want 2", len(c.Policies))
	}
	p := c.Policies[0]
	if p.Name != "db-nodes" || p.Weight != 10 {
		t.Errorf("policy[0] = %+v, want db-nodes/10", p)
	}
	if p.InstanceSelector.Tags["Role"] != "database" || p.InstanceSelector.NameRegex != "^prod-db-.*" {
		t.Errorf("policy[0] selector = %+v", p.InstanceSelector)
	}
	if p.Resize.UsageThresholdPercent == nil || *p.Resize.UsageThresholdPercent != 70 {
		t.Errorf("policy[0] resize.usageThresholdPercent = %v, want 70", p.Resize.UsageThresholdPercent)
	}
	if p.Resize.GrowAmount == nil || *p.Resize.GrowAmount != "50GiB" {
		t.Errorf("policy[0] resize.growAmount = %v, want 50GiB", p.Resize.GrowAmount)
	}
}

func TestLoadValidationErrors(t *testing.T) {
	tests := map[string]string{
		"missing region":              "tagFilters: A=b\n",
		"bad threshold":               "region: r\ndefaultPolicy:\n  usageThresholdPercent: 200\n",
		"bad grow":                    "region: r\ndefaultPolicy:\n  growPercent: 0\n",
		"bad notify-on":               "region: r\nalertmanager:\n  notifyOn: sometimes\n",
		"enabled without url":         "region: r\nalertmanager:\n  enabled: true\n",
		"bad annotate-on":             "region: r\ngrafanaAnnotation:\n  annotateOn: sometimes\n",
		"grafana enabled without url": "region: r\ngrafanaAnnotation:\n  enabled: true\n",
		"bad tag filter":              "region: r\ntagFilters: KeyOnly\n",
	}
	for name, body := range tests {
		t.Run(name, func(t *testing.T) {
			path := writeConfig(t, body)
			if _, err := Load(path); err == nil {
				t.Errorf("Load(%s) = nil error, want error", name)
			}
		})
	}
}

// TestLoadGrafanaEnabledWithoutToken verifies the token requirement, which is
// sourced from the environment rather than the file.
func TestLoadGrafanaEnabledWithoutToken(t *testing.T) {
	path := writeConfig(t, `
region: r
grafanaAnnotation:
  enabled: true
  url: "http://grafana:3000"
`)
	if _, err := Load(path); err == nil {
		t.Error("Load with grafana enabled but no GRAFANA_API_TOKEN = nil error, want error")
	}
}

func TestLoadDefaultPolicyRequiredFields(t *testing.T) {
	// growMode present, usageThresholdPercent missing.
	noThreshold := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(noThreshold, []byte("region: r\ndefaultPolicy:\n  growMode: percent\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(noThreshold); err == nil {
		t.Error("Load without defaultPolicy.usageThresholdPercent = nil error, want required error")
	}
	// usageThresholdPercent present, growMode missing.
	noMode := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(noMode, []byte("region: r\ndefaultPolicy:\n  usageThresholdPercent: 80\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(noMode); err == nil {
		t.Error("Load without defaultPolicy.growMode = nil error, want required error")
	}
}

func TestLoadDefaultGrowMode(t *testing.T) {
	path := writeConfig(t, "region: ap-northeast-2\n")
	c, err := Load(path)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if c.GrowMode != GrowModePercent {
		t.Errorf("GrowMode = %q, want %q", c.GrowMode, GrowModePercent)
	}
	// growAmount is always parsed, even in percent mode, so per-group policies
	// that switch to absolute mode inherit a usable default amount. The default
	// growAmount is 10GiB.
	if c.GrowAmountGiB != 10 {
		t.Errorf("GrowAmountGiB = %d, want 10 (default growAmount parsed regardless of mode)", c.GrowAmountGiB)
	}
}

func TestLoadAbsoluteGrowMode(t *testing.T) {
	cases := map[string]int32{
		"10GiB":   10,
		"5120MiB": 5,
		"1500MiB": 2, // rounds up to the next whole GiB
		"20Gi":    20,
		"2048Mi":  2,
	}
	for in, want := range cases {
		t.Run(in, func(t *testing.T) {
			path := writeConfig(t, fmt.Sprintf("region: ap-northeast-2\ndefaultPolicy:\n  usageThresholdPercent: 80\n  growMode: absolute\n  growAmount: %q\n", in))
			c, err := Load(path)
			if err != nil {
				t.Fatalf("Load returned error: %v", err)
			}
			if c.GrowMode != GrowModeAbsolute {
				t.Errorf("GrowMode = %q, want %q", c.GrowMode, GrowModeAbsolute)
			}
			if c.GrowAmountGiB != want {
				t.Errorf("GrowAmountGiB = %d, want %d", c.GrowAmountGiB, want)
			}
		})
	}
}

func TestLoadAbsoluteGrowModeInvalid(t *testing.T) {
	for _, bad := range []string{"10", "10TiB", "GiB", "-5GiB", "0GiB"} {
		t.Run(bad, func(t *testing.T) {
			path := writeConfig(t, fmt.Sprintf("region: ap-northeast-2\ndefaultPolicy:\n  usageThresholdPercent: 80\n  growMode: absolute\n  growAmount: %q\n", bad))
			if _, err := Load(path); err == nil {
				t.Errorf("Load with growAmount=%q = nil error, want failure", bad)
			}
		})
	}
}

func TestLoadInvalidGrowModeFails(t *testing.T) {
	path := writeConfig(t, "region: ap-northeast-2\ndefaultPolicy:\n  usageThresholdPercent: 80\n  growMode: exponential\n")
	if _, err := Load(path); err == nil {
		t.Error("Load with growMode=exponential = nil error, want failure")
	}
}

func TestParseGrowAmount(t *testing.T) {
	valid := map[string]int32{
		"1GiB":     1,
		"1024MiB":  1,
		"1025MiB":  2,
		"100Gi":    100,
		"65536GiB": 65536,
	}
	for in, want := range valid {
		got, err := ParseGrowAmount(in)
		if err != nil || got != want {
			t.Errorf("ParseGrowAmount(%q) = (%d, %v), want (%d, nil)", in, got, err, want)
		}
	}
	for _, in := range []string{"", "abc", "10", "10KiB", "GiB", "0MiB", "65537GiB", "9223372036854775807MiB"} {
		if _, err := ParseGrowAmount(in); err == nil {
			t.Errorf("ParseGrowAmount(%q) = nil error, want error", in)
		}
	}
}

func TestParseTagFiltersInvalid(t *testing.T) {
	if _, err := parseTagFilters("KeyOnly"); err == nil {
		t.Error("parseTagFilters(KeyOnly) = nil error, want error")
	}
	if _, err := parseTagFilters("=value"); err == nil {
		t.Error("parseTagFilters(=value) = nil error, want error")
	}
	got, err := parseTagFilters("")
	if err != nil || got != nil {
		t.Errorf("parseTagFilters(empty) = (%v, %v), want (nil, nil)", got, err)
	}
}
