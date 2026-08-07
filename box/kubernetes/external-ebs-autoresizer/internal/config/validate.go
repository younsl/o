package config

import "fmt"

// validate checks the fully loaded Config for internal consistency. It runs
// once at the end of Load, after every raw value has been parsed, so each rule
// here can assume typed fields (durations, GiB sizes) are already populated.
func (c *Config) validate() error {
	if c.Region == "" {
		return fmt.Errorf("region is required")
	}
	if c.UsageThresholdPercent < 0 || c.UsageThresholdPercent > 100 {
		return fmt.Errorf("usageThresholdPercent must be between 0 and 100, got %d", c.UsageThresholdPercent)
	}
	switch c.GrowMode {
	case GrowModePercent:
		if c.GrowPercent <= 0 {
			return fmt.Errorf("growPercent must be greater than 0, got %d", c.GrowPercent)
		}
	case GrowModeAbsolute:
		if c.GrowAmountGiB <= 0 {
			return fmt.Errorf("growAmount must resolve to at least 1 GiB, got %q", c.GrowAmount)
		}
	default:
		return fmt.Errorf("growMode must be one of %s, %s, got %q", GrowModePercent, GrowModeAbsolute, c.GrowMode)
	}
	if c.MaxVolumeSizeGiB <= 0 {
		return fmt.Errorf("maxVolumeSizeGiB must be greater than 0, got %d", c.MaxVolumeSizeGiB)
	}
	if c.ReconcileInterval <= 0 {
		return fmt.Errorf("reconcileInterval must be greater than 0, got %s", c.ReconcileInterval)
	}
	if c.ReconcileConcurrency <= 0 {
		return fmt.Errorf("reconcileConcurrency must be greater than 0, got %d", c.ReconcileConcurrency)
	}
	if c.SSMPollInterval <= 0 {
		return fmt.Errorf("ssmPollInterval must be greater than 0, got %s", c.SSMPollInterval)
	}
	switch c.AlertmanagerNotifyOn {
	case NotifyOnAll, NotifyOnSuccess, NotifyOnFailure:
	default:
		return fmt.Errorf("alertmanager.notifyOn must be one of %s, %s, %s, got %q", NotifyOnAll, NotifyOnSuccess, NotifyOnFailure, c.AlertmanagerNotifyOn)
	}
	if c.AlertmanagerEnabled && c.AlertmanagerURL == "" {
		return fmt.Errorf("alertmanager.url is required when alertmanager.enabled is true")
	}
	switch c.GrafanaAnnotateOn {
	case AnnotateOnAll, AnnotateOnSuccess, AnnotateOnFailure:
	default:
		return fmt.Errorf("grafanaAnnotation.annotateOn must be one of %s, %s, %s, got %q", AnnotateOnAll, AnnotateOnSuccess, AnnotateOnFailure, c.GrafanaAnnotateOn)
	}
	if c.GrafanaAnnotationEnabled {
		if c.GrafanaURL == "" {
			return fmt.Errorf("grafanaAnnotation.url is required when grafanaAnnotation.enabled is true")
		}
		if c.GrafanaAPIToken == "" {
			return fmt.Errorf("GRAFANA_API_TOKEN is required when grafanaAnnotation.enabled is true")
		}
	}
	return c.ThroughputRecommendation.validate()
}

// validate checks the recommender block. Every rule runs even when the
// recommender is disabled, except the one that only makes sense for a live
// backend, so a config error surfaces at startup rather than the first time
// someone flips enabled to true.
//
// The block is small enough that this is short by design: the values that used to
// need range checks (quantile, headroom, step, throughput bounds, sample count)
// are constants in the throughput package now.
func (t *ThroughputRecommendation) validate() error {
	if t.Enabled && t.PrometheusURL == "" {
		return fmt.Errorf("throughputRecommendation.prometheusUrl is required when throughputRecommendation.enabled is true")
	}
	if t.Interval <= 0 {
		return fmt.Errorf("throughputRecommendation.interval must be greater than 0, got %s", t.Interval)
	}
	// The node label is interpolated into a "sum by (...)" clause, where it cannot
	// be quoted, so it is checked against the grammar rather than escaped.
	if !labelNamePattern.MatchString(t.MetricNodeNameLabel) {
		return fmt.Errorf("invalid throughputRecommendation.metricNodeNameLabel %q: must be a Prometheus label name", t.MetricNodeNameLabel)
	}
	return nil
}
