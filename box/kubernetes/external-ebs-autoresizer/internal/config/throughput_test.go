package config

import (
	"strings"
	"testing"
	"time"
)

// writeTRConfig writes a config file carrying the required top-level keys, so a
// test only has to supply the throughputRecommendation block it exercises.
func writeTRConfig(t *testing.T, body string) string {
	t.Helper()
	return writeConfig(t, "region: ap-northeast-2\n"+body)
}

func TestThroughputRecommendationDefaults(t *testing.T) {
	cfg, err := Load(writeTRConfig(t, ""))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	tr := cfg.ThroughputRecommendation
	if tr.Enabled {
		t.Error("enabled = true, want the recommender off by default")
	}
	// The interval defaults above reconcileInterval: the observation window spans
	// days, so a much shorter interval only re-runs the most expensive query.
	if tr.Interval != 30*time.Minute {
		t.Errorf("interval = %s, want 30m", tr.Interval)
	}
	if tr.MetricNodeNameLabel != "node" {
		t.Errorf("metricNodeNameLabel = %q, want node", tr.MetricNodeNameLabel)
	}
	if tr.LookbackWindow != "7d" {
		t.Errorf("lookbackWindow = %s, want 7d", tr.LookbackWindow)
	}
	// The parsed form is what the confidence gate needs, so it must be populated
	// alongside the string the query uses.
	if tr.LookbackDuration != 7*24*time.Hour {
		t.Errorf("lookbackDuration = %s, want 168h", tr.LookbackDuration)
	}
	// On by default: enabling the recommender is the opt-in, so piggybacking
	// rides the same switch. (It still does nothing while enabled is false.)
	if !tr.ApplyOnResize {
		t.Error("applyOnResize = false, want piggybacking on by default")
	}
}

func TestThroughputRecommendationApplyOnResizeKillSwitch(t *testing.T) {
	// An explicit false must survive the true default: it is the kill switch
	// that keeps the recommender advisory-only.
	cfg, err := Load(writeTRConfig(t, `
throughputRecommendation:
  enabled: true
  prometheusUrl: http://prometheus.monitoring
  applyOnResize: false
`))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ThroughputRecommendation.ApplyOnResize {
		t.Error("applyOnResize = true, want the explicit false honored")
	}
}

func TestThroughputRecommendationLoad(t *testing.T) {
	cfg, err := Load(writeTRConfig(t, `
throughputRecommendation:
  enabled: true
  prometheusUrl: "http://mimir-gateway.monitoring/prometheus "
  prometheusTenantId: team-a
  interval: 6h
  metricNodeNameLabel: instance
  lookbackWindow: 14d
`))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	tr := cfg.ThroughputRecommendation
	// A URL pasted with trailing whitespace must not produce a request to a host
	// with a stray space in it.
	if tr.PrometheusURL != "http://mimir-gateway.monitoring/prometheus" {
		t.Errorf("prometheusUrl = %q, want it trimmed", tr.PrometheusURL)
	}
	if tr.PrometheusTenantID != "team-a" {
		t.Errorf("tenant = %q, want team-a", tr.PrometheusTenantID)
	}
	if tr.Interval != 6*time.Hour {
		t.Errorf("interval = %s, want 6h", tr.Interval)
	}
	if tr.LookbackWindow != "14d" || tr.LookbackDuration != 14*24*time.Hour {
		t.Errorf("window = %s (%s), want 14d (336h)", tr.LookbackWindow, tr.LookbackDuration)
	}
	if tr.MetricNodeNameLabel != "instance" {
		t.Errorf("metricNodeNameLabel = %q, want instance", tr.MetricNodeNameLabel)
	}
}

// TestThroughputRecommendationRejectsRemovedKeys locks in the shrunken schema:
// every one of these was a setting once and is fixed policy in the throughput
// package now. Parsing is strict, so a config carrying a stale key fails at
// startup instead of silently having no effect.
func TestThroughputRecommendationRejectsRemovedKeys(t *testing.T) {
	removed := []string{
		"queryTimeout: 30s", "nodeSelector: a=b", "deviceRegex: nvme.+",
		`seriesSelector: cluster="a"`,
		"rateWindow: 1m", "queryStep: 1m", "quantile: 0.95",
		"byteRateQuery: up", "headroomPercent: 50", "stepMiBps: 250",
		"minThroughputMiBps: 250", "maxThroughputMiBps: 750", "minSamples: 500",
		"annotationPrefix: custom", "prometheusHeaders: {}",
		// Decreases are always reported now: the loop only annotates, so gating the
		// downward number behind a flag hid a computed result instead of a risk.
		"allowDecrease: true",
	}
	for _, key := range removed {
		if _, err := Load(writeTRConfig(t, "throughputRecommendation:\n  "+key+"\n")); err == nil {
			t.Errorf("Load() with %q error = nil, want the removed key rejected", key)
		}
	}
}

func TestThroughputRecommendationValidationErrors(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "enabled without a backend URL",
			body: "throughputRecommendation:\n  enabled: true\n",
			want: "prometheusUrl is required",
		},
		{
			name: "zero interval",
			body: "throughputRecommendation:\n  interval: 0s\n",
			want: "interval must be greater than 0",
		},
		{
			name: "node label that is not a label name",
			body: "throughputRecommendation:\n  metricNodeNameLabel: \"node-name\"\n",
			want: "must be a Prometheus label name",
		},
		{
			// Go accepts a fractional duration; PromQL does not, so a value copied
			// from reconcileInterval must fail at startup rather than at query time.
			name: "fractional lookback window that PromQL rejects",
			body: "throughputRecommendation:\n  lookbackWindow: 1.5h\n",
			want: "must be a Prometheus duration",
		},
		{
			name: "unitless lookback window",
			body: "throughputRecommendation:\n  lookbackWindow: \"300\"\n",
			want: "must be a Prometheus duration",
		},
		{
			name: "empty lookback window",
			body: "throughputRecommendation:\n  lookbackWindow: \"\"\n",
			want: "lookbackWindow is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load(writeTRConfig(t, tt.body))
			if err == nil {
				t.Fatalf("Load() error = nil, want %q", tt.want)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("error = %v, want it to contain %q", err, tt.want)
			}
		})
	}
}

func TestParsePromDuration(t *testing.T) {
	valid := map[string]time.Duration{
		"7d":    7 * 24 * time.Hour,
		"1m":    time.Minute,
		"30s":   30 * time.Second,
		"2w":    14 * 24 * time.Hour,
		"1y":    365 * 24 * time.Hour,
		"500ms": 500 * time.Millisecond,
		"1h30m": 90 * time.Minute,
		"1d12h": 36 * time.Hour,
	}
	for raw, want := range valid {
		got, d, err := parsePromDuration("window", raw)
		if err != nil {
			t.Errorf("parsePromDuration(%q) error = %v, want it accepted", raw, err)
		}
		if got != raw {
			t.Errorf("parsePromDuration(%q) = %q, want it unchanged", raw, got)
		}
		if d != want {
			t.Errorf("parsePromDuration(%q) duration = %s, want %s", raw, d, want)
		}
	}
	// Units must be in descending order, and anything that is not a duration at
	// all is rejected: these values are interpolated into a PromQL expression, so
	// the pattern is also the injection guard.
	invalid := []string{"", "  ", "5min", "300", "1m1h", "-7d", "7d)", "7d or up", "7.5d"}
	for _, raw := range invalid {
		if _, _, err := parsePromDuration("window", raw); err == nil {
			t.Errorf("parsePromDuration(%q) error = nil, want it rejected", raw)
		}
	}
}

func TestParsePromDurationTrimsWhitespace(t *testing.T) {
	got, _, err := parsePromDuration("window", "  7d  ")
	if err != nil {
		t.Fatalf("parsePromDuration() error = %v", err)
	}
	if got != "7d" {
		t.Errorf("parsePromDuration() = %q, want 7d", got)
	}
}

func TestThroughputRecommendationBearerTokenComesFromTheEnvironment(t *testing.T) {
	// The token must never be a config-file key: the chart renders the config into
	// a ConfigMap, so a file-sourced credential would be stored in plain text.
	t.Setenv("PROMETHEUS_BEARER_TOKEN", "s3cr3t")
	cfg, err := Load(writeTRConfig(t, "throughputRecommendation:\n  enabled: true\n  prometheusUrl: http://mimir\n"))
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.ThroughputRecommendation.PrometheusBearerToken != "s3cr3t" {
		t.Errorf("bearer token = %q, want it read from the environment", cfg.ThroughputRecommendation.PrometheusBearerToken)
	}

	// A file key of the same name is rejected, so a config that tries to carry the
	// token fails at startup instead of silently working.
	_, err = Load(writeTRConfig(t, "throughputRecommendation:\n  bearerToken: s3cr3t\n"))
	if err == nil {
		t.Fatal("Load() error = nil, want the unknown bearerToken key rejected")
	}
}
