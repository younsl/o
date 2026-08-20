package argocd

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/config"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/gate"
)

// managedResources is the shape of GET
// /api/v1/applications/{name}/managed-resources. Argo CD serializes the nested
// manifests as JSON strings rather than objects.
type managedResources struct {
	Items []ManagedResourceItem `json:"items"`
}

// ManagedResourceItem is one entry of the managed-resources response.
type ManagedResourceItem struct {
	// TargetState is the desired manifest, empty for a resource that only
	// exists live.
	TargetState string `json:"targetState"`
}

type cacheEntry struct {
	fetchedAt time.Time
	images    []gate.ImageRef
}

// DesiredImageClient answers the one question the Kubernetes API cannot: which
// images a pending sync would actually deploy.
//
// The desired manifests live in git, so they are only reachable through Argo
// CD's own cached comparison. managed-resources serves that cache without
// forcing a repo-server render, and the query is narrowed to workload kinds so
// the payload stays small enough to answer inside an admission timeout.
type DesiredImageClient struct {
	http     *http.Client
	base     string
	token    string
	kinds    []string
	cacheTTL time.Duration

	mu    sync.RWMutex
	cache map[string]cacheEntry
}

// NewDesiredImageClient builds the client and reads the API token from disk.
//
// A missing token is not fatal at construction time: the pod may start before
// the Secret is projected, and the configured onError policy decides what a
// failed lookup means.
func NewDesiredImageClient(cfg config.ArgoCD, kinds []string) (*DesiredImageClient, error) {
	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
		//nolint:gosec // Operators opt into this explicitly; the default is verification with CAFile.
		InsecureSkipVerify: cfg.InsecureSkipVerify,
	}
	if cfg.CAFile != "" && !cfg.InsecureSkipVerify {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("read argocd ca bundle %s: %w", cfg.CAFile, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("argocd ca bundle %s contains no certificate", cfg.CAFile)
		}
		tlsCfg.RootCAs = pool
	}

	token := ""
	if raw, err := os.ReadFile(cfg.TokenPath); err == nil {
		token = strings.TrimSpace(string(raw))
	}

	return &DesiredImageClient{
		http: &http.Client{
			Timeout:   time.Duration(cfg.TimeoutSeconds) * time.Second,
			Transport: &http.Transport{TLSClientConfig: tlsCfg},
		},
		base:     strings.TrimRight(cfg.ServerAddress, "/"),
		token:    token,
		kinds:    kinds,
		cacheTTL: time.Duration(cfg.CacheTTLSeconds) * time.Second,
		cache:    make(map[string]cacheEntry),
	}, nil
}

// HasToken reports whether an API token was found, so startup can warn once
// instead of failing every lookup silently.
func (c *DesiredImageClient) HasToken() bool { return c.token != "" }

// DesiredImages returns the images a pending sync of app would deploy.
func (c *DesiredImageClient) DesiredImages(ctx context.Context, app string) ([]gate.ImageRef, error) {
	if images, ok := c.cached(app); ok {
		return images, nil
	}
	if c.token == "" {
		return nil, fmt.Errorf("no argocd api token is mounted")
	}

	type result struct {
		images []gate.ImageRef
		err    error
	}
	results := make([]result, len(c.kinds))
	var wg sync.WaitGroup
	for i, kind := range c.kinds {
		wg.Go(func() {
			images, err := c.fetchKind(ctx, app, kind)
			results[i] = result{images: images, err: err}
		})
	}
	wg.Wait()

	// A partial answer is worse than none: the kind that failed to load could
	// be exactly the workload whose tag differs.
	var images []gate.ImageRef
	for i, res := range results {
		if res.err != nil {
			return nil, fmt.Errorf("kind %s: %w", c.kinds[i], res.err)
		}
		images = append(images, res.images...)
	}

	// A successful lookup that finds no workload is a real answer, but nil
	// would read as "lookup failed" downstream, so it is normalized here.
	if images == nil {
		images = []gate.ImageRef{}
	}
	c.store(app, images)
	return images, nil
}

func (c *DesiredImageClient) fetchKind(ctx context.Context, app, kind string) ([]gate.ImageRef, error) {
	endpoint := fmt.Sprintf("%s/api/v1/applications/%s/managed-resources?kind=%s",
		c.base, url.PathEscape(app), url.QueryEscape(kind))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("call argocd api: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("argocd api returned %d for managed-resources", resp.StatusCode)
	}

	var body managedResources
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("decode managed-resources: %w", err)
	}
	return ImagesFromManagedResources(body.Items), nil
}

// ImagesFromManagedResources extracts container images from the desired
// manifests of a managed-resources response.
func ImagesFromManagedResources(items []ManagedResourceItem) []gate.ImageRef {
	var out []gate.ImageRef
	for _, item := range items {
		if strings.TrimSpace(item.TargetState) == "" {
			continue
		}
		var manifest any
		if err := json.Unmarshal([]byte(item.TargetState), &manifest); err != nil {
			// A manifest Argo CD could render but this gate cannot parse is not
			// worth failing the whole lookup over; the remaining kinds still
			// produce a comparison.
			continue
		}
		out = append(out, gate.ExtractImages(manifest)...)
	}
	return out
}

func (c *DesiredImageClient) cached(app string) ([]gate.ImageRef, bool) {
	if c.cacheTTL <= 0 {
		return nil, false
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.cache[app]
	if !ok || time.Since(entry.fetchedAt) >= c.cacheTTL {
		return nil, false
	}
	return entry.images, true
}

func (c *DesiredImageClient) store(app string, images []gate.ImageRef) {
	if c.cacheTTL <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.cache[app] = cacheEntry{fetchedAt: time.Now(), images: images}
}
