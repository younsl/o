package argocd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/config"
)

func targetState(t *testing.T, manifest map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	return string(raw)
}

func deployment(image string) map[string]any {
	return map[string]any{
		"kind": "Deployment",
		"spec": map[string]any{"template": map[string]any{"spec": map[string]any{
			"containers": []any{map[string]any{"image": image}},
		}}},
	}
}

func TestImagesFromManagedResources(t *testing.T) {
	items := []ManagedResourceItem{
		{TargetState: targetState(t, deployment("123456789012.dkr.ecr.example/payment-api:tag-new"))},
		{TargetState: ""},
		{TargetState: "   "},
		{TargetState: "not json"},
	}
	images := ImagesFromManagedResources(items)
	if len(images) != 1 {
		t.Fatalf("ImagesFromManagedResources() = %+v, want one image", images)
	}
	if images[0].Basename != "payment-api" || images[0].Tag != "tag-new" {
		t.Errorf("image = %+v", images[0])
	}
}

func TestImagesFromManagedResourcesEmpty(t *testing.T) {
	if got := ImagesFromManagedResources(nil); len(got) != 0 {
		t.Errorf("ImagesFromManagedResources(nil) = %+v, want empty", got)
	}
}

// tokenFile writes a token and returns a config pointing a client at srv.
func clientFor(t *testing.T, srv *httptest.Server, token string, kinds []string, ttlSeconds int) *DesiredImageClient {
	t.Helper()
	dir := t.TempDir()
	tokenPath := filepath.Join(dir, "token")
	if token != "" {
		if err := os.WriteFile(tokenPath, []byte(token+"\n"), 0o600); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
	}
	cfg := config.Default().ArgoCD
	cfg.ServerAddress = srv.URL + "/"
	cfg.CAFile = ""
	cfg.TokenPath = tokenPath
	cfg.CacheTTLSeconds = ttlSeconds
	client, err := NewDesiredImageClient(cfg, kinds)
	if err != nil {
		t.Fatalf("NewDesiredImageClient() error = %v", err)
	}
	return client
}

func TestDesiredImagesQueriesEveryKind(t *testing.T) {
	// The client queries kinds concurrently, so the handler is reentrant.
	var mu sync.Mutex
	var queried []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer secret" {
			t.Errorf("Authorization = %q, want the bearer token", got)
		}
		kind := r.URL.Query().Get("kind")
		mu.Lock()
		queried = append(queried, kind)
		mu.Unlock()
		image := "123456789012.dkr.ecr.example/" + kind + ":v1"
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{map[string]any{"targetState": targetState(t, deployment(image))}},
		})
	}))
	defer srv.Close()

	client := clientFor(t, srv, "secret", []string{"Deployment", "StatefulSet"}, 0)
	if !client.HasToken() {
		t.Fatal("HasToken() = false after writing a token")
	}

	images, err := client.DesiredImages(context.Background(), "prd-payment-api")
	if err != nil {
		t.Fatalf("DesiredImages() error = %v", err)
	}
	if len(images) != 2 {
		t.Fatalf("DesiredImages() = %+v, want one image per kind", images)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(queried) != 2 {
		t.Errorf("queried kinds = %v, want two requests", queried)
	}
}

func TestDesiredImagesFailsWholeLookupOnPartialFailure(t *testing.T) {
	// A partial answer is worse than none: the kind that failed could be the
	// one whose tag differs, and a silent gap would let a mismatch through.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("kind") == "StatefulSet" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}})
	}))
	defer srv.Close()

	client := clientFor(t, srv, "secret", []string{"Deployment", "StatefulSet"}, 0)
	if _, err := client.DesiredImages(context.Background(), "prd-payment-api"); err == nil {
		t.Fatal("DesiredImages() = nil error, want failure when one kind fails")
	}
}

func TestDesiredImagesRejectsUnparsableResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer srv.Close()

	client := clientFor(t, srv, "secret", []string{"Deployment"}, 0)
	if _, err := client.DesiredImages(context.Background(), "prd-payment-api"); err == nil {
		t.Fatal("DesiredImages() = nil error, want a decode failure")
	}
}

func TestDesiredImagesWithoutWorkloadsReturnsEmptyNotNil(t *testing.T) {
	// An app with no workloads is a successful lookup. Returning nil would read
	// downstream as "lookup failed" and hit the onError policy instead.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}})
	}))
	defer srv.Close()

	client := clientFor(t, srv, "secret", []string{"Deployment"}, 0)
	images, err := client.DesiredImages(context.Background(), "prd-config-only")
	if err != nil {
		t.Fatalf("DesiredImages() error = %v", err)
	}
	if images == nil {
		t.Fatal("DesiredImages() = nil, want an empty non-nil slice")
	}
	if len(images) != 0 {
		t.Errorf("DesiredImages() = %+v, want empty", images)
	}
}

func TestDesiredImagesRequiresToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("the client called the API without a token")
	}))
	defer srv.Close()

	client := clientFor(t, srv, "", []string{"Deployment"}, 0)
	if client.HasToken() {
		t.Error("HasToken() = true without a token file")
	}
	if _, err := client.DesiredImages(context.Background(), "prd-payment-api"); err == nil {
		t.Fatal("DesiredImages() = nil error, want failure without a token")
	}
}

func TestDesiredImagesCaches(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []any{map[string]any{"targetState": targetState(t, deployment("a.example/payment-api:v1"))}},
		})
	}))
	defer srv.Close()

	client := clientFor(t, srv, "secret", []string{"Deployment"}, 60)
	for range 3 {
		if _, err := client.DesiredImages(context.Background(), "prd-payment-api"); err != nil {
			t.Fatalf("DesiredImages() error = %v", err)
		}
	}
	if got := calls.Load(); got != 1 {
		t.Errorf("upstream calls = %d, want 1 with caching on", got)
	}
}

func TestDesiredImagesSkipsCacheWhenTTLIsZero(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"items": []any{}})
	}))
	defer srv.Close()

	client := clientFor(t, srv, "secret", []string{"Deployment"}, 0)
	for range 2 {
		if _, err := client.DesiredImages(context.Background(), "prd-payment-api"); err != nil {
			t.Fatalf("DesiredImages() error = %v", err)
		}
	}
	if got := calls.Load(); got != 2 {
		t.Errorf("upstream calls = %d, want 2 with caching off", got)
	}
}

func TestNewDesiredImageClientCABundle(t *testing.T) {
	dir := t.TempDir()
	caPath := filepath.Join(dir, "ca.crt")

	cfg := config.Default().ArgoCD
	cfg.CAFile = caPath
	cfg.TokenPath = filepath.Join(dir, "token")

	if _, err := NewDesiredImageClient(cfg, []string{"Deployment"}); err == nil {
		t.Fatal("NewDesiredImageClient() with a missing CA file = nil error, want failure")
	}

	if err := os.WriteFile(caPath, []byte("not a certificate"), 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	if _, err := NewDesiredImageClient(cfg, []string{"Deployment"}); err == nil {
		t.Fatal("NewDesiredImageClient() with a bogus CA file = nil error, want failure")
	}

	// Skipping verification means the CA file is not read at all, so a broken
	// path must not stop the client from starting.
	cfg.InsecureSkipVerify = true
	if _, err := NewDesiredImageClient(cfg, []string{"Deployment"}); err != nil {
		t.Fatalf("NewDesiredImageClient() with verification off error = %v", err)
	}
}
