package resizer

import (
	"context"
	"fmt"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/policy"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/recstore"
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
// The Resize* reasons go to the addon's own Pod (standalone EC2 instances have
// no Kubernetes object to attach to); the Volume* reasons go to the target
// Node when the volume belongs to one, so the modification is visible in
// kubectl describe node.
const (
	eventTypeNormal  = "Normal"
	eventTypeWarning = "Warning"

	reasonResizeStarted   = "ResizeStarted"
	reasonResizeCompleted = "ResizeCompleted"
	reasonResizeFailed    = "ResizeFailed"

	reasonVolumeModified     = "VolumeModified"
	reasonVolumeModifyFailed = "VolumeModifyFailed"
)

// modSummary describes one attempted volume modification: every dimension it
// would change and the Node the volume belongs to. It exists so each report
// sink states exactly what was (or would have been) modified, instead of the
// size alone.
type modSummary struct {
	// nodeName/nodeUID address the Node event; empty when the volume's node is
	// unknown (standalone instance, or the recommender has not seen it).
	nodeName, nodeUID string
	volumeID          string
	sizeFromGiB       int32
	sizeToGiB         int32
	// tpToMiBps zero means no throughput change was attempted.
	tpFromMiBps, tpToMiBps int32
	iopsFrom, iopsTo       int32
	// fallback records that the combined request was rejected and the size
	// change was applied alone.
	fallback bool
}

// newModSummary assembles the modification summary for one resize attempt.
func (r *Resizer) newModSummary(volumeID string, current, target int32, rec recstore.Entry, piggyback bool) modSummary {
	mod := modSummary{volumeID: volumeID, sizeFromGiB: current, sizeToGiB: target}
	if r.recs != nil {
		if name, uid, ok := r.recs.NodeRef(volumeID); ok {
			mod.nodeName, mod.nodeUID = name, uid
		}
	}
	if piggyback {
		mod.tpFromMiBps, mod.tpToMiBps = rec.CurrentMiBps, rec.ThroughputMiBps
		mod.iopsFrom, mod.iopsTo = rec.CurrentIOPS, rec.IOPS
	}
	return mod
}

// changes renders every dimension the modification touches, e.g.
// "size 100 GiB to 110 GiB, throughput 125 to 250 MiB/s, IOPS 3000 to 4000".
// Dimensions that stay untouched are omitted rather than reported unchanged.
func (m modSummary) changes() string {
	s := fmt.Sprintf("size %d GiB to %d GiB", m.sizeFromGiB, m.sizeToGiB)
	if m.tpToMiBps > 0 && !m.fallback {
		s += fmt.Sprintf(", throughput %d to %d MiB/s", m.tpFromMiBps, m.tpToMiBps)
		if m.iopsTo != m.iopsFrom {
			s += fmt.Sprintf(", IOPS %d to %d", m.iopsFrom, m.iopsTo)
		}
	}
	return s
}

// fallbackNote names the throughput change that was attempted but not applied,
// or "" when there was none.
func (m modSummary) fallbackNote() string {
	if !m.fallback {
		return ""
	}
	return fmt.Sprintf(" A piggybacked throughput increase (%d to %d MiB/s) was rejected by EC2 and was not applied; the size change proceeded alone.",
		m.tpFromMiBps, m.tpToMiBps)
}

// piggybackNote describes the throughput change carried on the modification as
// a sentence for the alert description, or "" when the request was size-only.
func (m modSummary) piggybackNote() string {
	if m.tpToMiBps == 0 || m.fallback {
		return m.fallbackNote()
	}
	s := fmt.Sprintf(" Throughput was raised from %d to %d MiB/s", m.tpFromMiBps, m.tpToMiBps)
	if m.iopsTo != m.iopsFrom {
		s += fmt.Sprintf(" (IOPS %d to %d)", m.iopsFrom, m.iopsTo)
	}
	return s + " on the piggybacked recommendation."
}

// emitNode publishes an Event against the volume's Node, when both the node
// and an emitter are known.
func (r *Resizer) emitNode(mod modSummary, eventType, reason, messageFmt string, args ...any) {
	if r.nodeEvents == nil || mod.nodeName == "" {
		return
	}
	r.nodeEvents.NodeEventf(mod.nodeName, mod.nodeUID, eventType, reason, messageFmt, args...)
}

// reportStarted announces a resize attempt before the first mutating AWS call.
func (r *Resizer) reportStarted(inst awsx.Instance, current, target int32, usage int) {
	r.emit(eventTypeNormal, reasonResizeStarted,
		"Resizing root filesystem on device %s of instance %s (%s) by growing volume %s from %d GiB to %d GiB (usage %d%%)",
		inst.RootDeviceName, inst.Name, inst.ID, inst.RootVolumeID, current, target, usage)
}

// reportFailure records one failed resize attempt across every sink. stage is
// the reconcile stage that failed (modify, wait, resize) for error_total;
// cause is a short human-readable sentence fragment naming what went wrong.
func (r *Resizer) reportFailure(ctx context.Context, inst awsx.Instance, eff policy.Effective, usage int, mod modSummary, stage, cause string, start time.Time) {
	r.rec.ObserveError(stage)
	r.rec.ObserveResize(false, eff.Policy)
	desc := failureDescription(inst, usage, cause)
	r.emit(eventTypeWarning, reasonResizeFailed, "%s", desc)
	// The Node event names every dimension the failed request attempted, so an
	// operator reading kubectl describe node sees exactly what did not happen.
	r.emitNode(mod, eventTypeWarning, reasonVolumeModifyFailed,
		"Failed to modify EBS volume %s (attempted %s) at stage %q: %s", mod.volumeID, mod.changes(), stage, cause)
	r.notify(ctx, eff, severityWarning, alertResizeFailed, "EBS root volume autoresize failed", desc, alertLabels(inst), start)
	// A failure is a point annotation at start (end is the zero time).
	r.annotate(ctx, false, desc, inst, start, time.Time{})
}

// reportSuccess records one completed resize across every sink. usage/after
// are the pre/post-resize usage percents; mod carries every dimension the
// modification changed (or attempted, on a fallback).
func (r *Resizer) reportSuccess(ctx context.Context, inst awsx.Instance, eff policy.Effective, usage, after int, mod modSummary, start time.Time) {
	target := mod.sizeToGiB
	r.rec.ObserveResize(true, eff.Policy)
	// Reflect the new size immediately instead of waiting for the next pass.
	r.rec.ObserveVolumeSize(inst.ID, inst.RootDeviceName, inst.RootVolumeID, inst.Name, target)
	note := mod.piggybackNote()
	desc := fmt.Sprintf("Instance %s (%s) device %s was autoresized to %d GiB. Root filesystem usage changed from %d%% to %d%%.%s",
		inst.ID, inst.Name, inst.RootDeviceName, target, usage, after, note)
	r.emit(eventTypeNormal, reasonResizeCompleted,
		"Resized root filesystem on device %s of instance %s (%s) to %d GiB in %s. Disk usage changed from %d%% to %d%%%s",
		inst.RootDeviceName, inst.Name, inst.ID, target, time.Since(start).Round(time.Second), usage, after, note)
	// The Node event enumerates exactly what changed on the volume in this one
	// modification slot, and names what was attempted but not applied.
	r.emitNode(mod, eventTypeNormal, reasonVolumeModified,
		"Modified EBS volume %s in one modification slot: %s. Root filesystem usage changed from %d%% to %d%%.%s",
		mod.volumeID, mod.changes(), usage, after, mod.fallbackNote())
	r.notify(ctx, eff, severityInfo, alertResizeCompleted, "EBS root volume autoresize completed", desc, alertLabels(inst), start)
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

// notify sends an alert when a notifier is configured, the instance's
// effective policy has alerting enabled, and the resize outcome matches the
// configured notify-on policy. severityInfo marks a success and
// severityWarning marks a failure.
func (r *Resizer) notify(ctx context.Context, eff policy.Effective, severity, alertname, summary, description string, labels map[string]string, startsAt time.Time) {
	if r.notifier == nil || !eff.AlertEnabled {
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
