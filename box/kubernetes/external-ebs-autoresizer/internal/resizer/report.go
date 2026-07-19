package resizer

import (
	"context"
	"fmt"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/policy"
)

// This file is the single place where resize outcomes fan out to the
// observation sinks: metrics, Kubernetes Events, Alertmanager alerts, and
// Grafana annotations. reconcileInstance reports every outcome through
// reportSuccess/reportFailure, so adding a new sink (or changing how outcomes
// are described) touches only this file.

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

// reportStarted announces a resize attempt before the first mutating AWS call.
func (r *Resizer) reportStarted(inst awsx.Instance, current, target int32, usage int) {
	r.emit(eventTypeNormal, reasonResizeStarted,
		"Resizing root filesystem on device %s of instance %s (%s) by growing volume %s from %d GiB to %d GiB (usage %d%%)",
		inst.RootDeviceName, inst.Name, inst.ID, inst.RootVolumeID, current, target, usage)
}

// reportFailure records one failed resize attempt across every sink. stage is
// the reconcile stage that failed (modify, wait, resize) for error_total;
// cause is a short human-readable sentence fragment naming what went wrong.
func (r *Resizer) reportFailure(ctx context.Context, inst awsx.Instance, eff policy.Effective, usage int, stage, cause string, start time.Time) {
	r.rec.ObserveError(stage)
	r.rec.ObserveResize(false, eff.Policy)
	desc := failureDescription(inst, usage, cause)
	r.emit(eventTypeWarning, reasonResizeFailed, "%s", desc)
	r.notify(ctx, severityWarning, alertResizeFailed, "EBS root volume autoresize failed", desc, alertLabels(inst), start)
	// A failure is a point annotation at start (end is the zero time).
	r.annotate(ctx, false, desc, inst, start, time.Time{})
}

// reportSuccess records one completed resize across every sink. usage/after
// are the pre/post-resize usage percents; target is the new volume size.
func (r *Resizer) reportSuccess(ctx context.Context, inst awsx.Instance, eff policy.Effective, usage, after int, target int32, start time.Time) {
	r.rec.ObserveResize(true, eff.Policy)
	// Reflect the new size immediately instead of waiting for the next pass.
	r.rec.ObserveVolumeSize(inst.ID, inst.RootDeviceName, inst.RootVolumeID, inst.Name, target)
	desc := fmt.Sprintf("Instance %s (%s) device %s was autoresized to %d GiB. Root filesystem usage changed from %d%% to %d%%.",
		inst.ID, inst.Name, inst.RootDeviceName, target, usage, after)
	r.emit(eventTypeNormal, reasonResizeCompleted,
		"Resized root filesystem on device %s of instance %s (%s) to %d GiB in %s. Disk usage changed from %d%% to %d%%",
		inst.RootDeviceName, inst.Name, inst.ID, target, time.Since(start).Round(time.Second), usage, after)
	r.notify(ctx, severityInfo, alertResizeCompleted, "EBS root volume autoresize completed", desc, alertLabels(inst), start)
	// A completed resize is a region annotation spanning the time the resize
	// took, so dashboards show how long the volume was being grown.
	r.annotate(ctx, true, desc, inst, start, time.Now())
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
