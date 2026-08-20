// Package argocd reads the two kinds of state a verdict needs: the live
// Application status, which the Kubernetes API already holds, and the images a
// pending sync would deploy, which only Argo CD knows.
package argocd

import (
	"context"
	"fmt"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/gate"
)

// ApplicationGVR is the Argo CD Application resource.
var ApplicationGVR = schema.GroupVersionResource{
	Group:    "argoproj.io",
	Version:  "v1alpha1",
	Resource: "applications",
}

// Reader reads Application resources straight from the Kubernetes API.
//
// Everything the upstream check needs (status.sync, status.health,
// status.summary.images) is live state the application controller already
// writes back to the CR, so no Argo CD API call is involved and no API token
// is required.
type Reader struct {
	client         dynamic.ResourceInterface
	skipAnnotation string
}

// NewReader scopes a reader to the namespace holding the Applications.
func NewReader(client dynamic.Interface, namespace, skipAnnotation string) *Reader {
	return &Reader{
		client:         client.Resource(ApplicationGVR).Namespace(namespace),
		skipAnnotation: skipAnnotation,
	}
}

// Get fetches one Application. It returns a nil snapshot and nil error when
// the Application does not exist, which the gate reads as "nothing upstream".
func (r *Reader) Get(ctx context.Context, name string) (*gate.AppSnapshot, error) {
	obj, err := r.client.Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("get application %s: %w", name, err)
	}
	snapshot, err := SnapshotFromMap(obj.Object, r.skipAnnotation)
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// List returns every Application in the namespace the reader is scoped to.
//
// Used at startup to report what the exemptions currently cover. A gate whose
// escape hatch is invisible tends to end up with the hatch permanently open.
func (r *Reader) List(ctx context.Context) ([]gate.AppSnapshot, error) {
	list, err := r.client.List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list applications: %w", err)
	}
	out := make([]gate.AppSnapshot, 0, len(list.Items))
	for i := range list.Items {
		snapshot, err := SnapshotFromMap(list.Items[i].Object, r.skipAnnotation)
		if err != nil {
			// One malformed Application must not hide the rest.
			continue
		}
		out = append(out, snapshot)
	}
	return out, nil
}

// SnapshotFromMap reduces an Application document to the fields the gate
// reasons about.
//
// The same shape arrives from two places, the Kubernetes API and
// AdmissionReview.request.object, so both share this parser and can never
// disagree about what an Application says.
func SnapshotFromMap(obj map[string]any, skipAnnotation string) (gate.AppSnapshot, error) {
	name := nestedString(obj, "metadata", "name")
	if name == "" {
		return gate.AppSnapshot{}, fmt.Errorf("application has no metadata.name")
	}

	project := nestedString(obj, "spec", "project")
	if project == "" {
		project = "default"
	}

	snapshot := gate.AppSnapshot{
		Name:              name,
		Project:           project,
		Identity:          gate.IdentityOf(name, project),
		SyncStatus:        nestedString(obj, "status", "sync", "status"),
		HealthStatus:      nestedString(obj, "status", "health", "status"),
		LiveImages:        parseImageList(nestedSlice(obj, "status", "summary", "images")),
		SkipRequested:     skipRequested(obj, skipAnnotation),
		PendingRevision:   nestedString(obj, "operation", "sync", "revision"),
		CurrentRevision:   nestedString(obj, "status", "sync", "revision"),
		DeployedRevisions: deployedRevisions(obj),
	}
	return snapshot, nil
}

// deployedRevisions reads status.history, which Argo CD keeps on the resource
// itself. Because the Application CRD has no status subresource, an
// AdmissionReview carries this too, so a rollback is recognisable from the
// admission request alone with no extra API call.
func deployedRevisions(obj map[string]any) []string {
	history := nestedSlice(obj, "status", "history")
	if len(history) == 0 {
		return nil
	}
	out := make([]string, 0, len(history))
	for _, entry := range history {
		record, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if revision, ok := record["revision"].(string); ok && revision != "" {
			out = append(out, revision)
		}
		// A multi-source application records one revision per source.
		revisions, ok := record["revisions"].([]any)
		if !ok {
			continue
		}
		for _, raw := range revisions {
			if revision, ok := raw.(string); ok && revision != "" {
				out = append(out, revision)
			}
		}
	}
	return out
}

func skipRequested(obj map[string]any, annotation string) bool {
	annotations, ok := nestedMap(obj, "metadata", "annotations")
	if !ok {
		return false
	}
	value, ok := annotations[annotation].(string)
	if !ok {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(value), "true")
}

func parseImageList(raw []any) []gate.ImageRef {
	if len(raw) == 0 {
		return nil
	}
	out := make([]gate.ImageRef, 0, len(raw))
	for _, entry := range raw {
		image, ok := entry.(string)
		if !ok || strings.TrimSpace(image) == "" {
			continue
		}
		out = append(out, gate.ParseImage(image))
	}
	return out
}

// nestedString walks a decoded document and returns the string at path, or "".
func nestedString(obj map[string]any, path ...string) string {
	value, ok := nestedValue(obj, path...)
	if !ok {
		return ""
	}
	str, _ := value.(string)
	return str
}

func nestedSlice(obj map[string]any, path ...string) []any {
	value, ok := nestedValue(obj, path...)
	if !ok {
		return nil
	}
	slice, _ := value.([]any)
	return slice
}

func nestedMap(obj map[string]any, path ...string) (map[string]any, bool) {
	value, ok := nestedValue(obj, path...)
	if !ok {
		return nil, false
	}
	nested, ok := value.(map[string]any)
	return nested, ok
}

func nestedValue(obj map[string]any, path ...string) (any, bool) {
	current := any(obj)
	for _, key := range path {
		asMap, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = asMap[key]
		if !ok {
			return nil, false
		}
	}
	return current, true
}
