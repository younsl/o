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

// NodeEmitter publishes Events against Node objects, so the throughput
// recommender's per-node activity shows up where an operator already looks:
//
//	kubectl describe node <node>
//
// It is separate from Emitter because the two write to different places. Events
// about standalone EC2 instances have no cluster object to attach to and are
// recorded against the controller's own Pod in its own namespace. A Node is
// cluster-scoped, so its Events carry no namespace of their own and the API server
// stores them in "default", the same as the kubelet's own node Events. The sink is
// therefore bound to no namespace: client-go rejects an Event whose namespace
// differs from the one its sink was built with, so reusing the Pod-namespaced sink
// here would fail every write.
type NodeEmitter struct {
	recorder    record.EventRecorder
	broadcaster record.EventBroadcaster
}

// NewNodeEmitter builds a NodeEmitter using the in-cluster config. It fails
// outside a cluster, which the caller treats as "disable Node Events" rather than
// a fatal error.
func NewNodeEmitter() (*NodeEmitter, error) {
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
		Interface: clientset.CoreV1().Events(""),
	})
	return &NodeEmitter{
		recorder:    broadcaster.NewRecorder(scheme.Scheme, corev1.EventSource{Component: component}),
		broadcaster: broadcaster,
	}, nil
}

// NodeEventf records an Event against one Node. uid may be empty; the recorder
// then resolves the Node by name alone, which is enough for kubectl to associate
// the Event.
//
// Repeating the same reason for the same Node does not create a new Event object:
// the recorder aggregates it into the existing one and increments its count. That
// is what makes a per-node, per-pass Event affordable on a large cluster.
func (e *NodeEmitter) NodeEventf(name, uid, eventType, reason, messageFmt string, args ...any) {
	ref := &corev1.ObjectReference{
		Kind:       "Node",
		APIVersion: "v1",
		Name:       name,
		UID:        types.UID(uid),
	}
	e.recorder.Eventf(ref, eventType, reason, messageFmt, args...)
}

// Shutdown flushes buffered Events and stops the broadcaster.
func (e *NodeEmitter) Shutdown() {
	e.broadcaster.Shutdown()
}
