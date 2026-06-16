// Package repo serves the package-format protocols (Maven, npm, Cargo, Go,
// PyPI) over Hosted and Proxy (cached upstream) repositories. The
// Engine holds the shared cache/store logic; per-format files translate
// protocol requests into Engine operations.
package repo

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
	"github.com/younsl/o/box/kubernetes/forklift/internal/storage"
)

// kind classifies a request target, which selects the cache freshness policy.
type kind int

const (
	kindArtifact kind = iota // immutable artifact bytes
	kindMetadata             // mutable index documents (revalidated on MetadataTTL)
)

// Engine implements the shared repository cache/store logic.
type Engine struct {
	store  *meta.Store
	blobs  storage.BlobStore
	client *http.Client
	// extClient fetches client-supplied URLs (fetchSpec.untrustedURL); its
	// dialer refuses private/loopback/link-local destinations to prevent SSRF.
	extClient *http.Client
	log       *slog.Logger
	neg       *negCache
	now       func() time.Time

	cacheHits   *prometheus.CounterVec
	cacheMiss   *prometheus.CounterVec
	ageBlocks   *prometheus.CounterVec
	upstreamErr *prometheus.CounterVec
	bytes       *prometheus.CounterVec
}

// NewEngine builds an Engine and registers its metrics.
func NewEngine(store *meta.Store, blobs storage.BlobStore, log *slog.Logger, reg prometheus.Registerer) *Engine {
	e := &Engine{
		store:     store,
		blobs:     blobs,
		client:    &http.Client{Timeout: 60 * time.Second},
		extClient: newPublicOnlyClient(60 * time.Second),
		log:       log,
		neg:       newNegCache(),
		now:       time.Now,
		cacheHits: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "cache_hits_total", Help: "Proxy cache hits.",
		}, []string{"repo"}),
		cacheMiss: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "cache_misses_total", Help: "Proxy cache misses.",
		}, []string{"repo"}),
		ageBlocks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "age_policy_violations_total", Help: "Age policy violations.",
		}, []string{"repo", "action"}),
		upstreamErr: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "upstream_errors_total", Help: "Upstream fetch errors.",
		}, []string{"repo"}),
		bytes: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "forklift", Name: "bytes_transferred_total",
			Help: "Artifact bytes transferred to/from clients (egress=downloads, ingress=uploads).",
		}, []string{"direction", "format"}),
	}
	reg.MustRegister(e.cacheHits, e.cacheMiss, e.ageBlocks, e.upstreamErr, e.bytes)
	return e
}

// fetchSpec parameterises a GET/HEAD against the engine for one request.
type fetchSpec struct {
	repo        meta.Repository
	cfg         repoconfig.Config
	path        string // repo-relative storage key
	upstreamURL string // full upstream URL (proxy only)
	// untrustedURL marks upstreamURL as client-supplied (not derived from the
	// admin-configured upstream); it is fetched via the SSRF-guarded client.
	untrustedURL bool
	kind         kind
	version      string
	contentType  string
	// extractPublished derives the upstream release time from a proxy response.
	extractPublished func(resp *http.Response) *time.Time
}

// serve handles a GET or HEAD for a repository path.
func (e *Engine) serve(w http.ResponseWriter, r *http.Request, spec fetchSpec) {
	ctx := r.Context()
	key := spec.repo.Name + "/" + spec.path

	if art, err := e.store.GetArtifact(ctx, spec.repo.ID, spec.path); err == nil {
		// Hosted repositories are authoritative and always serve stored artifacts;
		// proxy repositories serve from cache only while the entry is fresh.
		if spec.repo.Type == meta.TypeHosted || e.fresh(art, spec.cfg, spec.kind) {
			if e.ageGate(w, spec, art.PublishedAt) {
				return
			}
			if spec.repo.Type == meta.TypeProxy {
				e.cacheHits.WithLabelValues(spec.repo.Name).Inc()
			}
			_ = e.store.Touch(ctx, spec.repo.ID, spec.path)
			n := e.serveArtifact(w, r, art)
			e.bytes.WithLabelValues("egress", spec.repo.Format).Add(float64(n))
			return
		}
	} else if !errors.Is(err, meta.ErrNotFound) {
		http.Error(w, "metadata error", http.StatusInternalServerError)
		return
	}

	if spec.repo.Type == meta.TypeHosted {
		http.NotFound(w, r)
		return
	}

	// Proxy path.
	if e.neg.has(key) {
		http.NotFound(w, r)
		return
	}
	e.cacheMiss.WithLabelValues(spec.repo.Name).Inc()
	e.fetchAndServe(w, r, spec, key)
}

func (e *Engine) fetchAndServe(w http.ResponseWriter, r *http.Request, spec fetchSpec, key string) {
	ctx := r.Context()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, spec.upstreamURL, nil)
	if err != nil {
		http.Error(w, "bad upstream url", http.StatusBadGateway)
		return
	}
	client := e.client
	if spec.untrustedURL {
		client = e.extClient
	}
	resp, err := client.Do(req)
	if err != nil {
		e.upstreamErr.WithLabelValues(spec.repo.Name).Inc()
		e.log.Error("upstream fetch failed", "repo", spec.repo.Name, "url", spec.upstreamURL, "err", err)
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode == http.StatusNotFound:
		e.neg.set(key, spec.cfg.Cache.NegativeTTL.D())
		http.NotFound(w, r)
		return
	case resp.StatusCode < 200 || resp.StatusCode >= 300:
		e.upstreamErr.WithLabelValues(spec.repo.Name).Inc()
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}

	var published *time.Time
	if spec.extractPublished != nil {
		published = spec.extractPublished(resp)
	}
	if e.ageGate(w, spec, published) {
		return
	}

	contentType := spec.contentType
	if contentType == "" {
		contentType = resp.Header.Get("Content-Type")
	}

	if !spec.cfg.Cache.Enabled {
		// Pass-through without persisting.
		if contentType != "" {
			w.Header().Set("Content-Type", contentType)
		}
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		n, _ := io.Copy(w, resp.Body)
		e.bytes.WithLabelValues("egress", spec.repo.Format).Add(float64(n))
		return
	}

	art, err := e.storeArtifact(ctx, spec, resp.Body, contentType, published)
	if err != nil {
		http.Error(w, "cache write failed", http.StatusInternalServerError)
		return
	}
	e.maybeEvict(ctx, spec)
	n := e.serveArtifact(w, r, art)
	e.bytes.WithLabelValues("egress", spec.repo.Format).Add(float64(n))
}

// storeArtifact streams body into the blob store and records the artifact.
func (e *Engine) storeArtifact(ctx context.Context, spec fetchSpec, body io.Reader, contentType string, published *time.Time) (meta.Artifact, error) {
	digest, size, err := e.blobs.Put(ctx, body)
	if err != nil {
		return meta.Artifact{}, err
	}
	now := e.now()
	return e.store.PutArtifact(ctx, meta.Artifact{
		RepoID:         spec.repo.ID,
		Path:           spec.path,
		Version:        spec.version,
		BlobSHA256:     digest,
		Size:           size,
		ContentType:    contentType,
		PublishedAt:    published,
		CachedAt:       now,
		LastAccessedAt: now,
	})
}

// put stores an uploaded artifact for a hosted repository.
func (e *Engine) put(ctx context.Context, repo meta.Repository, path, version, contentType string, published *time.Time, body io.Reader) error {
	art, err := e.storeArtifact(ctx, fetchSpec{
		repo: repo, path: path, version: version, contentType: contentType,
	}, body, contentType, published)
	e.neg.clear(repo.Name + "/" + path)
	if err == nil {
		e.bytes.WithLabelValues("ingress", repo.Format).Add(float64(art.Size))
	}
	return err
}

// serveArtifact writes the artifact body and returns the number of bytes copied
// to the client (0 for HEAD or a 304 response).
func (e *Engine) serveArtifact(w http.ResponseWriter, r *http.Request, art meta.Artifact) int64 {
	rc, size, err := e.blobs.Open(r.Context(), art.BlobSHA256)
	if err != nil {
		http.Error(w, "blob missing", http.StatusInternalServerError)
		return 0
	}
	defer rc.Close()
	if art.ContentType != "" {
		w.Header().Set("Content-Type", art.ContentType)
	}
	w.Header().Set("ETag", `"`+art.BlobSHA256+`"`)
	if match := r.Header.Get("If-None-Match"); match != "" && match == `"`+art.BlobSHA256+`"` {
		w.WriteHeader(http.StatusNotModified)
		return 0
	}
	w.Header().Set("Content-Length", itoa(size))
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return 0
	}
	n, _ := io.Copy(w, rc)
	return n
}

// ageGate evaluates the age policy and, when blocking, writes a 404 and returns
// true so the caller stops. Warnings are logged and counted but allowed.
func (e *Engine) ageGate(w http.ResponseWriter, spec fetchSpec, published *time.Time) bool {
	decision, reason := evaluateAge(spec.cfg.AgePolicy, published, e.now())
	switch decision {
	case ageBlock:
		e.ageBlocks.WithLabelValues(spec.repo.Name, "block").Inc()
		e.log.Warn("age policy blocked artifact",
			"repo", spec.repo.Name, "path", spec.path, "reason", reason)
		http.Error(w, "blocked by age policy", http.StatusNotFound)
		return true
	case ageWarn:
		e.ageBlocks.WithLabelValues(spec.repo.Name, "warn").Inc()
		e.log.Warn("age policy warning",
			"repo", spec.repo.Name, "path", spec.path, "reason", reason)
		return false
	default:
		return false
	}
}

// fresh reports whether a cached artifact is still fresh under the cache policy.
func (e *Engine) fresh(art meta.Artifact, cfg repoconfig.Config, k kind) bool {
	if !cfg.Cache.Enabled {
		return false
	}
	var ttl time.Duration
	switch k {
	case kindMetadata:
		ttl = cfg.Cache.MetadataTTL.D()
	default:
		ttl = cfg.Cache.ArtifactTTL.D()
	}
	if ttl <= 0 {
		// Artifacts are immutable (ttl 0 = never revalidate); metadata with no TTL
		// is treated as always-revalidate to avoid serving stale indexes.
		return k == kindArtifact
	}
	return e.now().Sub(art.CachedAt) < ttl
}

// maybeEvict trims the repository cache to its configured size cap.
func (e *Engine) maybeEvict(ctx context.Context, spec fetchSpec) {
	max := spec.cfg.Cache.MaxSizeBytes
	if max <= 0 {
		return
	}
	size, err := e.store.RepoSize(ctx, spec.repo.ID)
	if err != nil || size <= max {
		return
	}
	// Evict in small batches until under the cap (bounded to avoid long loops).
	for i := 0; i < 64; i++ {
		if n, err := e.store.EvictLRU(ctx, spec.repo.ID, 16); err != nil || n == 0 {
			break
		}
		if size, err := e.store.RepoSize(ctx, spec.repo.ID); err != nil || size <= max {
			break
		}
	}
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
