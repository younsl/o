// Package config loads and validates runtime configuration from environment
// variables, with equivalent command-line flag overrides.
package config

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// TagFilter is a single EC2 tag key/value used to scope target instances.
type TagFilter struct {
	Key   string
	Value string
}

// Config holds all runtime settings for the resizer.
type Config struct {
	// Region is the AWS region to operate in.
	Region string
	// TagFilters selects which standalone EC2 instances are managed. When empty,
	// every running instance in the account/region is a candidate (subject to
	// ExcludeEKSNodes).
	TagFilters []TagFilter
	// ExcludeEKSNodes drops instances that belong to an EKS cluster (managed node
	// groups, self-managed nodes, and Karpenter nodes) from the candidate set, so
	// the addon only ever touches standalone EC2 instances.
	ExcludeEKSNodes bool
	// ReconcileInterval is how often the control loop scans instances.
	ReconcileInterval time.Duration
	// ReconcileConcurrency bounds how many instances are reconciled in parallel
	// within a single pass. Defaults to 10.
	ReconcileConcurrency int
	// SSMPollInterval is the delay between status polls for SSM command
	// invocations and EBS volume modifications. Defaults to 1s.
	SSMPollInterval time.Duration
	// UsageThresholdPercent triggers a resize when root usage reaches it.
	UsageThresholdPercent int
	// GrowMode selects how the target size is computed: "percent" grows the
	// volume relative to its current size by GrowPercent, "absolute" grows it by
	// a fixed amount (GrowAmount).
	GrowMode string
	// GrowPercent is how much to grow the EBS volume relative to current size.
	// Used when GrowMode is "percent".
	GrowPercent int
	// GrowAmount is the raw fixed growth per resize with a MiB or GiB unit (e.g.
	// "10GiB", "5120MiB"). Used when GrowMode is "absolute".
	GrowAmount string
	// GrowAmountGiB is GrowAmount parsed and rounded up to whole GiB (EBS volumes
	// are sized in GiB). Populated during Load when GrowMode is "absolute".
	GrowAmountGiB int32
	// MaxVolumeSizeGiB is a safety ceiling; resizes that would exceed it are skipped.
	MaxVolumeSizeGiB int
	// SSMCommandTimeout bounds how long we wait for an SSM command to finish.
	SSMCommandTimeout time.Duration
	// VolumeModifyTimeout bounds how long we wait for a volume to reach optimizing.
	VolumeModifyTimeout time.Duration
	// DryRun measures and decides but never mutates AWS resources.
	DryRun bool
	// HealthPort serves /healthz and /readyz.
	HealthPort int
	// MetricsPort serves /metrics.
	MetricsPort int
	// LogLevel is one of debug, info, warn, error.
	LogLevel string
	// LogFormat is json or text.
	LogFormat string
	// PodName, PodNamespace, and PodUID identify the controller's own Pod for
	// Kubernetes Event publishing. Populated via the downward API; when empty
	// (e.g. running outside a cluster) Event publishing is disabled.
	PodName      string
	PodNamespace string
	PodUID       string
	// LeaderElect enables single-active-instance leader election via a Lease,
	// so the Deployment can run multiple replicas for HA while only the leader
	// reconciles. Requires in-cluster config; ignored when PodName is empty.
	LeaderElect bool
	// LeaseName is the coordination.k8s.io Lease used as the leader-election lock.
	LeaseName string
	// AlertmanagerEnabled turns on alert notifications. When false (default),
	// alerting is disabled regardless of the other Alertmanager settings.
	AlertmanagerEnabled bool
	// AlertmanagerURL is the base URL of an Alertmanager v2 endpoint (e.g.
	// http://alertmanager:9093). Required when AlertmanagerEnabled is true.
	AlertmanagerURL string
	// AlertmanagerTimeout bounds each alert POST. Defaults to 5s.
	AlertmanagerTimeout time.Duration
	// AlertmanagerLabels are static labels merged into every alert for routing
	// (e.g. cluster=prod). Parsed from "Key=Value,Key2=Value2".
	AlertmanagerLabels map[string]string
	// AlertmanagerNotifyOn selects which resize outcomes are alerted: "all",
	// "success" (default), or "failure".
	AlertmanagerNotifyOn string
	// GrafanaAnnotationEnabled turns on Grafana annotations. When false
	// (default), annotating is disabled regardless of the other Grafana settings.
	GrafanaAnnotationEnabled bool
	// GrafanaURL is the base URL of a Grafana instance (e.g.
	// http://grafana.monitoring:3000). Required when GrafanaAnnotationEnabled is true.
	GrafanaURL string
	// GrafanaAPIToken is a Grafana service account token sent as a Bearer
	// credential. Required when GrafanaAnnotationEnabled is true. Set via the
	// environment only (never a flag) so the token stays out of process args.
	GrafanaAPIToken string
	// GrafanaTimeout bounds each annotation POST. Defaults to 5s.
	GrafanaTimeout time.Duration
	// GrafanaAnnotationTags are the base tags merged into every annotation and
	// subscribed to by dashboards (e.g. event:ebs-resize). Parsed from a
	// comma-separated list.
	GrafanaAnnotationTags []string
	// GrafanaAnnotateOn selects which resize outcomes are annotated: "all"
	// (default), "success", or "failure".
	GrafanaAnnotateOn string
}

// Alertmanager notify-on and Grafana annotate-on policy values.
const (
	NotifyOnAll     = "all"
	NotifyOnSuccess = "success"
	NotifyOnFailure = "failure"

	AnnotateOnAll     = "all"
	AnnotateOnSuccess = "success"
	AnnotateOnFailure = "failure"
)

// Grow mode values selecting how the resize target size is computed.
const (
	GrowModePercent  = "percent"
	GrowModeAbsolute = "absolute"
)

// Load reads configuration from environment variables, applies flag overrides
// from args, validates the result, and returns it.
func Load(args []string) (*Config, error) {
	reconcileInterval, err := getEnvDuration("RECONCILE_INTERVAL", 5*time.Minute)
	if err != nil {
		return nil, err
	}
	ssmCommandTimeout, err := getEnvDuration("SSM_COMMAND_TIMEOUT", 5*time.Minute)
	if err != nil {
		return nil, err
	}
	volumeModifyTimeout, err := getEnvDuration("VOLUME_MODIFY_TIMEOUT", 10*time.Minute)
	if err != nil {
		return nil, err
	}
	ssmPollInterval, err := getEnvDuration("SSM_POLL_INTERVAL", time.Second)
	if err != nil {
		return nil, err
	}
	alertmanagerTimeout, err := getEnvDuration("ALERTMANAGER_TIMEOUT", 5*time.Second)
	if err != nil {
		return nil, err
	}
	grafanaTimeout, err := getEnvDuration("GRAFANA_TIMEOUT", 5*time.Second)
	if err != nil {
		return nil, err
	}

	c := &Config{
		Region:                getEnv("AWS_REGION", ""),
		ReconcileInterval:     reconcileInterval,
		ReconcileConcurrency:  getEnvInt("RECONCILE_CONCURRENCY", 10),
		SSMPollInterval:       ssmPollInterval,
		UsageThresholdPercent: getEnvInt("USAGE_THRESHOLD_PERCENT", 80),
		GrowMode:              getEnv("GROW_MODE", GrowModePercent),
		GrowPercent:           getEnvInt("GROW_PERCENT", 10),
		GrowAmount:            getEnv("GROW_AMOUNT", "10GiB"),
		MaxVolumeSizeGiB:      getEnvInt("MAX_VOLUME_SIZE_GIB", 1000),
		ExcludeEKSNodes:       getEnvBool("EXCLUDE_EKS_NODES", true),
		SSMCommandTimeout:     ssmCommandTimeout,
		VolumeModifyTimeout:   volumeModifyTimeout,
		DryRun:                getEnvBool("DRY_RUN", false),
		HealthPort:            getEnvInt("HEALTH_PORT", 8080),
		MetricsPort:           getEnvInt("METRICS_PORT", 8081),
		PodName:               getEnv("POD_NAME", ""),
		PodNamespace:          getEnv("POD_NAMESPACE", ""),
		PodUID:                getEnv("POD_UID", ""),
		LeaderElect:           getEnvBool("LEADER_ELECT", true),
		LeaseName:             getEnv("LEASE_NAME", "external-ebs-autoresizer"),
		LogLevel:              getEnv("LOG_LEVEL", "info"),
		LogFormat:             getEnv("LOG_FORMAT", "json"),
		AlertmanagerEnabled:   getEnvBool("ALERTMANAGER_ENABLED", false),
		AlertmanagerURL:       getEnv("ALERTMANAGER_URL", ""),
		AlertmanagerTimeout:   alertmanagerTimeout,
		AlertmanagerNotifyOn:  getEnv("ALERTMANAGER_NOTIFY_ON", NotifyOnSuccess),

		GrafanaAnnotationEnabled: getEnvBool("GRAFANA_ANNOTATION_ENABLED", false),
		GrafanaURL:               getEnv("GRAFANA_URL", ""),
		GrafanaAPIToken:          getEnv("GRAFANA_API_TOKEN", ""),
		GrafanaTimeout:           grafanaTimeout,
		GrafanaAnnotateOn:        getEnv("GRAFANA_ANNOTATE_ON", AnnotateOnAll),
	}

	var tagFilters string
	var alertmanagerLabels string
	var grafanaTags string
	fs := flag.NewFlagSet("external-ebs-autoresizer", flag.ContinueOnError)
	fs.StringVar(&c.Region, "region", c.Region, "AWS region")
	fs.StringVar(&tagFilters, "tag-filters", getEnv("TAG_FILTERS", ""), "Comma-separated Key=Value tag filters; empty scans all instances")
	fs.BoolVar(&c.ExcludeEKSNodes, "exclude-eks-nodes", c.ExcludeEKSNodes, "Exclude EKS cluster nodes (managed node groups, self-managed, Karpenter)")
	fs.DurationVar(&c.ReconcileInterval, "reconcile-interval", c.ReconcileInterval, "Reconcile loop interval")
	fs.IntVar(&c.ReconcileConcurrency, "reconcile-concurrency", c.ReconcileConcurrency, "Max instances reconciled in parallel per pass")
	fs.DurationVar(&c.SSMPollInterval, "ssm-poll-interval", c.SSMPollInterval, "Delay between SSM command and volume modification status polls")
	fs.IntVar(&c.UsageThresholdPercent, "usage-threshold-percent", c.UsageThresholdPercent, "Root usage percent that triggers a resize")
	fs.StringVar(&c.GrowMode, "grow-mode", c.GrowMode, "How to grow the volume: percent (by grow-percent) or absolute (by grow-amount)")
	fs.IntVar(&c.GrowPercent, "grow-percent", c.GrowPercent, "EBS growth percent (used when grow-mode is percent)")
	fs.StringVar(&c.GrowAmount, "grow-amount", c.GrowAmount, "Absolute EBS growth per resize with a MiB or GiB unit, e.g. 10GiB or 5120MiB (used when grow-mode is absolute)")
	fs.IntVar(&c.MaxVolumeSizeGiB, "max-volume-size-gib", c.MaxVolumeSizeGiB, "Maximum volume size in GiB")
	fs.DurationVar(&c.SSMCommandTimeout, "ssm-command-timeout", c.SSMCommandTimeout, "SSM command poll timeout")
	fs.DurationVar(&c.VolumeModifyTimeout, "volume-modify-timeout", c.VolumeModifyTimeout, "Volume modification poll timeout")
	fs.BoolVar(&c.DryRun, "dry-run", c.DryRun, "Measure and decide but never modify resources")
	fs.BoolVar(&c.LeaderElect, "leader-elect", c.LeaderElect, "Enable leader election for HA (multiple replicas, single active)")
	fs.StringVar(&c.LeaseName, "lease-name", c.LeaseName, "Lease name used as the leader-election lock")
	fs.StringVar(&c.LogLevel, "log-level", c.LogLevel, "Log level: debug, info, warn, error")
	fs.StringVar(&c.LogFormat, "log-format", c.LogFormat, "Log format: json or text")
	fs.BoolVar(&c.AlertmanagerEnabled, "alertmanager-enabled", c.AlertmanagerEnabled, "Enable Alertmanager alerting (requires alertmanager-url)")
	fs.StringVar(&c.AlertmanagerURL, "alertmanager-url", c.AlertmanagerURL, "Alertmanager v2 base URL (e.g. http://alertmanager:9093)")
	fs.DurationVar(&c.AlertmanagerTimeout, "alertmanager-timeout", c.AlertmanagerTimeout, "Timeout for each Alertmanager POST")
	fs.StringVar(&alertmanagerLabels, "alertmanager-labels", getEnv("ALERTMANAGER_LABELS", ""), "Comma-separated Key=Value static labels merged into every alert for routing")
	fs.StringVar(&c.AlertmanagerNotifyOn, "alertmanager-notify-on", c.AlertmanagerNotifyOn, "Which resize outcomes to alert: all, success, or failure")
	fs.BoolVar(&c.GrafanaAnnotationEnabled, "grafana-annotation-enabled", c.GrafanaAnnotationEnabled, "Enable Grafana annotations (requires grafana-url and GRAFANA_API_TOKEN)")
	fs.StringVar(&c.GrafanaURL, "grafana-url", c.GrafanaURL, "Grafana base URL (e.g. http://grafana.monitoring:3000)")
	fs.DurationVar(&c.GrafanaTimeout, "grafana-timeout", c.GrafanaTimeout, "Timeout for each Grafana annotation POST")
	fs.StringVar(&grafanaTags, "grafana-annotation-tags", getEnv("GRAFANA_ANNOTATION_TAGS", "event:ebs-resize"), "Comma-separated base tags merged into every annotation and subscribed to by dashboards")
	fs.StringVar(&c.GrafanaAnnotateOn, "grafana-annotate-on", c.GrafanaAnnotateOn, "Which resize outcomes to annotate: all, success, or failure")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	filters, err := parseTagFilters(tagFilters)
	if err != nil {
		return nil, err
	}
	c.TagFilters = filters

	alertLabels, err := parseTagFilters(alertmanagerLabels)
	if err != nil {
		return nil, fmt.Errorf("invalid ALERTMANAGER_LABELS: %w", err)
	}
	c.AlertmanagerLabels = make(map[string]string, len(alertLabels))
	for _, l := range alertLabels {
		c.AlertmanagerLabels[l.Key] = l.Value
	}

	c.GrafanaAnnotationTags = parseTags(grafanaTags)

	c.GrowMode = strings.ToLower(strings.TrimSpace(c.GrowMode))
	if c.GrowMode == GrowModeAbsolute {
		gib, err := parseGrowAmount(c.GrowAmount)
		if err != nil {
			return nil, fmt.Errorf("invalid GROW_AMOUNT: %w", err)
		}
		c.GrowAmountGiB = gib
	}

	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Config) validate() error {
	if c.Region == "" {
		return fmt.Errorf("AWS_REGION is required")
	}
	if c.UsageThresholdPercent < 0 || c.UsageThresholdPercent > 100 {
		return fmt.Errorf("USAGE_THRESHOLD_PERCENT must be between 0 and 100, got %d", c.UsageThresholdPercent)
	}
	switch c.GrowMode {
	case GrowModePercent:
		if c.GrowPercent <= 0 {
			return fmt.Errorf("GROW_PERCENT must be greater than 0, got %d", c.GrowPercent)
		}
	case GrowModeAbsolute:
		if c.GrowAmountGiB <= 0 {
			return fmt.Errorf("GROW_AMOUNT must resolve to at least 1 GiB, got %q", c.GrowAmount)
		}
	default:
		return fmt.Errorf("GROW_MODE must be one of %s, %s, got %q", GrowModePercent, GrowModeAbsolute, c.GrowMode)
	}
	if c.MaxVolumeSizeGiB <= 0 {
		return fmt.Errorf("MAX_VOLUME_SIZE_GIB must be greater than 0, got %d", c.MaxVolumeSizeGiB)
	}
	if c.ReconcileInterval <= 0 {
		return fmt.Errorf("RECONCILE_INTERVAL must be greater than 0, got %s", c.ReconcileInterval)
	}
	if c.ReconcileConcurrency <= 0 {
		return fmt.Errorf("RECONCILE_CONCURRENCY must be greater than 0, got %d", c.ReconcileConcurrency)
	}
	if c.SSMPollInterval <= 0 {
		return fmt.Errorf("SSM_POLL_INTERVAL must be greater than 0, got %s", c.SSMPollInterval)
	}
	switch c.AlertmanagerNotifyOn {
	case NotifyOnAll, NotifyOnSuccess, NotifyOnFailure:
	default:
		return fmt.Errorf("ALERTMANAGER_NOTIFY_ON must be one of %s, %s, %s, got %q", NotifyOnAll, NotifyOnSuccess, NotifyOnFailure, c.AlertmanagerNotifyOn)
	}
	if c.AlertmanagerEnabled && c.AlertmanagerURL == "" {
		return fmt.Errorf("ALERTMANAGER_URL is required when ALERTMANAGER_ENABLED is true")
	}
	switch c.GrafanaAnnotateOn {
	case AnnotateOnAll, AnnotateOnSuccess, AnnotateOnFailure:
	default:
		return fmt.Errorf("GRAFANA_ANNOTATE_ON must be one of %s, %s, %s, got %q", AnnotateOnAll, AnnotateOnSuccess, AnnotateOnFailure, c.GrafanaAnnotateOn)
	}
	if c.GrafanaAnnotationEnabled {
		if c.GrafanaURL == "" {
			return fmt.Errorf("GRAFANA_URL is required when GRAFANA_ANNOTATION_ENABLED is true")
		}
		if c.GrafanaAPIToken == "" {
			return fmt.Errorf("GRAFANA_API_TOKEN is required when GRAFANA_ANNOTATION_ENABLED is true")
		}
	}
	return nil
}

// parseGrowAmount parses an absolute growth value with a MiB or GiB unit (e.g.
// "10GiB", "5120MiB") into whole GiB. EBS volumes are sized in GiB, so a MiB
// value is rounded up to the next whole GiB to guarantee at least the requested
// growth. The unit is required and case-insensitive; the shorthand forms "Gi"
// and "Mi" are also accepted.
func parseGrowAmount(raw string) (int32, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return 0, fmt.Errorf("empty value, expected a number with a MiB or GiB unit such as 10GiB")
	}
	lower := strings.ToLower(s)
	var (
		numStr  string
		toGiB   func(int64) int64
		unitErr = fmt.Errorf("value %q must end with a MiB or GiB unit such as 10GiB or 5120MiB", raw)
	)
	switch {
	case strings.HasSuffix(lower, "gib"):
		numStr, toGiB = lower[:len(lower)-3], func(n int64) int64 { return n }
	case strings.HasSuffix(lower, "mib"):
		numStr, toGiB = lower[:len(lower)-3], mibToGiB
	case strings.HasSuffix(lower, "gi"):
		numStr, toGiB = lower[:len(lower)-2], func(n int64) int64 { return n }
	case strings.HasSuffix(lower, "mi"):
		numStr, toGiB = lower[:len(lower)-2], mibToGiB
	default:
		return 0, unitErr
	}
	numStr = strings.TrimSpace(numStr)
	n, err := strconv.ParseInt(numStr, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("value %q has an invalid number %q: %w", raw, numStr, err)
	}
	if n <= 0 {
		return 0, fmt.Errorf("value %q must be greater than 0", raw)
	}
	return int32(toGiB(n)), nil
}

// mibToGiB converts MiB to GiB, rounding up so the resulting whole GiB is never
// less than the requested MiB.
func mibToGiB(mib int64) int64 {
	return (mib + 1023) / 1024
}

// parseTags splits a comma-separated tag list, trimming whitespace and dropping
// empty entries. It returns nil for an empty input.
func parseTags(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var out []string
	for _, t := range strings.Split(raw, ",") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// parseTagFilters parses "Key=Value,Key2=Value2" into TagFilter slices.
func parseTagFilters(raw string) ([]TagFilter, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var out []TagFilter
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		key, value, found := strings.Cut(pair, "=")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !found || key == "" || value == "" {
			return nil, fmt.Errorf("invalid tag filter %q, expected Key=Value", pair)
		}
		out = append(out, TagFilter{Key: key, Value: value})
	}
	return out, nil
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v, ok := os.LookupEnv(key); ok {
		if n, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
			return n
		}
	}
	return fallback
}

func getEnvBool(key string, fallback bool) bool {
	if v, ok := os.LookupEnv(key); ok {
		if b, err := strconv.ParseBool(strings.TrimSpace(v)); err == nil {
			return b
		}
	}
	return fallback
}

// getEnvDuration parses a Go duration from the environment. An invalid value is
// a hard error rather than a silent fallback, so misconfiguration (e.g. "1hour",
// "5min", or a unitless "300") fails at startup instead of running with the
// default interval.
func getEnvDuration(key string, fallback time.Duration) (time.Duration, error) {
	v, ok := os.LookupEnv(key)
	if !ok {
		return fallback, nil
	}
	d, err := time.ParseDuration(strings.TrimSpace(v))
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q: must be a Go duration such as 30s, 5m, 1h, 1h30m", key, v)
	}
	return d, nil
}
