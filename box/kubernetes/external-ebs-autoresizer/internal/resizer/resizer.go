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
	ObserveResize(success bool)
	ObserveError(stage string)
}

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

// Alert severities and names used for the alerts sent per resize operation.
const (
	severityWarning = "warning"
	severityInfo    = "info"

	alertResizeFailed    = "EBSRootVolumeAutoresizeFailed"
	alertResizeCompleted = "EBSRootVolumeAutoresizeCompleted"
)

// Event types and reasons used for the Kubernetes Events emitted per instance.
const (
	eventTypeNormal  = "Normal"
	eventTypeWarning = "Warning"

	reasonResizeStarted   = "ResizeStarted"
	reasonResizeCompleted = "ResizeCompleted"
	reasonResizeFailed    = "ResizeFailed"
)

// Resizer holds dependencies for one reconcile pass.
type Resizer struct {
	cfg       *config.Config
	ec2       EC2API
	ssm       SSMAPI
	rec       Recorder
	events    EventEmitter
	notifier  AlertNotifier
	annotator Annotator
	logger    *slog.Logger
}

// New constructs a Resizer. events may be nil to disable Kubernetes Events;
// notifier may be nil to disable Alertmanager alerting; annotator may be nil to
// disable Grafana annotations.
func New(cfg *config.Config, ec2 EC2API, ssm SSMAPI, rec Recorder, events EventEmitter, notifier AlertNotifier, annotator Annotator, logger *slog.Logger) *Resizer {
	return &Resizer{cfg: cfg, ec2: ec2, ssm: ssm, rec: rec, events: events, notifier: notifier, annotator: annotator, logger: logger}
}

// emit publishes a Kubernetes Event when an emitter is configured.
func (r *Resizer) emit(eventType, reason, messageFmt string, args ...any) {
	if r.events != nil {
		r.events.Eventf(eventType, reason, messageFmt, args...)
	}
}

// notify sends an alert when a notifier is configured and the resize outcome
// matches the configured notify-on policy. severityInfo marks a success and
// severityWarning marks a failure.
func (r *Resizer) notify(ctx context.Context, severity, alertname, summary, description string, labels map[string]string, startsAt time.Time) {
	if r.notifier == nil {
		return
	}
	switch r.cfg.AlertmanagerNotifyOn {
	case config.NotifyOnSuccess:
		if severity != severityInfo {
			return
		}
	case config.NotifyOnFailure:
		if severity != severityWarning {
			return
		}
	}
	r.notifier.Notify(ctx, severity, alertname, summary, description, labels, startsAt)
}

// annotate posts a Grafana annotation when an annotator is configured and the
// resize outcome matches the configured annotate-on policy. A successful resize
// is a region annotation spanning start..end; a failure is a point annotation
// at start (end is the zero time).
func (r *Resizer) annotate(ctx context.Context, success bool, text string, inst awsx.Instance, start, end time.Time) {
	if r.annotator == nil {
		return
	}
	switch r.cfg.GrafanaAnnotateOn {
	case config.AnnotateOnSuccess:
		if !success {
			return
		}
	case config.AnnotateOnFailure:
		if success {
			return
		}
	}
	r.annotator.Annotate(ctx, text, annotationTags(inst, success), start, end)
}

// annotationTags builds the per-annotation tags identifying the instance and
// outcome. They are appended to the configured base tags (e.g. event:ebs-resize)
// so dashboards can filter resize markers down to a single disk or outcome.
func annotationTags(inst awsx.Instance, success bool) []string {
	result := "failure"
	if success {
		result = "success"
	}
	return []string{
		"instance_id:" + inst.ID,
		"instance_name:" + inst.Name,
		"volume_id:" + inst.RootVolumeID,
		"device:" + inst.RootDeviceName,
		"result:" + result,
	}
}

// alertLabels builds the identifying labels attached to alerts for an instance.
func alertLabels(inst awsx.Instance) map[string]string {
	return map[string]string{
		"instance_id":   inst.ID,
		"instance_name": inst.Name,
		"volume_id":     inst.RootVolumeID,
		"device":        inst.RootDeviceName,
	}
}

// failureDescription builds the alert description for a failed resize as a
// sentence. The volume is not resized on failure, so only the pre-resize usage
// is reported alongside the failing instance, device, and reason.
func failureDescription(inst awsx.Instance, usage int, reason string) string {
	return fmt.Sprintf("Instance %s (%s) device %s failed to autoresize at %d%% root filesystem usage. Cause: %s.",
		inst.ID, inst.Name, inst.RootDeviceName, usage, reason)
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

	// Reconcile instances concurrently with a bounded worker pool. Each instance
	// targets an independent EBS volume, so parallelism is safe; the semaphore
	// caps in-flight SSM/EC2 calls to stay within API rate limits. Per-instance
	// failures are logged and counted but never abort the pass.
	concurrency := max(r.cfg.ReconcileConcurrency, 1)
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for _, inst := range instances {
		if ctx.Err() != nil {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(inst awsx.Instance) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := r.reconcileInstance(ctx, inst); err != nil {
				r.logger.Error("instance reconcile failed", "instance", inst.ID, "name", inst.Name, "error", err)
			}
		}(inst)
	}
	wg.Wait()
	return len(instances), ctx.Err()
}

func (r *Resizer) reconcileInstance(ctx context.Context, inst awsx.Instance) error {
	log := r.logger.With("instance", inst.ID, "name", inst.Name)

	if inst.RootVolumeID == "" {
		log.Warn("no root EBS volume resolved, skipping")
		return nil
	}

	// 1. Measure.
	usage, err := r.measure(ctx, inst.ID)
	if err != nil {
		r.rec.ObserveError("measure")
		return fmt.Errorf("measure usage: %w", err)
	}
	r.rec.ObserveUsage(inst.ID, inst.RootDeviceName, inst.RootVolumeID, inst.Name, float64(usage))
	log.Debug("measured root usage", "usage_percent", usage, "threshold_percent", r.cfg.UsageThresholdPercent)

	// 2. Decide.
	if usage < r.cfg.UsageThresholdPercent {
		log.Debug("usage below threshold, nothing to do")
		return nil
	}

	// 3. Target size.
	current := inst.RootVolumeSizeGiB
	target := TargetSize(current, r.cfg.GrowPercent)
	log = log.With("volume", inst.RootVolumeID, "current_gib", current, "target_gib", target)

	// 4. Safety guards.
	if int(target) > r.cfg.MaxVolumeSizeGiB {
		log.Warn("target exceeds max volume size, skipping", "max_gib", r.cfg.MaxVolumeSizeGiB)
		return nil
	}
	skip, err := r.withinCooldown(ctx, inst.RootVolumeID)
	if err != nil {
		r.rec.ObserveError("cooldown")
		return fmt.Errorf("check cooldown: %w", err)
	}
	if skip {
		log.Info("volume modified within cooldown window, skipping")
		return nil
	}

	if r.cfg.DryRun {
		log.Info("dry-run: would modify volume and resize filesystem")
		return nil
	}

	// 5. Grow the EBS volume.
	start := time.Now()
	r.emit(eventTypeNormal, reasonResizeStarted,
		"Resizing root filesystem on device %s of instance %s (%s) by growing volume %s from %d GiB to %d GiB (usage %d%%)",
		inst.RootDeviceName, inst.Name, inst.ID, inst.RootVolumeID, current, target, usage)
	if err := r.ec2.ModifyVolume(ctx, inst.RootVolumeID, target); err != nil {
		r.rec.ObserveError("modify")
		r.rec.ObserveResize(false)
		r.emit(eventTypeWarning, reasonResizeFailed,
			"ModifyVolume failed for volume %s (device %s on instance %s): %v", inst.RootVolumeID, inst.RootDeviceName, inst.ID, err)
		r.notify(ctx, severityWarning, alertResizeFailed,
			"EBS root volume autoresize failed",
			failureDescription(inst, usage, fmt.Sprintf("ModifyVolume failed: %v", err)),
			alertLabels(inst), start)
		r.annotate(ctx, false, failureDescription(inst, usage, fmt.Sprintf("ModifyVolume failed: %v", err)), inst, start, time.Time{})
		return fmt.Errorf("modify volume: %w", err)
	}
	log.Info("requested volume modification")

	// 6. Wait until the modification is usable.
	if err := r.ec2.WaitForModification(ctx, inst.RootVolumeID, r.cfg.VolumeModifyTimeout); err != nil {
		r.rec.ObserveError("wait")
		r.rec.ObserveResize(false)
		r.emit(eventTypeWarning, reasonResizeFailed,
			"Volume %s (device %s on instance %s) did not reach optimizing: %v", inst.RootVolumeID, inst.RootDeviceName, inst.ID, err)
		r.notify(ctx, severityWarning, alertResizeFailed,
			"EBS root volume autoresize failed",
			failureDescription(inst, usage, fmt.Sprintf("volume did not reach optimizing: %v", err)),
			alertLabels(inst), start)
		r.annotate(ctx, false, failureDescription(inst, usage, fmt.Sprintf("volume did not reach optimizing: %v", err)), inst, start, time.Time{})
		return fmt.Errorf("wait for modification: %w", err)
	}
	log.Info("volume modification optimizing", "elapsed", time.Since(start).String())

	// 7. Extend the filesystem in place.
	res, err := r.ssm.RunScript(ctx, inst.ID, scripts.ResizeRootFS, r.cfg.SSMCommandTimeout)
	if err != nil {
		r.rec.ObserveError("resize")
		r.rec.ObserveResize(false)
		r.emit(eventTypeWarning, reasonResizeFailed,
			"Resize of root filesystem on device %s failed on instance %s (volume %s now %d GiB): %v", inst.RootDeviceName, inst.ID, inst.RootVolumeID, target, err)
		r.notify(ctx, severityWarning, alertResizeFailed,
			"EBS root volume autoresize failed",
			failureDescription(inst, usage, fmt.Sprintf("filesystem resize failed: %v", err)),
			alertLabels(inst), start)
		r.annotate(ctx, false, failureDescription(inst, usage, fmt.Sprintf("filesystem resize failed: %v", err)), inst, start, time.Time{})
		return fmt.Errorf("resize filesystem: %w", err)
	}
	log.Info("filesystem resize completed", "stdout", strings.TrimSpace(res.Stdout))

	// 8. Verify.
	after, err := r.measure(ctx, inst.ID)
	if err != nil {
		log.Warn("post-resize verification failed", "error", err)
	} else {
		log.Info("resize verified", "usage_before_percent", usage, "usage_after_percent", after, "new_size_gib", target)
	}
	r.rec.ObserveResize(true)
	r.emit(eventTypeNormal, reasonResizeCompleted,
		"Resized root filesystem on device %s of instance %s (%s) to %d GiB in %s. Disk usage changed from %d%% to %d%%",
		inst.RootDeviceName, inst.Name, inst.ID, target, time.Since(start).Round(time.Second), usage, after)
	completedDescription := fmt.Sprintf("Instance %s (%s) device %s was autoresized to %d GiB. Root filesystem usage changed from %d%% to %d%%.",
		inst.ID, inst.Name, inst.RootDeviceName, target, usage, after)
	r.notify(ctx, severityInfo, alertResizeCompleted,
		"EBS root volume autoresize completed",
		completedDescription,
		alertLabels(inst), start)
	// A completed resize is a region annotation spanning the time the resize
	// took, so dashboards show how long the volume was being grown.
	r.annotate(ctx, true, completedDescription, inst, start, time.Now())
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

// TargetSize returns the new volume size in GiB after growing current by
// growPercent, rounded up and always at least one GiB larger than current.
func TargetSize(current int32, growPercent int) int32 {
	grown := (int(current)*(100+growPercent) + 99) / 100
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
