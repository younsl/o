package extension

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
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

func application(name, project, sync, health string) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Application",
		"metadata":   map[string]any{"name": name, "namespace": "argocd"},
		"spec":       map[string]any{"project": project},
		"status": map[string]any{
			"sync":   map[string]any{"status": sync},
			"health": map[string]any{"status": health},
		},
	}}
}

func newHandler(t *testing.T, objects ...*unstructured.Unstructured) *Handler {
	t.Helper()
	cfg := config.Default()
	cfg.Chain = []string{"dev", "sb", "stg", "prd"}
	cfg.GatedEnvs = []string{"prd"}
	cfg.ImageTag.Enabled = false

	runtimeObjects := make([]runtime.Object, 0, len(objects))
	for _, obj := range objects {
		runtimeObjects = append(runtimeObjects, obj)
	}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		runtime.NewScheme(),
		map[schema.GroupVersionResource]string{argocd.ApplicationGVR: "ApplicationList"},
		runtimeObjects...,
	)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	reader := argocd.NewReader(client, cfg.ArgoCD.Namespace, cfg.Exempt.Annotation)
	eng := engine.New(cfg, reader, nil, observability.NewMetrics(), logger)
	return NewHandler(eng, logger)
}

func TestAppNameFrom(t *testing.T) {
	cases := []struct {
		name   string
		header string
		query  string
		want   string
		ok     bool
	}{
		{name: "proxy header with namespace", header: "argocd:prd-payment-api", want: "prd-payment-api", ok: true},
		{name: "header without namespace", header: "prd-payment-api", want: "prd-payment-api", ok: true},
		{name: "header wins over query", header: "argocd:prd-payment-api", query: "prd-other", want: "prd-payment-api", ok: true},
		{name: "query fallback for local debugging", query: "prd-payment-api", want: "prd-payment-api", ok: true},
		{name: "no input", ok: false},
		{name: "empty query", query: "%20%20", ok: false},
		{name: "header with empty name falls through", header: "argocd:", ok: false},
		{name: "header with empty name uses the query", header: "argocd:", query: "prd-payment-api", want: "prd-payment-api", ok: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			target := "/api/v1/gate"
			if tc.query != "" {
				target += "?app=" + tc.query
			}
			req := httptest.NewRequest(http.MethodGet, target, nil)
			if tc.header != "" {
				req.Header.Set(appHeader, tc.header)
			}
			got, ok := AppNameFrom(req)
			if ok != tc.ok || got != tc.want {
				t.Errorf("AppNameFrom() = (%q, %v), want (%q, %v)", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func doGate(t *testing.T, h *Handler, target, header string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	if header != "" {
		req.Header.Set(appHeader, header)
	}
	rec := httptest.NewRecorder()
	h.Gate(rec, req)

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v, body = %s", err, rec.Body.String())
	}
	return rec.Code, payload
}

func TestGateReturnsTheSameVerdictTheWebhookWould(t *testing.T) {
	h := newHandler(t,
		application("prd-payment-api", "prd", "OutOfSync", "Healthy"),
		application("stg-payment-api", "stg", "OutOfSync", "Healthy"),
	)

	status, payload := doGate(t, h, "/api/v1/gate", "argocd:prd-payment-api")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if payload["allowed"] != false {
		t.Errorf("allowed = %v, want false while stg is OutOfSync", payload["allowed"])
	}
	if payload["code"] != string(gate.CodeUpstreamOutOfSync) {
		t.Errorf("code = %v, want %q", payload["code"], gate.CodeUpstreamOutOfSync)
	}
	upstream, _ := payload["upstream"].(map[string]any)
	if upstream["app"] != "stg-payment-api" || upstream["exists"] != true {
		t.Errorf("upstream = %v, want the existing stg app", upstream)
	}
}

func TestGatePassesForAPromotedUpstream(t *testing.T) {
	h := newHandler(t,
		application("prd-payment-api", "prd", "OutOfSync", "Healthy"),
		application("stg-payment-api", "stg", "Synced", "Healthy"),
	)
	status, payload := doGate(t, h, "/api/v1/gate", "argocd:prd-payment-api")
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if payload["allowed"] != true {
		t.Errorf("allowed = %v, want true", payload["allowed"])
	}
}

func TestGateErrors(t *testing.T) {
	h := newHandler(t)

	if status, payload := doGate(t, h, "/api/v1/gate", ""); status != http.StatusBadRequest {
		t.Errorf("status without an app = %d (%v), want 400", status, payload)
	}
	if status, _ := doGate(t, h, "/api/v1/gate?app=prd-missing", ""); status != http.StatusNotFound {
		t.Errorf("status for a missing app = %d, want 404", status)
	}
}

func TestConfigEndpointPublishesTheChain(t *testing.T) {
	h := newHandler(t)
	rec := httptest.NewRecorder()
	h.Config(rec, httptest.NewRequest(http.MethodGet, "/api/v1/config", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	chain, _ := payload["chain"].([]any)
	if len(chain) != 4 {
		t.Errorf("chain = %v, want four environments", chain)
	}
	// The extension labels the upstream from this payload rather than
	// hardcoding the promotion order.
	if payload["imageTagMode"] != string(config.ImageTagModeWarn) {
		t.Errorf("imageTagMode = %v, want warn", payload["imageTagMode"])
	}
	if payload["skipAnnotation"] == "" {
		t.Error("skipAnnotation is empty, so the UI cannot tell users how to opt out")
	}
}
