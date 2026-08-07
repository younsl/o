package config

import (
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ScrapeInterval != 60*time.Second {
		t.Errorf("ScrapeInterval = %v, want 60s", cfg.ScrapeInterval)
	}
	if cfg.MetricsPort != 8081 {
		t.Errorf("MetricsPort = %d, want 8081", cfg.MetricsPort)
	}
	if cfg.HealthPort != 8080 {
		t.Errorf("HealthPort = %d, want 8080", cfg.HealthPort)
	}
	if cfg.LogLevel != "info" || cfg.LogFormat != "json" {
		t.Errorf("log defaults = %s/%s, want info/json", cfg.LogLevel, cfg.LogFormat)
	}
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv("AWS_REGION", "ap-northeast-2")
	t.Setenv("SCRAPE_INTERVAL", "5m")
	t.Setenv("METRICS_PORT", "9100")
	t.Setenv("HEALTH_PORT", "9101")
	t.Setenv("LOG_LEVEL", "debug")
	t.Setenv("LOG_FORMAT", "text")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.Region != "ap-northeast-2" {
		t.Errorf("Region = %q, want ap-northeast-2", cfg.Region)
	}
	if cfg.ScrapeInterval != 5*time.Minute {
		t.Errorf("ScrapeInterval = %v, want 5m", cfg.ScrapeInterval)
	}
	if cfg.MetricsPort != 9100 || cfg.HealthPort != 9101 {
		t.Errorf("ports = %d/%d, want 9100/9101", cfg.MetricsPort, cfg.HealthPort)
	}
	if cfg.LogLevel != "debug" || cfg.LogFormat != "text" {
		t.Errorf("log = %s/%s, want debug/text", cfg.LogLevel, cfg.LogFormat)
	}
}

func TestLoadInvalidValues(t *testing.T) {
	cases := []struct {
		name  string
		key   string
		value string
	}{
		{"malformed interval", "SCRAPE_INTERVAL", "soon"},
		{"interval below 1s", "SCRAPE_INTERVAL", "100ms"},
		{"non-numeric port", "METRICS_PORT", "http"},
		{"port out of range", "HEALTH_PORT", "70000"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv(tc.key, tc.value)
			if _, err := Load(); err == nil {
				t.Fatalf("Load() with %s=%s should fail", tc.key, tc.value)
			}
		})
	}
}
