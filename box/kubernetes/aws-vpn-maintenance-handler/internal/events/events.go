// Package events publishes Kubernetes Events about tunnel replacements. The objects
// changed are AWS tunnels, not cluster resources, so Events attach to the
// controller's own Pod, giving an audit trail readable without Slack or CloudTrail:
//
//	kubectl -n kube-system describe pod <aws-vpn-maintenance-handler-pod>
package events

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	typedcorev1 "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/client-go/tools/record"
)

const component = "aws-vpn-maintenance-handler"

// Event reasons, stable because operators write selectors and alerts against them.
const (
	ReasonMaintenanceDetected = "MaintenanceDetected"
	ReasonApprovalRequested   = "ApprovalRequested"
	ReasonApproved            = "ReplacementApproved"
	ReasonDenied              = "ReplacementDenied"
	ReasonApprovalTimeout     = "ApprovalTimedOut"
	ReasonApprovalExpired     = "ApprovalExpired"
	ReasonReplacing           = "ReplacingTunnel"
	ReasonReplaced            = "TunnelReplaced"
	ReasonReplaceFailed       = "TunnelReplaceFailed"
	ReasonPeerLost            = "PeerTunnelLost"
	ReasonHeldBack            = "MaintenanceHeldBack"
)

// Emitter publishes Events against the controller's own Pod.
type Emitter struct {
	recorder    record.EventRecorder
	broadcaster record.EventBroadcaster
	ref         *corev1.ObjectReference
}

// New builds an Emitter from downward API values. The UID lets kubectl associate
// Events with the live Pod without granting permission to read Pods.
func New(client kubernetes.Interface, podName, podNamespace, podUID string) (*Emitter, error) {
	if podName == "" || podNamespace == "" {
		return nil, fmt.Errorf("POD_NAME and POD_NAMESPACE must be set (downward API)")
	}

	broadcaster := record.NewBroadcaster()
	broadcaster.StartRecordingToSink(&typedcorev1.EventSinkImpl{
		Interface: client.CoreV1().Events(podNamespace),
	})
	recorder := broadcaster.NewRecorder(scheme.Scheme, corev1.EventSource{Component: component})

	return &Emitter{
		recorder:    recorder,
		broadcaster: broadcaster,
		ref: &corev1.ObjectReference{
			Kind:      "Pod",
			Name:      podName,
			Namespace: podNamespace,
			UID:       types.UID(podUID),
		},
	}, nil
}

// Normal records an expected step.
func (e *Emitter) Normal(reason, format string, args ...any) {
	if e == nil {
		return
	}
	e.recorder.Eventf(e.ref, corev1.EventTypeNormal, reason, format, args...)
}

// Warning records something that needs attention.
func (e *Emitter) Warning(reason, format string, args ...any) {
	if e == nil {
		return
	}
	e.recorder.Eventf(e.ref, corev1.EventTypeWarning, reason, format, args...)
}

// Shutdown stops the broadcaster and waits for queued Events to be distributed to it.
//
// It is not a full flush: client-go writes each Event to the API in its own goroutine
// with retries, and that is not waited on, so an Event recorded in the last moments
// before exit can still be lost. Slack and the state ConfigMap are the durable record;
// Events are the convenient one.
func (e *Emitter) Shutdown() {
	if e == nil {
		return
	}
	e.broadcaster.Shutdown()
}
