package admission

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/argocd"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/config"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/engine"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/gate"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/observability"
)

type stubResolver struct {
	images []gate.ImageRef
	err    error
}

func (s stubResolver) DesiredImages(context.Context, string) ([]gate.ImageRef, error) {
	return s.images, s.err
}

func application(name, project, sync, health, image string) *unstructured.Unstructured {
	obj := map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Application",
		"metadata":   map[string]any{"name": name, "namespace": "argocd"},
		"spec":       map[string]any{"project": project},
		"status": map[string]any{
			"sync":   map[string]any{"status": sync},
			"health": map[string]any{"status": health},
		},
	}
	if image != "" {
		status, _ := obj["status"].(map[string]any)
		status["summary"] = map[string]any{"images": []any{image}}
	}
	return &unstructured.Unstructured{Object: obj}
}

// newHandlerWithLog is newHandler plus the log output, for the tests that care
// what the gate wrote down.
func newHandlerWithLog(t *testing.T, cfg config.Config, resolver engine.ImageResolver, objects ...*unstructured.Unstructured) (*Handler, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	h := newHandlerLogging(t, cfg, resolver, slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})), objects...)
	return h, &buf
}

func newHandler(t *testing.T, cfg config.Config, resolver engine.ImageResolver, objects ...*unstructured.Unstructured) *Handler {
	t.Helper()
	return newHandlerLogging(t, cfg, resolver, slog.New(slog.NewTextHandler(io.Discard, nil)), objects...)
}

func newHandlerLogging(t *testing.T, cfg config.Config, resolver engine.ImageResolver, logger *slog.Logger, objects ...*unstructured.Unstructured) *Handler {
	t.Helper()
	runtimeObjects := make([]runtime.Object, 0, len(objects))
	for _, obj := range objects {
		runtimeObjects = append(runtimeObjects, obj)
	}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		runtime.NewScheme(),
		map[schema.GroupVersionResource]string{argocd.ApplicationGVR: "ApplicationList"},
		runtimeObjects...,
	)
	metrics := observability.NewMetrics()
	reader := argocd.NewReader(client, cfg.ArgoCD.Namespace, cfg.Exempt.Annotation)
	eng := engine.New(cfg, reader, resolver, metrics, logger)
	return NewHandler(eng, metrics, logger)
}

func gatedConfig() config.Config {
	cfg := config.Default()
	cfg.Chain = []string{"dev", "sb", "stg", "prd"}
	cfg.GatedEnvs = []string{"prd"}
	cfg.ImageTag.Enabled = false
	return cfg
}

func syncReview(app map[string]any, username string) []byte {
	review := map[string]any{
		"apiVersion": "admission.k8s.io/v1",
		"kind":       "AdmissionReview",
		"request": map[string]any{
			"uid":       "uid-1",
			"name":      app["metadata"].(map[string]any)["name"],
			"namespace": "argocd",
			"operation": "UPDATE",
			"userInfo":  map[string]any{"username": username},
			"object":    app,
			"oldObject": map[string]any{"spec": app["spec"]},
		},
	}
	raw, _ := json.Marshal(review)
	return raw
}

func syncingApp(name, project string) map[string]any {
	return map[string]any{
		"metadata": map[string]any{"name": name, "namespace": "argocd"},
		"spec":     map[string]any{"project": project},
		"operation": map[string]any{
			"sync":        map[string]any{"revision": "HEAD"},
			"initiatedBy": map[string]any{"username": "dev@example.com"},
		},
	}
}

func post(t *testing.T, h *Handler, body []byte) Response {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/validate", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (admission errors travel in the body)", rec.Code)
	}
	var response ReviewResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("Unmarshal() error = %v, body = %s", err, rec.Body.String())
	}
	return response.Response
}

func TestHandlerDeniesWhenUpstreamIsOutOfSync(t *testing.T) {
	h := newHandler(t, gatedConfig(), nil,
		application("stg-payment-api", "stg", "OutOfSync", "Healthy", ""))

	got := post(t, h, syncReview(syncingApp("prd-payment-api", "prd"), "system:serviceaccount:argocd:argocd-server"))
	if got.Allowed {
		t.Fatal("the sync was allowed while stg was OutOfSync")
	}
	if got.Status == nil || got.Status.Code != 403 {
		t.Fatalf("status = %+v, want a 403", got.Status)
	}
	if !bytes.Contains([]byte(got.Status.Message), []byte("stg-payment-api")) {
		t.Errorf("message %q does not name the upstream app the user has to fix", got.Status.Message)
	}
}

func TestHandlerAllowsWhenUpstreamIsPromoted(t *testing.T) {
	h := newHandler(t, gatedConfig(), nil,
		application("stg-payment-api", "stg", "Synced", "Healthy", ""))

	got := post(t, h, syncReview(syncingApp("prd-payment-api", "prd"), "system:serviceaccount:argocd:argocd-server"))
	if !got.Allowed {
		t.Fatalf("the sync was denied with a promoted upstream: %+v", got.Status)
	}
}

func TestHandlerAllowsWhenUpstreamDoesNotExist(t *testing.T) {
	// The required exception: an app with no upstream counterpart is not
	// promotable and must not be blocked.
	h := newHandler(t, gatedConfig(), nil)

	got := post(t, h, syncReview(syncingApp("prd-standalone", "prd"), "system:serviceaccount:argocd:argocd-server"))
	if !got.Allowed {
		t.Fatalf("a sync with no upstream app was denied: %+v", got.Status)
	}
}

func TestHandlerIgnoresNonSyncWrites(t *testing.T) {
	h := newHandler(t, gatedConfig(), nil,
		application("stg-payment-api", "stg", "OutOfSync", "Degraded", ""))

	// A status write from the controller: no operation field on either side.
	app := map[string]any{
		"metadata": map[string]any{"name": "prd-payment-api", "namespace": "argocd"},
		"spec":     map[string]any{"project": "prd"},
		"status":   map[string]any{"sync": map[string]any{"status": "OutOfSync"}},
	}
	got := post(t, h, syncReview(app, "system:serviceaccount:argocd:argocd-application-controller"))
	if !got.Allowed {
		t.Fatalf("a non-sync write was denied: %+v", got.Status)
	}
}

func TestHandlerExemptsTheApplicationController(t *testing.T) {
	// Denying the controller would only produce a retry loop, so an auto-sync
	// is left alone.
	h := newHandler(t, gatedConfig(), nil,
		application("stg-payment-api", "stg", "OutOfSync", "Degraded", ""))

	got := post(t, h, syncReview(syncingApp("prd-payment-api", "prd"),
		"system:serviceaccount:argocd:argocd-application-controller"))
	if !got.Allowed {
		t.Fatalf("the application controller was blocked: %+v", got.Status)
	}
}

func TestHandlerExemptsAutomatedOperations(t *testing.T) {
	h := newHandler(t, gatedConfig(), nil,
		application("stg-payment-api", "stg", "OutOfSync", "Degraded", ""))

	app := syncingApp("prd-payment-api", "prd")
	app["operation"] = map[string]any{
		"sync":        map[string]any{},
		"initiatedBy": map[string]any{"automated": true},
	}
	got := post(t, h, syncReview(app, "system:serviceaccount:argocd:someone-else"))
	if !got.Allowed {
		t.Fatalf("an automated operation was blocked: %+v", got.Status)
	}
}

func TestHandlerHonoursTheSkipAnnotation(t *testing.T) {
	cfg := gatedConfig()
	h := newHandler(t, cfg, nil,
		application("stg-payment-api", "stg", "OutOfSync", "Degraded", ""))

	app := syncingApp("prd-payment-api", "prd")
	app["metadata"].(map[string]any)["annotations"] = map[string]any{cfg.Exempt.Annotation: "true"}
	got := post(t, h, syncReview(app, "system:serviceaccount:argocd:argocd-server"))
	if !got.Allowed {
		t.Fatalf("the skip annotation did not exempt the app: %+v", got.Status)
	}
}

func TestHandlerIgnoresUngatedEnvironments(t *testing.T) {
	h := newHandler(t, gatedConfig(), nil)

	got := post(t, h, syncReview(syncingApp("dev-payment-api", "dev"), "system:serviceaccount:argocd:argocd-server"))
	if !got.Allowed {
		t.Fatalf("a dev sync was denied: %+v", got.Status)
	}
}

func TestHandlerDeniesOnImageTagMismatch(t *testing.T) {
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.Mode = config.ImageTagModeEnforce

	resolver := stubResolver{images: []gate.ImageRef{
		gate.ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new"),
	}}
	h := newHandler(t, cfg, resolver,
		application("stg-payment-api", "stg", "Synced", "Healthy",
			"210987654321.dkr.ecr.example/payment-api:tag-old"))

	got := post(t, h, syncReview(syncingApp("prd-payment-api", "prd"), "system:serviceaccount:argocd:argocd-server"))
	if got.Allowed {
		t.Fatal("a tag mismatch was allowed in enforce mode")
	}
	if !bytes.Contains([]byte(got.Status.Message), []byte("tag-old")) {
		t.Errorf("message %q does not report the tag stg is running", got.Status.Message)
	}
}

func TestHandlerWarnsOnImageTagMismatchInWarnMode(t *testing.T) {
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.Mode = config.ImageTagModeWarn

	resolver := stubResolver{images: []gate.ImageRef{
		gate.ParseImage("123456789012.dkr.ecr.example/payment-api:tag-new"),
	}}
	h := newHandler(t, cfg, resolver,
		application("stg-payment-api", "stg", "Synced", "Healthy",
			"210987654321.dkr.ecr.example/payment-api:tag-old"))

	got := post(t, h, syncReview(syncingApp("prd-payment-api", "prd"), "system:serviceaccount:argocd:argocd-server"))
	if !got.Allowed {
		t.Fatalf("warn mode denied the sync: %+v", got.Status)
	}
	if len(got.Warnings) != 1 {
		t.Errorf("warnings = %v, want one so the mismatch is still visible", got.Warnings)
	}
}

func TestHandlerAppliesOnErrorPolicyWhenImageLookupFails(t *testing.T) {
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.Mode = config.ImageTagModeEnforce
	cfg.ImageTag.OnError = config.OnErrorDeny

	resolver := stubResolver{err: errors.New("argocd api returned 503")}
	h := newHandler(t, cfg, resolver,
		application("stg-payment-api", "stg", "Synced", "Healthy",
			"210987654321.dkr.ecr.example/payment-api:tag-old"))

	got := post(t, h, syncReview(syncingApp("prd-payment-api", "prd"), "system:serviceaccount:argocd:argocd-server"))
	if got.Allowed {
		t.Fatal("a failed image lookup was allowed under onError: deny")
	}
}

// The scenario this matters for: both environments ran 0.2.0, prd turned out
// broken, and prd has to go back to 0.1.0 while beta still runs 0.2.0.
func TestHandlerAllowsRollbackToAPreviouslyDeployedRevision(t *testing.T) {
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.Mode = config.ImageTagModeEnforce

	resolver := stubResolver{images: []gate.ImageRef{
		gate.ParseImage("123456789012.dkr.ecr.example/payment-api:0.1.0"),
	}}
	h := newHandler(t, cfg, resolver,
		application("stg-payment-api", "stg", "Synced", "Healthy",
			"210987654321.dkr.ecr.example/payment-api:0.2.0"))

	app := syncingApp("prd-payment-api", "prd")
	app["operation"] = map[string]any{
		"sync":        map[string]any{"revision": "abc1234"},
		"initiatedBy": map[string]any{"username": "dev@example.com"},
	}
	app["status"] = map[string]any{
		"sync": map[string]any{"revision": "def5678"},
		"history": []any{
			map[string]any{"id": 0, "revision": "abc1234"},
			map[string]any{"id": 1, "revision": "def5678"},
		},
	}

	got := post(t, h, syncReview(app, "system:serviceaccount:argocd:argocd-server"))
	if !got.Allowed {
		t.Fatalf("the rollback was denied: %+v", got.Status)
	}
}

func TestHandlerStillDeniesAForwardSyncWithNewRevision(t *testing.T) {
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.Mode = config.ImageTagModeEnforce

	resolver := stubResolver{images: []gate.ImageRef{
		gate.ParseImage("123456789012.dkr.ecr.example/payment-api:0.3.0"),
	}}
	h := newHandler(t, cfg, resolver,
		application("stg-payment-api", "stg", "Synced", "Healthy",
			"210987654321.dkr.ecr.example/payment-api:0.2.0"))

	app := syncingApp("prd-payment-api", "prd")
	app["operation"] = map[string]any{
		"sync": map[string]any{"revision": "newsha1"},
	}
	app["status"] = map[string]any{
		"history": []any{map[string]any{"id": 0, "revision": "abc1234"}},
	}

	got := post(t, h, syncReview(app, "system:serviceaccount:argocd:argocd-server"))
	if got.Allowed {
		t.Fatal("a forward sync to an undeployed revision was allowed")
	}
}

func TestHandlerFailsOpenOnMalformedInput(t *testing.T) {
	h := newHandler(t, gatedConfig(), nil)

	// The gate cannot judge what it cannot read, and refusing everything would
	// take all syncs down with it.
	if got := post(t, h, []byte("not json")); !got.Allowed {
		t.Error("a malformed body was denied")
	}
	if got := post(t, h, []byte(`{"apiVersion":"admission.k8s.io/v1"}`)); !got.Allowed {
		t.Error("a review without a request was denied")
	}
	if got := post(t, h, []byte(`{"request":{"uid":"u","object":{"operation":{}}}}`)); !got.Allowed {
		t.Error("an object without metadata.name was denied")
	}
}

func TestHandlerRejectsNonPost(t *testing.T) {
	h := newHandler(t, gatedConfig(), nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/validate", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", rec.Code)
	}
}

func TestHandlerPreservesTheRequestUID(t *testing.T) {
	// The API server matches the response to the request by UID; dropping it
	// makes every verdict useless.
	h := newHandler(t, gatedConfig(), nil,
		application("stg-payment-api", "stg", "Synced", "Healthy", ""))
	got := post(t, h, syncReview(syncingApp("prd-payment-api", "prd"), "system:serviceaccount:argocd:argocd-server"))
	if got.UID != "uid-1" {
		t.Errorf("UID = %q, want uid-1", got.UID)
	}
}

// Every request has to leave one line naming the target and the reason. A gate
// that refuses a deploy without saying which one and why is unusable during an
// incident, and so is one that quietly allows.
func TestHandlerLogsEveryVerdictWithTargetAndReason(t *testing.T) {
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.Mode = config.ImageTagModeEnforce

	resolver := stubResolver{images: []gate.ImageRef{
		gate.ParseImage("123456789012.dkr.ecr.example/payment-api:0.2.0"),
	}}

	t.Run("denied", func(t *testing.T) {
		h, logs := newHandlerWithLog(t, cfg, resolver,
			application("stg-payment-api", "stg", "Synced", "Healthy",
				"210987654321.dkr.ecr.example/payment-api:0.1.0"))
		if got := post(t, h, syncReview(syncingApp("prd-payment-api", "prd"), "system:serviceaccount:argocd:argocd-server")); got.Allowed {
			t.Fatal("expected a denial to log")
		}
		line := logs.String()
		for _, want := range []string{
			"level=WARN",
			"outcome=denied",
			"reason=ImageTagMismatch",
			"app=prd-payment-api",
			"upstream=stg-payment-api",
			"upstreamSync=Synced",
			"code=ImageTagMismatch",
			"allowed=false",
			"initiatedBy=dev@example.com",
			"payment-api 0.2.0!=0.1.0",
		} {
			if !strings.Contains(line, want) {
				t.Errorf("log is missing %q\n%s", want, line)
			}
		}
	})

	t.Run("allowed", func(t *testing.T) {
		h, logs := newHandlerWithLog(t, cfg, resolver,
			application("stg-payment-api", "stg", "Synced", "Healthy",
				"210987654321.dkr.ecr.example/payment-api:0.2.0"))
		if got := post(t, h, syncReview(syncingApp("prd-payment-api", "prd"), "system:serviceaccount:argocd:argocd-server")); !got.Allowed {
			t.Fatal("expected an allow to log")
		}
		line := logs.String()
		for _, want := range []string{"level=INFO", "outcome=allowed", "reason=Passed", "app=prd-payment-api", "allowed=true"} {
			if !strings.Contains(line, want) {
				t.Errorf("log is missing %q\n%s", want, line)
			}
		}
	})

	t.Run("skipped paths still name a reason", func(t *testing.T) {
		cases := map[string]struct {
			app    map[string]any
			user   string
			reason string
		}{
			"exempt principal": {
				app:    syncingApp("prd-payment-api", "prd"),
				user:   "system:serviceaccount:argocd:argocd-application-controller",
				reason: "reason=\"principal is exempt\"",
			},
			"not gated": {
				app:    syncingApp("dev-payment-api", "dev"),
				user:   "system:serviceaccount:argocd:argocd-server",
				reason: "reason=\"environment is not gated\"",
			},
		}
		for name, tc := range cases {
			t.Run(name, func(t *testing.T) {
				h, logs := newHandlerWithLog(t, cfg, resolver)
				post(t, h, syncReview(tc.app, tc.user))
				line := logs.String()
				if !strings.Contains(line, "outcome=skipped") || !strings.Contains(line, tc.reason) {
					t.Errorf("log is missing the skip reason\n%s", line)
				}
				if !strings.Contains(line, "app=") {
					t.Errorf("log does not name the target\n%s", line)
				}
			})
		}
	})

	t.Run("rollback names the revision", func(t *testing.T) {
		h, logs := newHandlerWithLog(t, cfg, resolver,
			application("stg-payment-api", "stg", "OutOfSync", "Degraded", ""))
		app := syncingApp("prd-payment-api", "prd")
		app["operation"] = map[string]any{"sync": map[string]any{"revision": "abc1234"}}
		app["status"] = map[string]any{
			"sync":    map[string]any{"revision": "def5678"},
			"history": []any{map[string]any{"id": 0, "revision": "abc1234"}},
		}
		if got := post(t, h, syncReview(app, "system:serviceaccount:argocd:argocd-server")); !got.Allowed {
			t.Fatalf("the rollback was denied: %+v", got.Status)
		}
		line := logs.String()
		for _, want := range []string{"outcome=allowed", "reason=Rollback", "revision=abc1234"} {
			if !strings.Contains(line, want) {
				t.Errorf("log is missing %q\n%s", want, line)
			}
		}
	})
}
