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
	// TagFilters selects which standalone EC2 instances are managed.
	TagFilters []TagFilter
	// ReconcileInterval is how often the control loop scans instances.
	ReconcileInterval time.Duration
	// UsageThresholdPercent triggers a resize when root usage reaches it.
	UsageThresholdPercent int
	// GrowPercent is how much to grow the EBS volume relative to current size.
	GrowPercent int
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
}

// Load reads configuration from environment variables, applies flag overrides
// from args, validates the result, and returns it.
func Load(args []string) (*Config, error) {
	c := &Config{
		Region:                getEnv("AWS_REGION", ""),
		ReconcileInterval:     getEnvDuration("RECONCILE_INTERVAL", 5*time.Minute),
		UsageThresholdPercent: getEnvInt("USAGE_THRESHOLD_PERCENT", 80),
		GrowPercent:           getEnvInt("GROW_PERCENT", 10),
		MaxVolumeSizeGiB:      getEnvInt("MAX_VOLUME_SIZE_GIB", 1000),
		SSMCommandTimeout:     getEnvDuration("SSM_COMMAND_TIMEOUT", 5*time.Minute),
		VolumeModifyTimeout:   getEnvDuration("VOLUME_MODIFY_TIMEOUT", 10*time.Minute),
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
	}

	var tagFilters string
	fs := flag.NewFlagSet("external-ebs-autoresizer", flag.ContinueOnError)
	fs.StringVar(&c.Region, "region", c.Region, "AWS region")
	fs.StringVar(&tagFilters, "tag-filters", getEnv("TAG_FILTERS", ""), "Comma-separated Key=Value tag filters")
	fs.DurationVar(&c.ReconcileInterval, "reconcile-interval", c.ReconcileInterval, "Reconcile loop interval")
	fs.IntVar(&c.UsageThresholdPercent, "usage-threshold-percent", c.UsageThresholdPercent, "Root usage percent that triggers a resize")
	fs.IntVar(&c.GrowPercent, "grow-percent", c.GrowPercent, "EBS growth percent")
	fs.IntVar(&c.MaxVolumeSizeGiB, "max-volume-size-gib", c.MaxVolumeSizeGiB, "Maximum volume size in GiB")
	fs.DurationVar(&c.SSMCommandTimeout, "ssm-command-timeout", c.SSMCommandTimeout, "SSM command poll timeout")
	fs.DurationVar(&c.VolumeModifyTimeout, "volume-modify-timeout", c.VolumeModifyTimeout, "Volume modification poll timeout")
	fs.BoolVar(&c.DryRun, "dry-run", c.DryRun, "Measure and decide but never modify resources")
	fs.BoolVar(&c.LeaderElect, "leader-elect", c.LeaderElect, "Enable leader election for HA (multiple replicas, single active)")
	fs.StringVar(&c.LeaseName, "lease-name", c.LeaseName, "Lease name used as the leader-election lock")
	fs.StringVar(&c.LogLevel, "log-level", c.LogLevel, "Log level: debug, info, warn, error")
	fs.StringVar(&c.LogFormat, "log-format", c.LogFormat, "Log format: json or text")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}

	filters, err := parseTagFilters(tagFilters)
	if err != nil {
		return nil, err
	}
	c.TagFilters = filters

	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *Config) validate() error {
	if c.Region == "" {
		return fmt.Errorf("AWS_REGION is required")
	}
	if len(c.TagFilters) == 0 {
		return fmt.Errorf("TAG_FILTERS is required (at least one Key=Value)")
	}
	if c.UsageThresholdPercent < 0 || c.UsageThresholdPercent > 100 {
		return fmt.Errorf("USAGE_THRESHOLD_PERCENT must be between 0 and 100, got %d", c.UsageThresholdPercent)
	}
	if c.GrowPercent <= 0 {
		return fmt.Errorf("GROW_PERCENT must be greater than 0, got %d", c.GrowPercent)
	}
	if c.MaxVolumeSizeGiB <= 0 {
		return fmt.Errorf("MAX_VOLUME_SIZE_GIB must be greater than 0, got %d", c.MaxVolumeSizeGiB)
	}
	if c.ReconcileInterval <= 0 {
		return fmt.Errorf("RECONCILE_INTERVAL must be greater than 0, got %s", c.ReconcileInterval)
	}
	return nil
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

func getEnvDuration(key string, fallback time.Duration) time.Duration {
	if v, ok := os.LookupEnv(key); ok {
		if d, err := time.ParseDuration(strings.TrimSpace(v)); err == nil {
			return d
		}
	}
	return fallback
}
