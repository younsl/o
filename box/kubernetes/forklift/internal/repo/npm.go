package repo

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// handleNpm serves the npm registry protocol. Paths under /npm/{repo}/:
//
//	<package>            packument (version index)  (metadata)
//	<package>/-/<file>   tarball                    (artifact)
//
// Scoped packages (@scope/name) arrive with the slash intact. For proxy repos
// the packument's dist.tarball URLs are rewritten to point back at forklift so
// tarball fetches are cached and age-gated here, and versions newer than the
// age-policy cooldown are filtered out of the packument entirely.
func (m *Manager) handleNpm(w http.ResponseWriter, r *http.Request) {
	res, ok := m.resolve(w, r, meta.FormatNPM)
	if !ok {
		return
	}
	if !m.authorize(w, r, res.repo.Name, actionForMethod(r.Method)) {
		return
	}
	if m.approvalGate(w, r, res, npmPackage(res.path), npmVersion(res.path)) {
		return
	}
	if m.vulnGate(w, r, res, npmPackage(res.path), npmVersion(res.path)) {
		return
	}

	if strings.Contains(res.path, "/-/") {
		m.npmTarball(w, r, res)
		return
	}

	switch r.Method {
	case http.MethodGet, http.MethodHead:
		m.npmPackument(w, r, res)
	case http.MethodPut:
		if res.repo.Type != meta.TypeHosted {
			http.Error(w, "uploads are only allowed on local repositories", http.StatusMethodNotAllowed)
			return
		}
		m.npmPublish(w, r, res)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (m *Manager) npmTarball(w http.ResponseWriter, r *http.Request, res resolved) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	version := npmVersion(res.path)
	m.engine.serve(w, r, fetchSpec{
		repo:        res.repo,
		cfg:         res.cfg,
		path:        res.path,
		version:     version,
		upstreamURL: joinUpstream(res.repo.UpstreamURL, res.path),
		kind:        kindArtifact,
		contentType: "application/octet-stream",
		// Derive the release time from the packument `time` map so the tarball
		// age gate agrees with the packument index filter (rewritePackument).
		// The npm CDN's Last-Modified header can drift from the publish time
		// (a re-uploaded tarball bumps mtime), which would block tarballs the
		// index still advertises. Fall back to Last-Modified when the packument
		// has no timestamp for this version.
		extractPublished: func(resp *http.Response) *time.Time {
			if t := m.npmTarballPublished(r.Context(), res, version); t != nil {
				return t
			}
			return lastModified(resp)
		},
	})
}

// npmTarballPublished resolves a tarball version's upstream publish time from the
// package's packument `time` map, the same source the packument age filter uses.
// Returns nil when the version, packument, or timestamp is unavailable so the
// caller can fall back to the HTTP Last-Modified header.
func (m *Manager) npmTarballPublished(ctx context.Context, res resolved, version string) *time.Time {
	if version == "" {
		return nil
	}
	pkgPath := res.path
	if i := strings.Index(res.path, "/-/"); i >= 0 {
		pkgPath = res.path[:i]
	}
	body, ok := m.npmPackumentBody(ctx, res, pkgPath)
	if !ok {
		return nil
	}
	var doc struct {
		Time map[string]string `json:"time"`
	}
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil
	}
	ts, ok := doc.Time[version]
	if !ok {
		return nil
	}
	t, err := time.Parse(time.RFC3339, ts)
	if err != nil {
		return nil
	}
	return &t
}

// npmPackumentBody returns the raw packument JSON for pkgPath, preferring the
// cached copy and otherwise fetching it from upstream. The upstream fetch is
// best-effort (no caching): a nil/false result simply drops the caller back to
// the Last-Modified header.
func (m *Manager) npmPackumentBody(ctx context.Context, res resolved, pkgPath string) ([]byte, bool) {
	e := m.engine
	if art, err := e.store.GetArtifact(ctx, res.repo.ID, pkgPath); err == nil {
		if body, berr := readBlob(ctx, e, art); berr == nil {
			return body, true
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, joinUpstream(res.repo.UpstreamURL, pkgPath), nil)
	if err != nil {
		return nil, false
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return nil, false
	}
	return body, true
}

func (m *Manager) npmPackument(w http.ResponseWriter, r *http.Request, res resolved) {
	ctx := r.Context()
	e := m.engine

	art, err := e.store.GetArtifact(ctx, res.repo.ID, res.path)
	cached := err == nil
	if err != nil && !errors.Is(err, meta.ErrNotFound) {
		http.Error(w, "metadata error", http.StatusInternalServerError)
		return
	}
	if cached && (res.repo.Type == meta.TypeHosted || e.fresh(art, res.cfg, kindMetadata)) {
		_ = e.store.Touch(ctx, res.repo.ID, res.path)
		if res.repo.Type == meta.TypeHosted {
			e.serveArtifact(w, r, art)
			return
		}
		// The cache holds the upstream's original packument; tarball URLs are
		// rewritten per request so cached bodies stay host-agnostic (a client
		// cannot poison the cache for others via Host/X-Forwarded-* headers).
		body, berr := readBlob(ctx, e, art)
		if berr != nil {
			http.Error(w, "blob missing", http.StatusInternalServerError)
			return
		}
		transformed, _ := rewritePackument(body, m.externalBase(r), res.repo.Name, res.path, res.cfg.AgePolicy, e.now())
		writePackument(w, r, transformed)
		return
	}
	if res.repo.Type == meta.TypeHosted {
		http.NotFound(w, r)
		return
	}

	key := res.repo.Name + "/" + res.path
	if e.neg.has(key) {
		http.NotFound(w, r)
		return
	}
	e.cacheMiss.WithLabelValues(res.repo.Name).Inc()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, joinUpstream(res.repo.UpstreamURL, res.path), nil)
	resp, err := e.client.Do(req)
	if err != nil {
		e.upstreamErr.WithLabelValues(res.repo.Name).Inc()
		e.log.Error("upstream fetch failed", "repo", res.repo.Name, "url", joinUpstream(res.repo.UpstreamURL, res.path), "err", err)
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		e.neg.set(key, res.cfg.Cache.NegativeTTL.D())
		http.NotFound(w, r)
		return
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		e.upstreamErr.WithLabelValues(res.repo.Name).Inc()
		http.Error(w, "upstream error", http.StatusBadGateway)
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		http.Error(w, "read upstream", http.StatusBadGateway)
		return
	}
	transformed, removed := rewritePackument(body, m.externalBase(r), res.repo.Name, res.path, res.cfg.AgePolicy, e.now())
	if removed > 0 {
		e.ageBlocks.WithLabelValues(res.repo.Name, res.cfg.AgePolicy.Action).Add(float64(removed))
		e.log.Warn("age policy quarantined package versions",
			"repo", res.repo.Name, "package", res.path,
			"removed", removed, "min_age", res.cfg.AgePolicy.MinAge.D().String(), "action", "block")
	}

	if !res.cfg.Cache.Enabled {
		writePackument(w, r, transformed)
		return
	}
	// Cache the upstream's original body, not the rewritten one: rewriting
	// happens per request so the cache never embeds a request-derived host.
	if _, err := e.storeArtifact(ctx, fetchSpec{repo: res.repo, path: res.path}, bytes.NewReader(body), "application/json", nil); err != nil {
		http.Error(w, "cache write failed", http.StatusInternalServerError)
		return
	}
	writePackument(w, r, transformed)
}

// writePackument writes a (rewritten) packument response.
func writePackument(w http.ResponseWriter, r *http.Request, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(body)
}

// npmPublish handles `npm publish` to a hosted repository. The request body is a
// packument document with base64 _attachments; each attachment is stored as a
// tarball blob and the packument (minus attachments) is stored as the index.
func (m *Manager) npmPublish(w http.ResponseWriter, r *http.Request, res resolved) {
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, 256<<20))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		http.Error(w, "invalid publish document", http.StatusBadRequest)
		return
	}
	ctx := r.Context()
	if atts, ok := doc["_attachments"].(map[string]any); ok {
		for name, v := range atts {
			att, ok := v.(map[string]any)
			if !ok {
				continue
			}
			data, _ := att["data"].(string)
			decoded, err := base64.StdEncoding.DecodeString(data)
			if err != nil {
				http.Error(w, "invalid attachment encoding", http.StatusBadRequest)
				return
			}
			tarballPath := res.path + "/-/" + path.Base(name)
			if err := m.engine.put(ctx, res.repo, tarballPath, "", "application/octet-stream", nil, bytes.NewReader(decoded)); err != nil {
				http.Error(w, "store tarball failed", http.StatusInternalServerError)
				return
			}
			m.scanStored(res.repo, tarballPath)
		}
	}
	delete(doc, "_attachments")
	indexBody, _ := json.Marshal(doc)
	if err := m.engine.put(ctx, res.repo, res.path, "", "application/json", nil, bytes.NewReader(indexBody)); err != nil {
		http.Error(w, "store packument failed", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusCreated)
}

// highestStableVersion returns the highest plain x.y.z version key (pre-release
// and build-metadata versions are skipped), or "" when none parse.
func highestStableVersion(versions map[string]any) string {
	best := ""
	var bestN [3]int
	for ver := range versions {
		n, ok := parseSemver(ver)
		if !ok {
			continue
		}
		if best == "" || n[0] > bestN[0] ||
			(n[0] == bestN[0] && (n[1] > bestN[1] || (n[1] == bestN[1] && n[2] > bestN[2]))) {
			best, bestN = ver, n
		}
	}
	return best
}

// parseSemver parses a stable x.y.z version, rejecting pre-release/build forms.
func parseSemver(v string) ([3]int, bool) {
	v = strings.TrimPrefix(v, "v")
	if strings.ContainsAny(v, "-+") {
		return [3]int{}, false
	}
	segs := strings.Split(v, ".")
	if len(segs) != 3 {
		return [3]int{}, false
	}
	var out [3]int
	for i, s := range segs {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return [3]int{}, false
		}
		out[i] = n
	}
	return out, true
}

// npmPackage extracts the package name from an npm protocol path: the whole
// path for packuments, the part before /-/ for tarballs. Scoped names may
// arrive with the scope slash percent-encoded by some clients.
func npmPackage(p string) string {
	if i := strings.Index(p, "/-/"); i >= 0 {
		p = p[:i]
	}
	p = strings.ReplaceAll(p, "%2f", "/")
	p = strings.ReplaceAll(p, "%2F", "/")
	return strings.ToLower(strings.Trim(p, "/"))
}

// npmVersion extracts the version from an npm tarball path
// (<pkg>/-/<basename>-<version>.tgz). Versions may themselves contain dashes
// (1.0.0-beta.1), so the basename prefix is stripped by name rather than split
// on dashes. Returns "" for packument paths and unrecognized layouts (never
// block on unknown).
func npmVersion(p string) string {
	i := strings.Index(p, "/-/")
	if i < 0 {
		return ""
	}
	pkg := npmPackage(p)
	file := strings.ToLower(path.Base(p))
	base := path.Base(pkg) // scoped tarballs are named after the unscoped part
	v, ok := strings.CutPrefix(strings.TrimSuffix(file, ".tgz"), base+"-")
	if !ok || v == "" || !strings.HasSuffix(file, ".tgz") {
		return ""
	}
	return v
}

// rewritePackument rewrites dist.tarball URLs to forklift and removes versions
// whose upstream publish time violates a blocking age policy. It returns the
// transformed JSON and the number of versions removed.
func rewritePackument(body []byte, base, repoName, pkg string, age repoconfig.AgePolicyConfig, now time.Time) ([]byte, int) {
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return body, 0
	}
	times, _ := doc["time"].(map[string]any)
	versions, _ := doc["versions"].(map[string]any)

	removed := 0
	blockedVersions := map[string]bool{}
	if age.Enabled && age.Action == repoconfig.ActionBlock {
		for ver := range versions {
			if ts, ok := times[ver].(string); ok {
				if pub, err := time.Parse(time.RFC3339, ts); err == nil && now.Sub(pub) < age.MinAge.D() {
					blockedVersions[ver] = true
				}
			}
		}
	}

	for ver, v := range versions {
		if blockedVersions[ver] {
			delete(versions, ver)
			removed++
			continue
		}
		vm, ok := v.(map[string]any)
		if !ok {
			continue
		}
		if dist, ok := vm["dist"].(map[string]any); ok {
			if tb, ok := dist["tarball"].(string); ok {
				dist["tarball"] = base + "/npm/" + repoName + "/" + pkg + "/-/" + path.Base(tb)
			}
		}
	}
	// Prune dist-tags pointing at removed versions. latest is remapped to the
	// highest remaining stable version so a bare `npm install <pkg>` resolves to
	// the newest policy-compliant release instead of failing.
	if tags, ok := doc["dist-tags"].(map[string]any); ok {
		remapLatest := false
		for tag, v := range tags {
			if ver, ok := v.(string); ok && blockedVersions[ver] {
				delete(tags, tag)
				remapLatest = remapLatest || tag == "latest"
			}
		}
		if remapLatest {
			if best := highestStableVersion(versions); best != "" {
				tags["latest"] = best
			}
		}
	}
	out, err := json.Marshal(doc)
	if err != nil {
		return body, removed
	}
	return out, removed
}
