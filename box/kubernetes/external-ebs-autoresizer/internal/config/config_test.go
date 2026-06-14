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
	if !c.ExcludeEKSNodes {
		t.Error("ExcludeEKSNodes = false, want true by default")
	}
	if !c.LeaderElect {
		t.Error("LeaderElect = false, want true by default")
	}
	if c.LeaseName != "external-ebs-autoresizer" {
		t.Errorf("LeaseName = %q, want external-ebs-autoresizer", c.LeaseName)
	}
	if c.AlertmanagerEnabled {
		t.Error("AlertmanagerEnabled = true, want false by default")
	}
	if c.AlertmanagerURL != "" {
		t.Errorf("AlertmanagerURL = %q, want empty (alerting disabled by default)", c.AlertmanagerURL)
	}
	if c.AlertmanagerTimeout != 5*time.Second {
		t.Errorf("AlertmanagerTimeout = %s, want 5s", c.AlertmanagerTimeout)
	}
	if c.AlertmanagerNotifyOn != NotifyOnSuccess {
		t.Errorf("AlertmanagerNotifyOn = %q, want %q", c.AlertmanagerNotifyOn, NotifyOnSuccess)
	}
}

func TestLoadAlertmanagerLabels(t *testing.T) {
	t.Setenv("AWS_REGION", "ap-northeast-2")
	t.Setenv("ALERTMANAGER_URL", "http://alertmanager:9093")
	t.Setenv("ALERTMANAGER_LABELS", "cluster=prod, env=production")

	c, err := Load(nil)
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
	t.Setenv("AWS_REGION", "ap-northeast-2")
	t.Setenv("GRAFANA_ANNOTATION_ENABLED", "true")
	t.Setenv("GRAFANA_URL", "http://grafana:3000")
	t.Setenv("GRAFANA_API_TOKEN", "secret")
	t.Setenv("GRAFANA_ANNOTATION_TAGS", "event:ebs-resize, app:external-ebs-autoresizer")
	t.Setenv("GRAFANA_ANNOTATE_ON", "failure")

	c, err := Load(nil)
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
	t.Setenv("AWS_REGION", "ap-northeast-2")

	c, err := Load(nil)
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
	t.Setenv("AWS_REGION", "ap-northeast-2")

	c, err := Load(nil)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(c.TagFilters) != 0 {
		t.Errorf("TagFilters = %+v, want empty (scan all instances)", c.TagFilters)
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
		{"bad threshold", map[string]string{"AWS_REGION": "r", "TAG_FILTERS": "A=b", "USAGE_THRESHOLD_PERCENT": "200"}},
		{"bad grow", map[string]string{"AWS_REGION": "r", "TAG_FILTERS": "A=b", "GROW_PERCENT": "0"}},
		{"bad notify-on", map[string]string{"AWS_REGION": "r", "ALERTMANAGER_NOTIFY_ON": "sometimes"}},
		{"enabled without url", map[string]string{"AWS_REGION": "r", "ALERTMANAGER_ENABLED": "true"}},
		{"bad annotate-on", map[string]string{"AWS_REGION": "r", "GRAFANA_ANNOTATE_ON": "sometimes"}},
		{"grafana enabled without url", map[string]string{"AWS_REGION": "r", "GRAFANA_ANNOTATION_ENABLED": "true", "GRAFANA_API_TOKEN": "t"}},
		{"grafana enabled without token", map[string]string{"AWS_REGION": "r", "GRAFANA_ANNOTATION_ENABLED": "true", "GRAFANA_URL": "http://grafana:3000"}},
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
