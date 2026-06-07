package config

import (
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("AWS_REGION", "ap-northeast-2")
	t.Setenv("TAG_FILTERS", "Environment=production")

	c, err := Load(nil)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if c.Region != "ap-northeast-2" {
		t.Errorf("Region = %q, want ap-northeast-2", c.Region)
	}
	if c.ReconcileInterval != 5*time.Minute {
		t.Errorf("ReconcileInterval = %s, want 5m", c.ReconcileInterval)
	}
	if c.UsageThresholdPercent != 80 {
		t.Errorf("UsageThresholdPercent = %d, want 80", c.UsageThresholdPercent)
	}
	if c.GrowPercent != 10 {
		t.Errorf("GrowPercent = %d, want 10", c.GrowPercent)
	}
	if len(c.TagFilters) != 1 || c.TagFilters[0].Key != "Environment" || c.TagFilters[0].Value != "production" {
		t.Errorf("TagFilters = %+v, want [{Environment production}]", c.TagFilters)
	}
	if !c.LeaderElect {
		t.Error("LeaderElect = false, want true by default")
	}
	if c.LeaseName != "external-ebs-autoresizer" {
		t.Errorf("LeaseName = %q, want external-ebs-autoresizer", c.LeaseName)
	}
}

func TestLoadEnvOverrides(t *testing.T) {
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("TAG_FILTERS", "App=web, Tier=db")
	t.Setenv("RECONCILE_INTERVAL", "30s")
	t.Setenv("USAGE_THRESHOLD_PERCENT", "90")
	t.Setenv("GROW_PERCENT", "25")
	t.Setenv("DRY_RUN", "true")
	t.Setenv("LOG_FORMAT", "text")

	c, err := Load(nil)
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
			t.Setenv("AWS_REGION", "ap-northeast-2")
			t.Setenv("TAG_FILTERS", "App=web")
			t.Setenv("RECONCILE_INTERVAL", in)

			c, err := Load(nil)
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
	for _, bad := range []string{"1hour", "5min", "300", "abc", ""} {
		t.Run(bad, func(t *testing.T) {
			t.Setenv("AWS_REGION", "ap-northeast-2")
			t.Setenv("TAG_FILTERS", "App=web")
			t.Setenv("RECONCILE_INTERVAL", bad)

			if _, err := Load(nil); err == nil {
				t.Errorf("Load with RECONCILE_INTERVAL=%q = nil error, want failure", bad)
			}
		})
	}
}

func TestLoadFlagOverridesEnv(t *testing.T) {
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("TAG_FILTERS", "App=web")

	c, err := Load([]string{"--region", "eu-west-1", "--grow-percent", "15"})
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if c.Region != "eu-west-1" {
		t.Errorf("Region = %q, want eu-west-1 (flag override)", c.Region)
	}
	if c.GrowPercent != 15 {
		t.Errorf("GrowPercent = %d, want 15", c.GrowPercent)
	}
}

func TestLoadValidationErrors(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{"missing region", map[string]string{"TAG_FILTERS": "A=b"}},
		{"missing tag filters", map[string]string{"AWS_REGION": "r"}},
		{"bad threshold", map[string]string{"AWS_REGION": "r", "TAG_FILTERS": "A=b", "USAGE_THRESHOLD_PERCENT": "200"}},
		{"bad grow", map[string]string{"AWS_REGION": "r", "TAG_FILTERS": "A=b", "GROW_PERCENT": "0"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for k, v := range tt.env {
				t.Setenv(k, v)
			}
			if _, err := Load(nil); err == nil {
				t.Errorf("Load(%v) = nil error, want error", tt.env)
			}
		})
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
