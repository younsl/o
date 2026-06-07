// Package resizer orchestrates the measure -> decide -> grow -> wait -> expand
// flow for the root EBS volume of each target standalone EC2 instance.
package resizer

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
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
	ObserveUsage(instanceID string, percent float64)
	ObserveResize(success bool)
	ObserveError(stage string)
}

// EventEmitter publishes Kubernetes Events about resize operations.
// events.Emitter implements it. A nil EventEmitter disables event publishing
// (e.g. when running outside a cluster or during tests).
type EventEmitter interface {
	Eventf(eventType, reason, messageFmt string, args ...any)
}

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
	cfg    *config.Config
	ec2    EC2API
	ssm    SSMAPI
	rec    Recorder
	events EventEmitter
	logger *slog.Logger
}

// New constructs a Resizer. events may be nil to disable Kubernetes Events.
func New(cfg *config.Config, ec2 EC2API, ssm SSMAPI, rec Recorder, events EventEmitter, logger *slog.Logger) *Resizer {
	return &Resizer{cfg: cfg, ec2: ec2, ssm: ssm, rec: rec, events: events, logger: logger}
}

// emit publishes a Kubernetes Event when an emitter is configured.
func (r *Resizer) emit(eventType, reason, messageFmt string, args ...any) {
	if r.events != nil {
		r.events.Eventf(eventType, reason, messageFmt, args...)
	}
}

// Reconcile discovers all target instances and processes each one. Per-instance
// failures are logged and counted but do not abort the pass.
func (r *Resizer) Reconcile(ctx context.Context) error {
	filters := make([]awsx.TagFilter, len(r.cfg.TagFilters))
	for i, f := range r.cfg.TagFilters {
		filters[i] = awsx.TagFilter{Key: f.Key, Value: f.Value}
	}

	instances, err := r.ec2.DescribeTargetInstances(ctx, filters, r.cfg.ExcludeEKSNodes)
	if err != nil {
		r.rec.ObserveError("discover")
		return fmt.Errorf("discover instances: %w", err)
	}
	r.logger.Info("discovered target instances", "count", len(instances))

	for _, inst := range instances {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := r.reconcileInstance(ctx, inst); err != nil {
			r.logger.Error("instance reconcile failed", "instance", inst.ID, "name", inst.Name, "error", err)
		}
	}
	return nil
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
	r.rec.ObserveUsage(inst.ID, float64(usage))
	log.Info("measured root usage", "usage_percent", usage, "threshold_percent", r.cfg.UsageThresholdPercent)

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
		return fmt.Errorf("modify volume: %w", err)
	}
	log.Info("requested volume modification")

	// 6. Wait until the modification is usable.
	if err := r.ec2.WaitForModification(ctx, inst.RootVolumeID, r.cfg.VolumeModifyTimeout); err != nil {
		r.rec.ObserveError("wait")
		r.rec.ObserveResize(false)
		r.emit(eventTypeWarning, reasonResizeFailed,
			"Volume %s (device %s on instance %s) did not reach optimizing: %v", inst.RootVolumeID, inst.RootDeviceName, inst.ID, err)
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
