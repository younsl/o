package argocd

import (
	"context"
	"encoding/json"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

const skipAnnotation = "promotion-gate.younsl.github.io/skip"

func decodeApp(t *testing.T, raw string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	return out
}

func TestSnapshotFromMapFullApplication(t *testing.T) {
	obj := decodeApp(t, `{
		"metadata": {"name": "prd-payment-api", "namespace": "argocd"},
		"spec": {"project": "prd"},
		"status": {
			"sync": {"status": "Synced"},
			"health": {"status": "Healthy"},
			"summary": {"images": [
				"123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/payment-api:tag-abc",
				"123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/nginx:1.20-alpine",
				"   "
			]}
		}
	}`)

	snap, err := SnapshotFromMap(obj, skipAnnotation)
	if err != nil {
		t.Fatalf("SnapshotFromMap() error = %v", err)
	}
	if snap.Name != "prd-payment-api" || snap.Project != "prd" || snap.Identity != "payment-api" {
		t.Errorf("snapshot identity = %+v", snap)
	}
	if !snap.IsSynced() || !snap.IsHealthy() {
		t.Error("snapshot did not report Synced/Healthy")
	}
	if len(snap.LiveImages) != 2 {
		t.Errorf("LiveImages = %+v, want the two real images", snap.LiveImages)
	}
	if snap.SkipRequested {
		t.Error("SkipRequested = true without the annotation")
	}
}

func TestSnapshotFromMapTolerantParsing(t *testing.T) {
	cases := []struct {
		name         string
		raw          string
		wantProject  string
		wantIdentity string
	}{
		{
			name:         "no status yet",
			raw:          `{"metadata":{"name":"prd-new-app"},"spec":{"project":"prd"}}`,
			wantProject:  "prd",
			wantIdentity: "new-app",
		},
		{
			name:         "no project falls back to default",
			raw:          `{"metadata":{"name":"orphan"}}`,
			wantProject:  "default",
			wantIdentity: "orphan",
		},
		{
			name:         "wrong types are ignored",
			raw:          `{"metadata":{"name":"prd-app"},"spec":{"project":"prd"},"status":{"sync":"nope","summary":{"images":"nope"}}}`,
			wantProject:  "prd",
			wantIdentity: "app",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			snap, err := SnapshotFromMap(decodeApp(t, tc.raw), skipAnnotation)
			if err != nil {
				t.Fatalf("SnapshotFromMap() error = %v", err)
			}
			if snap.Project != tc.wantProject || snap.Identity != tc.wantIdentity {
				t.Errorf("snapshot = %+v, want project %q identity %q", snap, tc.wantProject, tc.wantIdentity)
			}
			if snap.IsSynced() || snap.IsHealthy() {
				t.Error("an unreconciled app reported as Synced or Healthy")
			}
		})
	}
}

func TestSnapshotFromMapRequiresName(t *testing.T) {
	if _, err := SnapshotFromMap(decodeApp(t, `{"spec":{"project":"prd"}}`), skipAnnotation); err == nil {
		t.Fatal("SnapshotFromMap() without a name = nil error, want failure")
	}
	if _, err := SnapshotFromMap(decodeApp(t, `{"metadata":{"name":""}}`), skipAnnotation); err == nil {
		t.Fatal("SnapshotFromMap() with an empty name = nil error, want failure")
	}
}

func TestSnapshotFromMapSkipAnnotation(t *testing.T) {
	cases := map[string]bool{
		`"true"`:  true,
		`"True"`:  true,
		`" true"`: true,
		`"false"`: false,
		`"yes"`:   false,
		`""`:      false,
		`true`:    false, // a boolean, not the string the annotation contract expects
	}
	for value, want := range cases {
		t.Run(value, func(t *testing.T) {
			raw := `{"metadata":{"name":"prd-app","annotations":{"` + skipAnnotation + `":` + value + `}},"spec":{"project":"prd"}}`
			snap, err := SnapshotFromMap(decodeApp(t, raw), skipAnnotation)
			if err != nil {
				t.Fatalf("SnapshotFromMap() error = %v", err)
			}
			if snap.SkipRequested != want {
				t.Errorf("SkipRequested for %s = %v, want %v", value, snap.SkipRequested, want)
			}
		})
	}
}

func newFakeReader(t *testing.T, objects ...*unstructured.Unstructured) *Reader {
	t.Helper()
	// The Application CRD is not in any built-in scheme, so the fake dynamic
	// client needs the list kind spelled out.
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		runtime.NewScheme(),
		map[schema.GroupVersionResource]string{ApplicationGVR: "ApplicationList"},
		toRuntimeObjects(objects)...,
	)
	return NewReader(client, "argocd", skipAnnotation)
}

func toRuntimeObjects(objects []*unstructured.Unstructured) []runtime.Object {
	out := make([]runtime.Object, 0, len(objects))
	for _, obj := range objects {
		out = append(out, obj)
	}
	return out
}

func application(name, project, sync, health string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Application",
		"metadata":   map[string]any{"name": name, "namespace": "argocd"},
		"spec":       map[string]any{"project": project},
		"status": map[string]any{
			"sync":    map[string]any{"status": sync},
			"health":  map[string]any{"status": health},
			"summary": map[string]any{"images": []any{"registry.example.com/" + project + "/payment-api:v1"}},
		},
	}}
}

func TestReaderGet(t *testing.T) {
	reader := newFakeReader(t, application("stg-payment-api", "stg", "Synced", "Healthy"))

	snap, err := reader.Get(context.Background(), "stg-payment-api")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if snap == nil {
		t.Fatal("Get() = nil snapshot for an existing application")
	}
	if snap.Identity != "payment-api" || !snap.IsSynced() {
		t.Errorf("snapshot = %+v", snap)
	}
}

func TestReaderGetNotFoundIsNotAnError(t *testing.T) {
	// The gate reads a nil snapshot with a nil error as "nothing upstream",
	// which is the documented allow case. A NotFound must not surface as an
	// error, or every app without an upstream would hit the onError policy.
	reader := newFakeReader(t)
	snap, err := reader.Get(context.Background(), "stg-missing")
	if err != nil {
		t.Fatalf("Get() on a missing application error = %v, want nil", err)
	}
	if snap != nil {
		t.Errorf("Get() = %+v, want nil", snap)
	}
}
