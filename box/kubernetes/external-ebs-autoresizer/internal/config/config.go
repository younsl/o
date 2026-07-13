// Package config loads and validates runtime configuration from a single YAML
// file. A small number of runtime-injected values (the Pod identity from the
// downward API and the Grafana API token from a Secret) are read from the
// environment instead, since they cannot live in a plain ConfigMap file.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"sigs.k8s.io/yaml"
)

// DefaultConfigFile is the config file path used when CONFIG_FILE is unset.
const DefaultConfigFile = "/etc/external-ebs-autoresizer/config.yaml"

// TagFilter is a single EC2 tag key/value used to scope target instances.
type TagFilter struct {
	Key   string
	Value string
}

// InstanceSelector scopes a resize policy to a group of instances. Both
// criteria must match (AND); at least one must be set.
type InstanceSelector struct {
	// Tags match instances carrying every listed tag key with the exact value.
	Tags map[string]string `json:"tags,omitempty"`
	// NameRegex matches against the instance Name tag using Go (RE2) regexp
	// syntax. Unanchored: anchor with ^ and $ for exact-name matching.
	NameRegex string `json:"nameRegex,omitempty"`
}

// ResizeSpec is the volume-expansion settings block, used both as the global
// defaultPolicy and as a per-policy override. Every field is a pointer, so
// "declared" is uniformly distinguishable from "omitted" across the whole
// policy engine: a nil field is unset. Which fields are required versus
// optional is decided by the consumer, not the type:
//   - As defaultPolicy: UsageThresholdPercent and GrowMode are REQUIRED (a nil
//     is a startup error); the rest are OPTIONAL and fall back to built-in
//     defaults.
//   - As a per-policy override: ALL fields are OPTIONAL; a nil field inherits
//     the effective defaultPolicy value.
type ResizeSpec struct {
	// Paused, when true, stops the resizer from touching matching instances:
	// they are skipped with reason "paused" and never measured or resized.
	Paused                *bool   `json:"paused,omitempty"`
	UsageThresholdPercent *int    `json:"usageThresholdPercent,omitempty"`
	GrowMode              *string `json:"growMode,omitempty"`
	GrowPercent           *int    `json:"growPercent,omitempty"`
	GrowAmount            *string `json:"growAmount,omitempty"`
	MaxVolumeSizeGiB      *int    `json:"maxVolumeSizeGiB,omitempty"`
}

// ResizePolicy is one per-instance-group override entry. The policy package
// validates and compiles these into an effective settings resolver.
type ResizePolicy struct {
	// Name identifies the policy in logs and metrics. Required, unique.
	Name string `json:"name"`
	// Weight breaks ties when multiple policies match an instance: the highest
	// weight wins; equal weights fall back to file order (earlier wins).
	Weight int `json:"weight,omitempty"`
	// InstanceSelector selects the instances this policy applies to.
	InstanceSelector InstanceSelector `json:"instanceSelector"`
	// Resize overrides the defaultPolicy volume-expansion settings for this
	// group. Every field is optional; a nil field inherits from defaultPolicy.
	Resize ResizeSpec `json:"resize"`
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
	// are sized in GiB). Populated during Load; used when GrowMode is "absolute"
	// and as the default absolute amount for per-group policies.
	GrowAmountGiB int32
	// MaxVolumeSizeGiB is a safety ceiling; resizes that would exceed it are skipped.
	MaxVolumeSizeGiB int
	// Paused is the default-policy pause switch: when true, every instance not
	// matched by a named policy is skipped without being resized. Named policies
	// can override it per group.
	Paused bool
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
	// Kubernetes Event publishing. Populated via the downward API (environment);
	// when empty (e.g. running outside a cluster) Event publishing is disabled.
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
	// (e.g. cluster=prod).
	AlertmanagerLabels map[string]string
	// AlertmanagerNotifyOn selects which resize outcomes are alerted: "all",
	// "success" (default), or "failure".
	AlertmanagerNotifyOn string
	// AlertmanagerDashboardURL is an optional dashboard URL template appended to
	// each alert's description as a Slack mrkdwn link. Placeholders in the form
	// {key} are substituted with the alert's labels (e.g. {instance_id},
	// {volume_id}, {device}, {instance_name}, plus any static AlertmanagerLabels
	// key). Empty (default) disables the link.
	AlertmanagerDashboardURL string
	// GrafanaAnnotationEnabled turns on Grafana annotations. When false
	// (default), annotating is disabled regardless of the other Grafana settings.
	GrafanaAnnotationEnabled bool
	// GrafanaURL is the base URL of a Grafana instance (e.g.
	// http://grafana.monitoring:3000). Required when GrafanaAnnotationEnabled is true.
	GrafanaURL string
	// GrafanaAPIToken is a Grafana service account token sent as a Bearer
	// credential. Required when GrafanaAnnotationEnabled is true. Read from the
	// environment only (never the config file) so the token stays out of the
	// ConfigMap.
	GrafanaAPIToken string
	// GrafanaTimeout bounds each annotation POST. Defaults to 5s.
	GrafanaTimeout time.Duration
	// GrafanaAnnotationTags are the base tags merged into every annotation and
	// subscribed to by dashboards (e.g. event:ebs-resize).
	GrafanaAnnotationTags []string
	// GrafanaAnnotateOn selects which resize outcomes are annotated: "all"
	// (default), "success", or "failure".
	GrafanaAnnotateOn string
	// Policies are the per-instance-group resize overrides, in file order. Empty
	// means every instance uses the global settings above.
	Policies []ResizePolicy
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

// fileSchema is the on-disk YAML shape. Durations are strings (Go duration
// syntax) and are parsed during Load. Pointer fields let an explicit zero (e.g.
// excludeEKSNodes: false, usageThresholdPercent: 0) be distinguished from an
// omitted field that should take its default.
type fileSchema struct {
	Region               string         `json:"region"`
	TagFilters           string         `json:"tagFilters"`
	ExcludeEKSNodes      bool           `json:"excludeEKSNodes"`
	ReconcileInterval    string         `json:"reconcileInterval"`
	ReconcileConcurrency int            `json:"reconcileConcurrency"`
	SSMPollInterval      string         `json:"ssmPollInterval"`
	DefaultPolicy        ResizeSpec     `json:"defaultPolicy"`
	SSMCommandTimeout    string         `json:"ssmCommandTimeout"`
	VolumeModifyTimeout  string         `json:"volumeModifyTimeout"`
	DryRun               bool           `json:"dryRun"`
	HealthPort           int            `json:"healthPort"`
	MetricsPort          int            `json:"metricsPort"`
	LeaderElect          bool           `json:"leaderElect"`
	LeaseName            string         `json:"leaseName"`
	LogLevel             string         `json:"logLevel"`
	LogFormat            string         `json:"logFormat"`
	Alertmanager         amFile         `json:"alertmanager"`
	GrafanaAnnotation    gfFile         `json:"grafanaAnnotation"`
	Policies             []ResizePolicy `json:"policies"`
}

// ptr returns a pointer to v, for the pre-filled optional defaults below.
func ptr[T any](v T) *T { return &v }

// defaultFileSchema returns the file schema pre-populated with defaults. Load
// decodes the YAML on top of it, so any key omitted from the file keeps its
// default and any key present overrides it, including with an explicit zero.
// This is the standard Kubernetes pattern (populate defaults, then decode)
// and removes the need for per-field zero-value sentinels.
//
// The two required defaultPolicy fields (usageThresholdPercent, growMode) are
// deliberately left nil so Load can reject a config that omits them; every
// other defaultPolicy field is pre-filled and therefore optional.
func defaultFileSchema() fileSchema {
	return fileSchema{
		ExcludeEKSNodes:      true,
		ReconcileInterval:    "5m",
		ReconcileConcurrency: 10,
		SSMPollInterval:      "1s",
		SSMCommandTimeout:    "5m",
		VolumeModifyTimeout:  "10m",
		HealthPort:           8080,
		MetricsPort:          8081,
		LeaderElect:          true,
		LeaseName:            "external-ebs-autoresizer",
		LogLevel:             "info",
		LogFormat:            "json",
		DefaultPolicy: ResizeSpec{
			Paused:           ptr(false),
			GrowPercent:      ptr(10),
			GrowAmount:       ptr("10GiB"),
			MaxVolumeSizeGiB: ptr(1000),
		},
		Alertmanager: amFile{
			Timeout:  "5s",
			NotifyOn: NotifyOnSuccess,
		},
		GrafanaAnnotation: gfFile{
			Timeout:    "5s",
			AnnotateOn: AnnotateOnAll,
			Tags:       []string{"event:ebs-resize"},
		},
	}
}

type amFile struct {
	Enabled      bool              `json:"enabled"`
	URL          string            `json:"url"`
	Timeout      string            `json:"timeout"`
	Labels       map[string]string `json:"labels"`
	NotifyOn     string            `json:"notifyOn"`
	DashboardURL string            `json:"dashboardUrl"`
}

type gfFile struct {
	Enabled    bool     `json:"enabled"`
	URL        string   `json:"url"`
	Timeout    string   `json:"timeout"`
	Tags       []string `json:"tags"`
	AnnotateOn string   `json:"annotateOn"`
}

// Load reads, parses, and validates the YAML config file at path, then layers
// in the environment-injected runtime values (Pod identity and Grafana token).
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config file %s: %w", path, err)
	}
	f := defaultFileSchema()
	if err := yaml.UnmarshalStrict(raw, &f); err != nil {
		return nil, fmt.Errorf("parse config file %s: %w", path, err)
	}

	// defaultPolicy.usageThresholdPercent and growMode are required: they set the
	// baseline every unmatched instance uses, so they must be an explicit choice
	// rather than an implicit default.
	dp := f.DefaultPolicy
	if dp.UsageThresholdPercent == nil {
		return nil, fmt.Errorf("defaultPolicy.usageThresholdPercent is required")
	}
	if dp.GrowMode == nil || strings.TrimSpace(*dp.GrowMode) == "" {
		return nil, fmt.Errorf("defaultPolicy.growMode is required")
	}

	c := &Config{
		Region:                   f.Region,
		ReconcileConcurrency:     f.ReconcileConcurrency,
		UsageThresholdPercent:    *dp.UsageThresholdPercent,
		GrowMode:                 strings.ToLower(strings.TrimSpace(*dp.GrowMode)),
		GrowPercent:              *dp.GrowPercent,
		GrowAmount:               *dp.GrowAmount,
		MaxVolumeSizeGiB:         *dp.MaxVolumeSizeGiB,
		Paused:                   *dp.Paused,
		DryRun:                   f.DryRun,
		HealthPort:               f.HealthPort,
		MetricsPort:              f.MetricsPort,
		ExcludeEKSNodes:          f.ExcludeEKSNodes,
		LeaderElect:              f.LeaderElect,
		LeaseName:                f.LeaseName,
		LogLevel:                 f.LogLevel,
		LogFormat:                f.LogFormat,
		AlertmanagerEnabled:      f.Alertmanager.Enabled,
		AlertmanagerURL:          f.Alertmanager.URL,
		AlertmanagerLabels:       f.Alertmanager.Labels,
		AlertmanagerNotifyOn:     f.Alertmanager.NotifyOn,
		AlertmanagerDashboardURL: f.Alertmanager.DashboardURL,
		GrafanaAnnotationEnabled: f.GrafanaAnnotation.Enabled,
		GrafanaURL:               f.GrafanaAnnotation.URL,
		GrafanaAnnotateOn:        f.GrafanaAnnotation.AnnotateOn,
		GrafanaAnnotationTags:    f.GrafanaAnnotation.Tags,
		Policies:                 f.Policies,
		// Runtime-injected: never from the file.
		PodName:         getEnv("POD_NAME", ""),
		PodNamespace:    getEnv("POD_NAMESPACE", ""),
		PodUID:          getEnv("POD_UID", ""),
		GrafanaAPIToken: getEnv("GRAFANA_API_TOKEN", ""),
	}

	durations := []struct {
		name string
		raw  string
		dst  *time.Duration
	}{
		{"reconcileInterval", f.ReconcileInterval, &c.ReconcileInterval},
		{"ssmPollInterval", f.SSMPollInterval, &c.SSMPollInterval},
		{"ssmCommandTimeout", f.SSMCommandTimeout, &c.SSMCommandTimeout},
		{"volumeModifyTimeout", f.VolumeModifyTimeout, &c.VolumeModifyTimeout},
		{"alertmanager.timeout", f.Alertmanager.Timeout, &c.AlertmanagerTimeout},
		{"grafanaAnnotation.timeout", f.GrafanaAnnotation.Timeout, &c.GrafanaTimeout},
	}
	for _, d := range durations {
		v, err := parseDuration(d.name, d.raw)
		if err != nil {
			return nil, err
		}
		*d.dst = v
	}

	filters, err := parseTagFilters(f.TagFilters)
	if err != nil {
		return nil, err
	}
	c.TagFilters = filters

	// growAmount is always parsed (not only in absolute mode) so per-group
	// policies that switch to absolute mode inherit a usable default amount, and
	// a malformed value fails at startup regardless of the active mode.
	gib, err := ParseGrowAmount(c.GrowAmount)
	if err != nil {
		return nil, fmt.Errorf("invalid growAmount: %w", err)
	}
	c.GrowAmountGiB = gib

	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}

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
	return nil
}

// ParseGrowAmount parses an absolute growth value with a MiB or GiB unit (e.g.
// "10GiB", "5120MiB") into whole GiB. EBS volumes are sized in GiB, so a MiB
// value is rounded up to the next whole GiB to guarantee at least the requested
// growth. The unit is required and case-insensitive; the shorthand forms "Gi"
// and "Mi" are also accepted.
func ParseGrowAmount(raw string) (int32, error) {
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

// parseDuration parses a Go duration string. An invalid value (including empty,
// which the pre-filled defaults make impossible in practice) is a hard error so
// misconfiguration (e.g. "1hour", "5min", or a unitless "300") fails at startup
// instead of running with a surprising value.
func parseDuration(name, raw string) (time.Duration, error) {
	d, err := time.ParseDuration(strings.TrimSpace(raw))
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q: must be a Go duration such as 30s, 5m, 1h, 1h30m", name, raw)
	}
	return d, nil
}

func getEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}
