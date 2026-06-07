package events

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

func TestNewRequiresPodIdentity(t *testing.T) {
	if _, err := New("", "ns", "uid"); err == nil {
		t.Error("New with empty pod name = nil error, want error")
	}
	if _, err := New("pod", "", "uid"); err == nil {
		t.Error("New with empty namespace = nil error, want error")
	}
}

func TestNewOutsideClusterReturnsError(t *testing.T) {
	t.Setenv("KUBERNETES_SERVICE_HOST", "")
	t.Setenv("KUBERNETES_SERVICE_PORT", "")
	if _, err := New("pod", "ns", "uid"); err == nil {
		t.Error("New outside cluster = nil error, want in-cluster config error")
	}
}

func TestNewPodRef(t *testing.T) {
	ref := newPodRef("autoresizer-abc", "ebs-system", "uid-123")
	if ref.Kind != "Pod" || ref.APIVersion != "v1" {
		t.Errorf("ref kind/apiVersion = %s/%s, want Pod/v1", ref.Kind, ref.APIVersion)
	}
	if ref.Name != "autoresizer-abc" || ref.Namespace != "ebs-system" || string(ref.UID) != "uid-123" {
		t.Errorf("ref = %+v, want name/ns/uid autoresizer-abc/ebs-system/uid-123", ref)
	}
}

// fakeRecorder captures Eventf arguments.
type fakeRecorder struct {
	obj         runtime.Object
	eventType   string
	reason      string
	gotMessages int
}

func (f *fakeRecorder) Event(runtime.Object, string, string, string) {}
func (f *fakeRecorder) Eventf(object runtime.Object, eventType, reason, _ string, _ ...any) {
	f.obj = object
	f.eventType = eventType
	f.reason = reason
	f.gotMessages++
}
func (f *fakeRecorder) AnnotatedEventf(runtime.Object, map[string]string, string, string, string, ...any) {
}

func TestEmitterEventfDelegates(t *testing.T) {
	rec := &fakeRecorder{}
	ref := newPodRef("p", "ns", "uid")
	e := &Emitter{recorder: rec, ref: ref}

	e.Eventf("Warning", "ResizeFailed", "failed on %s", "vol-1")

	if rec.gotMessages != 1 {
		t.Fatalf("Eventf called %d times, want 1", rec.gotMessages)
	}
	if rec.eventType != "Warning" || rec.reason != "ResizeFailed" {
		t.Errorf("eventType/reason = %s/%s, want Warning/ResizeFailed", rec.eventType, rec.reason)
	}
	if got, ok := rec.obj.(*corev1.ObjectReference); !ok || got != ref {
		t.Errorf("involvedObject = %v, want the pod ref", rec.obj)
	}
}
