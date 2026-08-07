// Package events publishes Kubernetes Events about resize operations. Because
// the controller acts on standalone EC2 instances rather than cluster objects,
// every Event is attached to the controller's own Pod (resolved from the
// downward API), so operators can read resize history via:
//
//	kubectl describe pod <external-ebs-autoresizer-pod>
//	kubectl -n <namespace> get events
package events

import (
	"fmt"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	typedcorev1 "k8s.io/client-go/kubernetes/typed/core/v1"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/record"
)

const component = "external-ebs-autoresizer"

// Emitter publishes Kubernetes Events against the controller's own Pod.
type Emitter struct {
	recorder    record.EventRecorder
	broadcaster record.EventBroadcaster
	ref         *corev1.ObjectReference
}

// New builds an Emitter using the in-cluster config. podName, podNamespace, and
// podUID come from the downward API; the UID lets kubectl associate Events with
// the live Pod without granting the controller pod-get permission. Events are
// written to the Pod's own namespace, so RBAC only needs create/patch on events.
func New(podName, podNamespace, podUID string) (*Emitter, error) {
	if podName == "" || podNamespace == "" {
		return nil, fmt.Errorf("POD_NAME and POD_NAMESPACE must be set (downward API)")
	}

	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("in-cluster config: %w", err)
	}
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("kubernetes client: %w", err)
	}

	broadcaster := record.NewBroadcaster()
	broadcaster.StartRecordingToSink(&typedcorev1.EventSinkImpl{
		Interface: clientset.CoreV1().Events(podNamespace),
	})
	recorder := broadcaster.NewRecorder(scheme.Scheme, corev1.EventSource{Component: component})

	return &Emitter{recorder: recorder, broadcaster: broadcaster, ref: newPodRef(podName, podNamespace, podUID)}, nil
}

// newPodRef builds the involvedObject reference for the controller's own Pod.
func newPodRef(podName, podNamespace, podUID string) *corev1.ObjectReference {
	return &corev1.ObjectReference{
		Kind:       "Pod",
		APIVersion: "v1",
		Namespace:  podNamespace,
		Name:       podName,
		UID:        types.UID(podUID),
	}
}

// Eventf records an Event of the given type (Normal or Warning) and reason. The
// recorder resolves the *ObjectReference directly, so no API read is performed
// to build the involvedObject.
func (e *Emitter) Eventf(eventType, reason, messageFmt string, args ...any) {
	e.recorder.Eventf(e.ref, eventType, reason, messageFmt, args...)
}

// Shutdown flushes buffered Events and stops the broadcaster. Call on exit so
// the final Events are delivered before the process terminates.
func (e *Emitter) Shutdown() {
	e.broadcaster.Shutdown()
}
