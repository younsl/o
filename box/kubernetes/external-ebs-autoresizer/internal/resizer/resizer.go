// Package resizer orchestrates the measure -> decide -> grow -> wait -> expand
// flow for the root EBS volume of each target standalone EC2 instance.
package resizer

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/policy"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/scripts"
)

// modificationCooldown is the minimum interval between modifications of the
// same EBS volume. It is fixed at the AWS-enforced limit (one modification per
// volume per 6 hours) and is intentionally not configurable: a shorter value
// only triggers VolumeModificationRateExceeded errors.
const modificationCooldown = 6 * time.Hour

// EC2API is the subset of EC2 operations the resizer depends on.
type EC2API interface {
	DescribeTargetInstances(ctx context.Context, filters []awsx.TagFilter, excludeEKSNodes bool) ([]awsx.Instance, error)
	ModifyVolume(ctx context.Context, volumeID string, sizeGiB int32) error
	DescribeLastModification(ctx context.Context, volumeID string) (*awsx.VolumeModification, error)
	WaitForModification(ctx context.Context, volumeID string, timeout time.Duration) error
}

// SSMAPI is the subset of SSM operations the resizer depends on.
type SSMAPI interface {
	RunScript(ctx context.Context, instanceID, script string, timeout time.Duration) (awsx.CommandResult, error)
}

// Recorder receives metrics observations. observability.Metrics implements it.
type Recorder interface {
	ObserveUsage(instanceID, device, volumeID, name string, percent float64)
	ObserveVolumeSize(instanceID, device, volumeID, name string, sizeGiB int32)
	ObserveResize(success bool, policy string)
	ObserveSkip(reason, policy string)
	ObserveError(stage string)
	ObservePolicyInstances(counts map[string]int)
}

// Skip reasons reported via Recorder.ObserveSkip when an instance is above the
// usage threshold but no resize is attempted. They surface the silent states
// that resize_total and error_total do not capture (e.g. a volume stuck at the
// max-size ceiling while still filling up).
const (
	skipBelowThreshold = "below_threshold"
	skipMaxSize        = "max_size"
	skipCooldown       = "cooldown"
	skipDryRun         = "dry_run"
	skipPaused         = "paused"
)

// EventEmitter publishes Kubernetes Events about resize operations.
// events.Emitter implements it. A nil EventEmitter disables event publishing
// (e.g. when running outside a cluster or during tests).
type EventEmitter interface {
	Eventf(eventType, reason, messageFmt string, args ...any)
}

// AlertNotifier sends alerts about resize operations to an external sink such
// as Alertmanager. alertmanager.Client implements it. A nil AlertNotifier
// disables alerting (e.g. when no Alertmanager URL is configured or during
// tests). labels carry per-alert identifying labels (instance_id, volume_id,
// device, instance_name); startsAt is the alert's start time.
type AlertNotifier interface {
	Notify(ctx context.Context, severity, alertname, summary, description string, labels map[string]string, startsAt time.Time)
}

// Annotator posts annotations about resize operations to a sink such as
// Grafana. grafana.Client implements it. A nil Annotator disables annotating
// (e.g. when no Grafana URL is configured or during tests). text is the marker
// body; tags are per-annotation tags; start is the marker time and end, when
// non-zero, makes it a region annotation spanning start..end.
type Annotator interface {
	Annotate(ctx context.Context, text string, tags []string, start, end time.Time)
}

// Resizer holds dependencies for one reconcile pass.
type Resizer struct {
	cfg       *config.Config
	resolver  *policy.Resolver
	ec2       EC2API
	ssm       SSMAPI
	rec       Recorder
	events    EventEmitter
	notifier  AlertNotifier
	annotator Annotator
	logger    *slog.Logger
}

// New constructs a Resizer. resolver may be nil to run every instance on the
// global settings; events may be nil to disable Kubernetes Events; notifier
// may be nil to disable Alertmanager alerting; annotator may be nil to disable
// Grafana annotations.
func New(cfg *config.Config, resolver *policy.Resolver, ec2 EC2API, ssm SSMAPI, rec Recorder, events EventEmitter, notifier AlertNotifier, annotator Annotator, logger *slog.Logger) *Resizer {
	return &Resizer{cfg: cfg, resolver: resolver, ec2: ec2, ssm: ssm, rec: rec, events: events, notifier: notifier, annotator: annotator, logger: logger}
}

// effective returns the resize settings for one instance: the matched policy's
// overlay when a resolver is set, otherwise the global settings.
func (r *Resizer) effective(inst awsx.Instance) policy.Effective {
	if r.resolver == nil {
		return policy.FromConfig(r.cfg)
	}
	return r.resolver.Resolve(inst.Name, inst.Tags)
}

// Reconcile discovers all target instances and processes each one, returning
// the number of instances discovered. Per-instance failures are logged and
// counted but do not abort the pass.
func (r *Resizer) Reconcile(ctx context.Context) (int, error) {
	filters := make([]awsx.TagFilter, len(r.cfg.TagFilters))
	for i, f := range r.cfg.TagFilters {
		filters[i] = awsx.TagFilter{Key: f.Key, Value: f.Value}
	}

	instances, err := r.ec2.DescribeTargetInstances(ctx, filters, r.cfg.ExcludeEKSNodes)
	if err != nil {
		r.rec.ObserveError("discover")
		return 0, fmt.Errorf("discover instances: %w", err)
	}
	r.logger.Info("discovered target instances", "count", len(instances))

	// Resolve each instance's effective policy once, up front, and record how
	// many instances each policy identified so the policy configuration is
	// verifiable from the logs and metrics on every pass (including the
	// immediate pass at startup). Seed every named policy (and the default
	// bucket) at 0 so a policy that matches nothing this pass still reports 0
	// rather than vanishing.
	effs := make([]policy.Effective, len(instances))
	counts := map[string]int{policy.DefaultPolicyName: 0}
	if r.resolver != nil {
		for _, name := range r.resolver.Names() {
			counts[name] = 0
		}
	}
	for i, inst := range instances {
		effs[i] = r.effective(inst)
		counts[effs[i].Policy]++
	}
	r.logPolicyCounts(counts)
	r.rec.ObservePolicyInstances(counts)

	// Reconcile instances concurrently with a bounded worker pool. Each instance
	// targets an independent EBS volume, so parallelism is safe; the semaphore
	// caps in-flight SSM/EC2 calls to stay within API rate limits. Per-instance
	// failures are logged and counted but never abort the pass.
	concurrency := max(r.cfg.ReconcileConcurrency, 1)
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for i, inst := range instances {
		if ctx.Err() != nil {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(inst awsx.Instance, eff policy.Effective) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := r.reconcileInstance(ctx, inst, eff); err != nil {
				r.logger.Error("instance reconcile failed", "instance", inst.ID, "name", inst.Name, "error", err)
			}
		}(inst, effs[i])
	}
	wg.Wait()
	return len(instances), ctx.Err()
}

// logPolicyCounts logs how many discovered instances each policy matched. It is
// a no-op detail when no named policies are configured (every instance resolves
// to the default), but always emitted when policies exist so their reach is
// visible on each pass.
func (r *Resizer) logPolicyCounts(counts map[string]int) {
	if r.resolver == nil || r.resolver.Len() == 0 {
		return
	}
	// One line per policy, named policies in configured order then the default
	// bucket, so output is stable across passes and filterable by the policy field.
	for _, name := range r.resolver.Names() {
		r.logger.Info("instances matched by resize policy", "policy_name", name, "instance_count", counts[name])
	}
	r.logger.Info("instances matched by resize policy", "policy_name", policy.DefaultPolicyName, "instance_count", counts[policy.DefaultPolicyName])
}

func (r *Resizer) reconcileInstance(ctx context.Context, inst awsx.Instance, eff policy.Effective) error {
	log := r.logger.With("instance", inst.ID, "name", inst.Name, "policy", eff.Policy)

	if inst.RootVolumeID == "" {
		log.Warn("no root EBS volume resolved, skipping")
		return nil
	}
	// Volume size is known from discovery, so it is recorded before the paused
	// and threshold gates: even instances that are never measured report a size.
	r.rec.ObserveVolumeSize(inst.ID, inst.RootDeviceName, inst.RootVolumeID, inst.Name, inst.RootVolumeSizeGiB)

	// A paused policy takes the instance entirely out of scope: no measurement,
	// no resize.
	if eff.Paused {
		log.Info("resize policy paused, skipping")
		r.rec.ObserveSkip(skipPaused, eff.Policy)
		return nil
	}

	usage, err := r.measure(ctx, inst.ID)
	if err != nil {
		r.rec.ObserveError("measure")
		return fmt.Errorf("measure usage: %w", err)
	}
	r.rec.ObserveUsage(inst.ID, inst.RootDeviceName, inst.RootVolumeID, inst.Name, float64(usage))
	log.Debug("measured root usage", "usage_percent", usage, "threshold_percent", eff.UsageThresholdPercent)

	if usage < eff.UsageThresholdPercent {
		log.Debug("usage below threshold, nothing to do")
		r.rec.ObserveSkip(skipBelowThreshold, eff.Policy)
		return nil
	}

	current := inst.RootVolumeSizeGiB
	target := TargetSize(current, eff)
	log = log.With("volume", inst.RootVolumeID, "current_gib", current, "target_gib", target)

	if int(target) > eff.MaxVolumeSizeGiB {
		log.Warn("target exceeds max volume size, skipping", "max_gib", eff.MaxVolumeSizeGiB)
		r.rec.ObserveSkip(skipMaxSize, eff.Policy)
		return nil
	}
	skip, err := r.withinCooldown(ctx, inst.RootVolumeID)
	if err != nil {
		r.rec.ObserveError("cooldown")
		return fmt.Errorf("check cooldown: %w", err)
	}
	if skip {
		log.Info("volume modified within cooldown window, skipping")
		r.rec.ObserveSkip(skipCooldown, eff.Policy)
		return nil
	}

	if r.cfg.DryRun {
		log.Info("dry-run: would modify volume and resize filesystem")
		r.rec.ObserveSkip(skipDryRun, eff.Policy)
		return nil
	}

	start := time.Now()
	r.reportStarted(inst, current, target, usage)
	if err := r.ec2.ModifyVolume(ctx, inst.RootVolumeID, target); err != nil {
		r.reportFailure(ctx, inst, eff, usage, "modify", fmt.Sprintf("ModifyVolume failed: %v", err), start)
		return fmt.Errorf("modify volume: %w", err)
	}
	log.Info("requested volume modification")

	if err := r.ec2.WaitForModification(ctx, inst.RootVolumeID, r.cfg.VolumeModifyTimeout); err != nil {
		r.reportFailure(ctx, inst, eff, usage, "wait", fmt.Sprintf("volume did not reach optimizing: %v", err), start)
		return fmt.Errorf("wait for modification: %w", err)
	}
	log.Info("volume modification optimizing", "elapsed", time.Since(start).String())

	res, err := r.ssm.RunScript(ctx, inst.ID, scripts.ResizeRootFS, r.cfg.SSMCommandTimeout)
	if err != nil {
		r.reportFailure(ctx, inst, eff, usage, "resize", fmt.Sprintf("filesystem resize failed: %v", err), start)
		return fmt.Errorf("resize filesystem: %w", err)
	}
	log.Info("filesystem resize completed", "stdout", strings.TrimSpace(res.Stdout))

	after, err := r.measure(ctx, inst.ID)
	if err != nil {
		log.Warn("post-resize verification failed", "error", err)
	} else {
		log.Info("resize verified", "usage_before_percent", usage, "usage_after_percent", after, "new_size_gib", target)
	}
	r.reportSuccess(ctx, inst, eff, usage, after, target, start)
	return nil
}

func (r *Resizer) measure(ctx context.Context, instanceID string) (int, error) {
	res, err := r.ssm.RunScript(ctx, instanceID, scripts.MeasureRootFS, r.cfg.SSMCommandTimeout)
	if err != nil {
		return 0, err
	}
	return parseUsagePercent(res.Stdout)
}

// withinCooldown reports whether the volume was modified too recently (or is
// currently being modified) to safely modify again.
func (r *Resizer) withinCooldown(ctx context.Context, volumeID string) (bool, error) {
	m, err := r.ec2.DescribeLastModification(ctx, volumeID)
	if err != nil {
		return false, err
	}
	if m == nil {
		return false, nil
	}
	switch m.State {
	case "modifying", "optimizing":
		return true, nil
	}
	if !m.StartTime.IsZero() && time.Since(m.StartTime) < modificationCooldown {
		return true, nil
	}
	return false, nil
}

// TargetSize returns the new volume size in GiB after growing current per the
// effective grow mode. In "percent" mode it grows current by GrowPercent,
// rounded up; in "absolute" mode it adds GrowAmountGiB. The result is always at
// least one GiB larger than current.
func TargetSize(current int32, eff policy.Effective) int32 {
	var grown int
	switch eff.GrowMode {
	case config.GrowModeAbsolute:
		grown = int(current) + int(eff.GrowAmountGiB)
	default:
		grown = (int(current)*(100+eff.GrowPercent) + 99) / 100
	}
	if grown < int(current)+1 {
		grown = int(current) + 1
	}
	return int32(grown)
}

// parseUsagePercent extracts a 0-100 integer from the measure script output.
func parseUsagePercent(out string) (int, error) {
	s := strings.TrimSpace(out)
	s = strings.TrimSuffix(s, "%")
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, fmt.Errorf("empty usage output")
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("parse usage %q: %w", out, err)
	}
	if n < 0 || n > 100 {
		return 0, fmt.Errorf("usage %d out of range", n)
	}
	return n, nil
}
