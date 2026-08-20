package engine

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/argocd"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/config"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/gate"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/observability"
)

type countingResolver struct {
	calls  atomic.Int32
	images []gate.ImageRef
	err    error
}

func (c *countingResolver) DesiredImages(context.Context, string) ([]gate.ImageRef, error) {
	c.calls.Add(1)
	return c.images, c.err
}

func application(name, project, sync, health, image string) *unstructured.Unstructured {
	status := map[string]any{
		"sync":   map[string]any{"status": sync},
		"health": map[string]any{"status": health},
	}
	if image != "" {
		status["summary"] = map[string]any{"images": []any{image}}
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "argoproj.io/v1alpha1",
		"kind":       "Application",
		"metadata":   map[string]any{"name": name, "namespace": "argocd"},
		"spec":       map[string]any{"project": project},
		"status":     status,
	}}
}

func fakeClient(objects ...*unstructured.Unstructured) *dynamicfake.FakeDynamicClient {
	runtimeObjects := make([]runtime.Object, 0, len(objects))
	for _, obj := range objects {
		runtimeObjects = append(runtimeObjects, obj)
	}
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(
		runtime.NewScheme(),
		map[schema.GroupVersionResource]string{argocd.ApplicationGVR: "ApplicationList"},
		runtimeObjects...,
	)
}

func gatedConfig() config.Config {
	cfg := config.Default()
	cfg.Chain = []string{"dev", "sb", "stg", "prd"}
	cfg.GatedEnvs = []string{"prd"}
	cfg.ImageTag.Enabled = false
	return cfg
}

func newEngine(cfg config.Config, resolver ImageResolver, client *dynamicfake.FakeDynamicClient) *Engine {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	reader := argocd.NewReader(client, cfg.ArgoCD.Namespace, cfg.Exempt.Annotation)
	return New(cfg, reader, resolver, observability.NewMetrics(), logger)
}

func snapshot(name, project string) gate.AppSnapshot {
	return gate.AppSnapshot{
		Name:     name,
		Project:  project,
		Identity: gate.IdentityOf(name, project),
	}
}

func TestEvaluateUngatedEnvSkipsEveryLookup(t *testing.T) {
	resolver := &countingResolver{}
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	eng := newEngine(cfg, resolver, fakeClient())

	verdict := eng.Evaluate(context.Background(), snapshot("dev-payment-api", "dev"))
	if !verdict.Allowed || verdict.Code != gate.CodeNotGated {
		t.Errorf("verdict = %+v, want an ungated allow", verdict)
	}
	if got := resolver.calls.Load(); got != 0 {
		t.Errorf("image lookups = %d, want 0 for an ungated env", got)
	}
}

func TestEvaluateAttachesUpstreamSummary(t *testing.T) {
	eng := newEngine(gatedConfig(), nil, fakeClient(
		application("stg-payment-api", "stg", "Synced", "Healthy", ""),
	))

	verdict := eng.Evaluate(context.Background(), snapshot("prd-payment-api", "prd"))
	if verdict.Upstream == nil {
		t.Fatal("Upstream = nil, want a summary for the UI")
	}
	if verdict.Upstream.App != "stg-payment-api" || !verdict.Upstream.Exists {
		t.Errorf("Upstream = %+v", verdict.Upstream)
	}
}

func TestEvaluateSkipsImageLookupWhenUpstreamAlreadyFails(t *testing.T) {
	// The image lookup is the only remote call. Spending it on a verdict that
	// is already a denial would add latency to the admission path for nothing.
	resolver := &countingResolver{}
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	eng := newEngine(cfg, resolver, fakeClient(
		application("stg-payment-api", "stg", "OutOfSync", "Healthy", ""),
	))

	verdict := eng.Evaluate(context.Background(), snapshot("prd-payment-api", "prd"))
	if verdict.Allowed {
		t.Error("an OutOfSync upstream was allowed")
	}
	if got := resolver.calls.Load(); got != 0 {
		t.Errorf("image lookups = %d, want 0 when the upstream already fails", got)
	}
}

func TestEvaluateSkipsImageLookupForAnExemptApp(t *testing.T) {
	resolver := &countingResolver{}
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	eng := newEngine(cfg, resolver, fakeClient(
		application("stg-payment-api", "stg", "Synced", "Healthy", ""),
	))

	app := snapshot("prd-payment-api", "prd")
	app.SkipRequested = true
	if verdict := eng.Evaluate(context.Background(), app); verdict.Code != gate.CodeExempt {
		t.Errorf("Code = %q, want Exempt", verdict.Code)
	}
	if got := resolver.calls.Load(); got != 0 {
		t.Errorf("image lookups = %d, want 0 for an exempt app", got)
	}
}

func TestEvaluateRunsImageLookupWhenUpstreamIsPromoted(t *testing.T) {
	resolver := &countingResolver{images: []gate.ImageRef{
		gate.ParseImage("123456789012.dkr.ecr.example/payment-api:tag-abc"),
	}}
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.Mode = config.ImageTagModeEnforce
	eng := newEngine(cfg, resolver, fakeClient(
		application("stg-payment-api", "stg", "Synced", "Healthy",
			"210987654321.dkr.ecr.example/payment-api:tag-abc"),
	))

	verdict := eng.Evaluate(context.Background(), snapshot("prd-payment-api", "prd"))
	if !verdict.Allowed || verdict.Code != gate.CodePassed {
		t.Errorf("verdict = %+v, want a pass", verdict)
	}
	if got := resolver.calls.Load(); got != 1 {
		t.Errorf("image lookups = %d, want 1", got)
	}
}

func TestEvaluateWithoutAResolverReportsLookupFailure(t *testing.T) {
	// imageTag.enabled with no resolver wired must not silently pass; the
	// onError policy decides instead.
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.OnError = config.OnErrorDeny
	eng := newEngine(cfg, nil, fakeClient(
		application("stg-payment-api", "stg", "Synced", "Healthy", "b.example/payment-api:v1"),
	))

	verdict := eng.Evaluate(context.Background(), snapshot("prd-payment-api", "prd"))
	if verdict.Allowed {
		t.Errorf("verdict = %+v, want a denial", verdict)
	}
	if verdict.Code != gate.CodeLookupFailed {
		t.Errorf("Code = %q, want LookupFailed", verdict.Code)
	}
}

func TestEvaluatePropagatesResolverError(t *testing.T) {
	resolver := &countingResolver{err: errors.New("argocd api returned 503")}
	cfg := gatedConfig()
	cfg.ImageTag.Enabled = true
	cfg.ImageTag.OnError = config.OnErrorAllow
	eng := newEngine(cfg, resolver, fakeClient(
		application("stg-payment-api", "stg", "Synced", "Healthy", "b.example/payment-api:v1"),
	))

	verdict := eng.Evaluate(context.Background(), snapshot("prd-payment-api", "prd"))
	if !verdict.Allowed {
		t.Error("onError: allow denied a failed lookup")
	}
	if verdict.Code != gate.CodeLookupFailed {
		t.Errorf("Code = %q, want LookupFailed", verdict.Code)
	}
}

func TestEvaluateKubernetesFailureIsNotAMissingUpstream(t *testing.T) {
	// Allowing an absent upstream must not turn an API outage into an open gate.
	// The two look identical from the outside and are not the same thing.
	client := fakeClient()
	client.PrependReactor("get", "applications", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("etcdserver: request timed out")
	})

	cfg := gatedConfig()
	cfg.ImageTag.OnError = config.OnErrorDeny
	eng := newEngine(cfg, nil, client)

	verdict := eng.Evaluate(context.Background(), snapshot("prd-payment-api", "prd"))
	if verdict.Allowed {
		t.Error("a Kubernetes read failure opened the gate")
	}
	if verdict.Code != gate.CodeLookupFailed {
		t.Errorf("Code = %q, want LookupFailed", verdict.Code)
	}
	if verdict.Upstream == nil || verdict.Upstream.Exists {
		t.Errorf("Upstream = %+v, want a non-existing summary", verdict.Upstream)
	}
}

func TestConfigAndReaderAreExposed(t *testing.T) {
	cfg := gatedConfig()
	eng := newEngine(cfg, nil, fakeClient())
	if got := eng.Config(); len(got.Chain) != len(cfg.Chain) {
		t.Errorf("Config() = %+v", got)
	}
	if eng.Reader() == nil {
		t.Error("Reader() = nil")
	}
}
