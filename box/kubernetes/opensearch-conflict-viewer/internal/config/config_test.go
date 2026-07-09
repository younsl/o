package config

import (
	"testing"
	"time"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("OPENSEARCH_URL", "https://opensearch.example.com:443")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.IndexTargets != "logs-*" {
		t.Errorf("IndexTargets = %q, want logs-*", cfg.IndexTargets)
	}
	if cfg.KibanaIndex != ".kibana" {
		t.Errorf("KibanaIndex = %q, want .kibana", cfg.KibanaIndex)
	}
	if cfg.RefreshInterval != time.Hour {
		t.Errorf("RefreshInterval = %s, want 1h", cfg.RefreshInterval)
	}
	if cfg.ListenPort != 8080 {
		t.Errorf("ListenPort = %d, want 8080", cfg.ListenPort)
	}
	if cfg.LogLevel != "info" || cfg.LogFormat != "json" {
		t.Errorf("log defaults = (%q, %q), want (info, json)", cfg.LogLevel, cfg.LogFormat)
	}
}

func TestLoadOverrides(t *testing.T) {
	t.Setenv("OPENSEARCH_URL", "https://opensearch.example.com:443")
	t.Setenv("OPENSEARCH_USERNAME", "viewer")
	t.Setenv("OPENSEARCH_PASSWORD", "secret")
	t.Setenv("INDEX_TARGETS", "logs-*,logstash-*")
	t.Setenv("KIBANA_INDEX", ".kibana_1")
	t.Setenv("REFRESH_INTERVAL", "30m")
	t.Setenv("LISTEN_PORT", "9090")
	t.Setenv("CLUSTER_NAME", "example-cluster")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Username != "viewer" || cfg.Password != "secret" {
		t.Error("credentials not loaded")
	}
	if cfg.IndexTargets != "logs-*,logstash-*" {
		t.Errorf("IndexTargets = %q", cfg.IndexTargets)
	}
	if cfg.KibanaIndex != ".kibana_1" {
		t.Errorf("KibanaIndex = %q", cfg.KibanaIndex)
	}
	if cfg.RefreshInterval != 30*time.Minute {
		t.Errorf("RefreshInterval = %s, want 30m", cfg.RefreshInterval)
	}
	if cfg.ListenPort != 9090 {
		t.Errorf("ListenPort = %d, want 9090", cfg.ListenPort)
	}
	if cfg.ClusterName != "example-cluster" {
		t.Errorf("ClusterName = %q", cfg.ClusterName)
	}
}

func TestLoadErrors(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
	}{
		{"missing url", map[string]string{}},
		{"bad interval", map[string]string{
			"OPENSEARCH_URL":   "https://opensearch.example.com",
			"REFRESH_INTERVAL": "soon",
		}},
		{"interval too small", map[string]string{
			"OPENSEARCH_URL":   "https://opensearch.example.com",
			"REFRESH_INTERVAL": "10s",
		}},
		{"bad port", map[string]string{
			"OPENSEARCH_URL": "https://opensearch.example.com",
			"LISTEN_PORT":    "http",
		}},
		{"port out of range", map[string]string{
			"OPENSEARCH_URL": "https://opensearch.example.com",
			"LISTEN_PORT":    "70000",
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			if _, err := Load(); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}
