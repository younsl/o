package events

import (
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

const (
	podName = "aws-vpn-maintenance-handler-0"
	podNS   = "kube-system"
	podUID  = "11111111-2222-3333-4444-555555555555"
)

func newEmitter(t *testing.T) (*Emitter, *fake.Clientset) {
	t.Helper()
	client := fake.NewSimpleClientset()
	e, err := New(client, podName, podNS, podUID)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	t.Cleanup(e.Shutdown)
	return e, client
}

// collect waits for the asynchronous broadcaster to deliver the expected number of
// Events, then returns them.
func collect(t *testing.T, client *fake.Clientset, want int) []*corev1.Event {
	t.Helper()
	for range 200 {
		list, err := client.CoreV1().Events(podNS).List(t.Context(), metav1.ListOptions{})
		if err != nil {
			t.Fatalf("list events: %v", err)
		}
		if len(list.Items) >= want {
			out := make([]*corev1.Event, 0, len(list.Items))
			for i := range list.Items {
				out = append(out, &list.Items[i])
			}
			return out
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("only saw fewer than %d events", want)
	return nil
}

func TestNormalEventAttachesToTheControllerPod(t *testing.T) {
	e, client := newEmitter(t)

	e.Normal(ReasonReplaced, "Tunnel %s of %s: %s", "203.0.113.10", "prod-dc", "succeeded")

	ev := collect(t, client, 1)[0]
	if ev.Type != corev1.EventTypeNormal {
		t.Fatalf("Type = %q, want Normal", ev.Type)
	}
	if ev.Reason != ReasonReplaced {
		t.Fatalf("Reason = %q, want %q", ev.Reason, ReasonReplaced)
	}
	if ev.Message != "Tunnel 203.0.113.10 of prod-dc: succeeded" {
		t.Fatalf("Message = %q, want the formatted string", ev.Message)
	}
	// VPN tunnels are not cluster objects, so the Event hangs off the controller's
	// own Pod. The UID is what lets kubectl associate it with the live Pod without
	// granting permission to read Pods.
	if ev.InvolvedObject.Kind != "Pod" || ev.InvolvedObject.Name != podName {
		t.Fatalf("involvedObject = %+v", ev.InvolvedObject)
	}
	if string(ev.InvolvedObject.UID) != podUID {
		t.Fatalf("involvedObject UID = %q, want %q", ev.InvolvedObject.UID, podUID)
	}
	if ev.Namespace != podNS {
		t.Fatalf("namespace = %q, want %q", ev.Namespace, podNS)
	}
	if ev.Source.Component != component {
		t.Fatalf("source component = %q, want %q", ev.Source.Component, component)
	}
}

func TestWarningEvent(t *testing.T) {
	e, client := newEmitter(t)

	e.Warning(ReasonPeerLost, "Peer tunnel dropped while replacing %s", "203.0.113.10")

	ev := collect(t, client, 1)[0]
	if ev.Type != corev1.EventTypeWarning {
		t.Fatalf("Type = %q, want Warning", ev.Type)
	}
	if ev.Reason != ReasonPeerLost {
		t.Fatalf("Reason = %q", ev.Reason)
	}
}

// The downward API is the only source of the Pod identity, so a missing value has to
// fail at startup rather than produce Events nobody can find.
func TestNewRequiresThePodIdentity(t *testing.T) {
	tests := []struct {
		name, podName, namespace string
	}{
		{"no pod name", "", podNS},
		{"no namespace", podName, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := New(fake.NewSimpleClientset(), tc.podName, tc.namespace, podUID); err == nil {
				t.Fatal("New should have failed")
			}
		})
	}
}

// A nil Emitter is what a caller holds when event publishing was never set up, and it
// must not panic: losing the audit trail is not a reason to crash the controller.
func TestNilEmitterIsSafe(t *testing.T) {
	var e *Emitter
	e.Normal(ReasonReplaced, "ignored")
	e.Warning(ReasonReplaceFailed, "ignored")
	e.Shutdown()
}

// Shutdown must be safe to call with an Event still in flight, and must not swallow
// one that was already recorded. It is deliberately not asserted to be a synchronous
// flush: client-go writes each Event to the API in its own goroutine, so a late Event
// can still be lost on exit. Recording that here keeps the next reader from assuming
// Events are a durable record.
func TestShutdownIsSafeWithAnEventInFlight(t *testing.T) {
	client := fake.NewSimpleClientset()
	e, err := New(client, podName, podNS, podUID)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	e.Normal(ReasonReplaced, "final outcome")
	e.Shutdown()

	list, err := client.CoreV1().Events(podNS).List(t.Context(), metav1.ListOptions{})
	if err != nil {
		t.Fatalf("list events: %v", err)
	}
	for _, ev := range list.Items {
		if ev.Message == "final outcome" {
			return // delivered before shutdown completed, which is the common case
		}
	}
	t.Log("the event had not reached the sink when Shutdown returned; " +
		"Events are best-effort, which is why the outcome is also written to the ConfigMap and Slack")
}
