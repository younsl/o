package repo

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// pypiJSONType is the PEP 691 simple-index media type.
const pypiJSONType = "application/vnd.pypi.simple.v1+json"

// handlePyPI serves the PyPI simple repository protocol (PEP 503/691/700).
// Paths under /pypi/{repo}/:
//
//	simple/<project>/          version index (metadata)
//	packages/<ref>/<filename>  distribution file (artifact)
//	POST to the repo root      twine legacy upload (local repos)
//
// For proxy repos the simple index is fetched from upstream as PEP 691 JSON,
// files newer than the age-policy cooldown are removed (PEP 700 upload-time),
// and file URLs are rewritten to point back at forklift; the original upstream
// URL travels base64url-encoded in <ref> because PyPI serves files from a
// different host than the index.
func (m *Manager) handlePyPI(w http.ResponseWriter, r *http.Request) {
	res, ok := m.resolveRepo(w, r, meta.FormatPyPI)
	if !ok {
		return
	}
	if !m.authorize(w, r, res.repo.Name, actionForMethod(r.Method)) {
		return
	}

	switch {
	case res.path == "":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if res.repo.Type != meta.TypeHosted {
			http.Error(w, "uploads are only allowed on local repositories", http.StatusMethodNotAllowed)
			return
		}
		m.pypiUpload(w, r, res)
	case strings.HasPrefix(res.path, "simple/"):
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		m.pypiSimple(w, r, res)
	case strings.HasPrefix(res.path, "packages/"):
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		m.pypiFile(w, r, res)
	default:
		http.NotFound(w, r)
	}
}

// pypiSimple serves a project's version index.
func (m *Manager) pypiSimple(w http.ResponseWriter, r *http.Request, res resolved) {
	project := normalizePyPI(strings.Trim(strings.TrimPrefix(res.path, "simple/"), "/"))
	if project == "" {
		http.NotFound(w, r)
		return
	}
	if m.approvalGate(w, r, res, project, "") {
		return
	}
	if res.repo.Type == meta.TypeHosted {
		m.pypiLocalSimple(w, r, res, project)
		return
	}

	ctx := r.Context()
	e := m.engine
	key := "simple/" + project

	art, err := e.store.GetArtifact(ctx, res.repo.ID, key)
	if err == nil && e.fresh(art, res.cfg, kindMetadata) {
		// The cache holds the upstream's original index; URLs are rewritten per
		// request so cached bodies stay host-agnostic (a client cannot poison
		// the cache for others via Host/X-Forwarded-* headers).
		if body, berr := readBlob(ctx, e, art); berr == nil {
			if out, _, rerr := rewriteSimpleIndex(body, m.externalBase(r), res.repo.Name, res.cfg.AgePolicy, e.now()); rerr == nil {
				_ = e.store.Touch(ctx, res.repo.ID, key)
				writeSimple(w, r, out, project)
				return
			}
		}
	} else if err != nil && !errors.Is(err, meta.ErrNotFound) {
		http.Error(w, "metadata error", http.StatusInternalServerError)
		return
	}

	negKey := res.repo.Name + "/" + key
	if e.neg.has(negKey) {
		http.NotFound(w, r)
		return
	}
	e.cacheMiss.WithLabelValues(res.repo.Name).Inc()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, joinUpstream(res.repo.UpstreamURL, project)+"/", nil)
	req.Header.Set("Accept", pypiJSONType)
	resp, err := e.client.Do(req)
	if err != nil {
		e.upstreamErr.WithLabelValues(res.repo.Name).Inc()
		http.Error(w, "upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		e.neg.set(negKey, res.cfg.Cache.NegativeTTL.D())
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
	out, removed, err := rewriteSimpleIndex(body, m.externalBase(r), res.repo.Name, res.cfg.AgePolicy, e.now())
	if err != nil {
		http.Error(w, "upstream simple index is not PEP 691 JSON", http.StatusBadGateway)
		return
	}
	if removed > 0 {
		e.ageBlocks.WithLabelValues(res.repo.Name, res.cfg.AgePolicy.Action).Add(float64(removed))
		e.log.Warn("age policy quarantined package files",
			"repo", res.repo.Name, "project", project,
			"removed", removed, "min_age", res.cfg.AgePolicy.MinAge.D().String(), "action", "block")
	}

	if !res.cfg.Cache.Enabled {
		writeSimple(w, r, out, project)
		return
	}
	// Cache the upstream's original body, not the rewritten one: rewriting
	// happens per request so the cache never embeds a request-derived host.
	if _, err := e.storeArtifact(ctx, fetchSpec{repo: res.repo, path: key}, bytes.NewReader(body), pypiJSONType, nil); err != nil {
		http.Error(w, "cache write failed", http.StatusInternalServerError)
		return
	}
	writeSimple(w, r, out, project)
}

// pypiLocalSimple builds a PEP 691 index for a hosted repository from its stored
// distribution files.
func (m *Manager) pypiLocalSimple(w http.ResponseWriter, r *http.Request, res resolved, project string) {
	arts, err := m.engine.store.ListArtifacts(r.Context(), res.repo.ID, "packages/"+project+"/")
	if err != nil {
		http.Error(w, "metadata error", http.StatusInternalServerError)
		return
	}
	if len(arts) == 0 {
		http.NotFound(w, r)
		return
	}
	base := m.externalBase(r)
	files := make([]any, 0, len(arts))
	seen := map[string]bool{}
	var versions []string
	for _, a := range arts {
		files = append(files, map[string]any{
			"filename": path.Base(a.Path),
			"url":      base + "/pypi/" + res.repo.Name + "/" + a.Path,
			"hashes":   map[string]any{"sha256": a.BlobSHA256},
		})
		if a.Version != "" && !seen[a.Version] {
			seen[a.Version] = true
			versions = append(versions, a.Version)
		}
	}
	sort.Strings(versions)
	out, err := json.Marshal(map[string]any{
		"meta":     map[string]any{"api-version": "1.1"},
		"name":     project,
		"files":    files,
		"versions": versions,
	})
	if err != nil {
		http.Error(w, "encode index", http.StatusInternalServerError)
		return
	}
	writeSimple(w, r, out, project)
}

// pypiFile serves a distribution file. For proxy repos the upstream URL is
// recovered from the base64url-encoded <ref> path segment written by
// rewriteSimpleIndex.
func (m *Manager) pypiFile(w http.ResponseWriter, r *http.Request, res resolved) {
	// The .metadata suffix (PEP 658) is stripped so a denied version's core
	// metadata is blocked along with the distribution file itself.
	pypiPkg := pypiPackageFromFilename(path.Base(res.path))
	pypiVer := pypiVersion(strings.TrimSuffix(path.Base(res.path), ".metadata"))
	if m.approvalGate(w, r, res, pypiPkg, pypiVer) {
		return
	}
	if m.vulnGate(w, r, res, pypiPkg, pypiVer) {
		return
	}
	spec := fetchSpec{
		repo:             res.repo,
		cfg:              res.cfg,
		path:             res.path,
		kind:             kindArtifact,
		version:          pypiVersion(path.Base(res.path)),
		contentType:      "application/octet-stream",
		extractPublished: lastModified,
	}
	if res.repo.Type == meta.TypeProxy {
		ref, filename, _ := strings.Cut(strings.TrimPrefix(res.path, "packages/"), "/")
		raw, err := base64.RawURLEncoding.DecodeString(ref)
		if err != nil {
			http.Error(w, "invalid package reference", http.StatusBadRequest)
			return
		}
		fileURL, err := url.Parse(string(raw))
		if err != nil || (fileURL.Scheme != "http" && fileURL.Scheme != "https") || fileURL.Hostname() == "" {
			http.Error(w, "invalid package reference", http.StatusBadRequest)
			return
		}
		u := fileURL.String()
		// PEP 658: clients fetch core metadata at <file-url>.metadata, so the
		// rewritten ref still points at the distribution file itself.
		if strings.HasSuffix(filename, ".metadata") && !strings.HasSuffix(u, ".metadata") {
			u += ".metadata"
		}
		spec.upstreamURL = u
		// The ref is client-controlled. Only the admin-configured upstream host
		// is trusted; any other host (PyPI legitimately serves files from a
		// different host than the index) is fetched via the SSRF-guarded client
		// that refuses private/loopback destinations.
		spec.untrustedURL = !sameHost(fileURL, res.repo.UpstreamURL)
	}
	m.engine.serve(w, r, spec)
}

// pypiUpload handles the twine legacy upload API: a multipart form with name,
// version and content fields POSTed to the repository root.
func (m *Manager) pypiUpload(w http.ResponseWriter, r *http.Request, res resolved) {
	if err := r.ParseMultipartForm(256 << 20); err != nil {
		http.Error(w, "invalid multipart form", http.StatusBadRequest)
		return
	}
	name := normalizePyPI(r.FormValue("name"))
	file, header, err := r.FormFile("content")
	if name == "" || err != nil {
		http.Error(w, "missing name or content field", http.StatusBadRequest)
		return
	}
	defer file.Close()
	filename := path.Base(header.Filename)
	if filename == "" || filename == "." || filename == "/" {
		http.Error(w, "invalid filename", http.StatusBadRequest)
		return
	}
	p := "packages/" + name + "/" + filename
	if err := m.engine.put(r.Context(), res.repo, p, r.FormValue("version"), "application/octet-stream", nil, file); err != nil {
		http.Error(w, "store failed", http.StatusInternalServerError)
		return
	}
	m.scanStored(res.repo, p)
	w.WriteHeader(http.StatusCreated)
}

// rewriteSimpleIndex rewrites a PEP 691 index: file URLs are pointed back at
// forklift and files whose PEP 700 upload-time violates a blocking age policy
// are removed. It returns the transformed JSON and the number of files removed.
func rewriteSimpleIndex(body []byte, base, repoName string, age repoconfig.AgePolicyConfig, now time.Time) ([]byte, int, error) {
	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		return nil, 0, err
	}
	files, _ := doc["files"].([]any)
	kept := make([]any, 0, len(files))
	removed := 0
	for _, v := range files {
		fm, ok := v.(map[string]any)
		if !ok {
			kept = append(kept, v)
			continue
		}
		if age.Enabled && age.Action == repoconfig.ActionBlock {
			if ts, ok := fm["upload-time"].(string); ok {
				if pub, err := time.Parse(time.RFC3339, ts); err == nil && now.Sub(pub) < age.MinAge.D() {
					removed++
					continue
				}
			}
		}
		if u, ok := fm["url"].(string); ok {
			name, _ := fm["filename"].(string)
			if name == "" {
				name = path.Base(u)
			}
			fm["url"] = base + "/pypi/" + repoName + "/packages/" +
				base64.RawURLEncoding.EncodeToString([]byte(u)) + "/" + name
		}
		kept = append(kept, fm)
	}
	doc["files"] = kept
	out, err := json.Marshal(doc)
	if err != nil {
		return nil, 0, err
	}
	return out, removed, nil
}

// writeSimple writes a project index, negotiating between PEP 691 JSON and a
// PEP 503 HTML rendering of the same document.
func writeSimple(w http.ResponseWriter, r *http.Request, jsonBody []byte, project string) {
	if strings.Contains(r.Header.Get("Accept"), pypiJSONType) {
		w.Header().Set("Content-Type", pypiJSONType)
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = w.Write(jsonBody)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(simpleHTML(jsonBody, project))
}

// simpleHTML renders a PEP 691 JSON index as a PEP 503 HTML page for clients
// that do not accept the JSON media type.
func simpleHTML(jsonBody []byte, project string) []byte {
	var doc struct {
		Files []struct {
			Filename       string            `json:"filename"`
			URL            string            `json:"url"`
			Hashes         map[string]string `json:"hashes"`
			RequiresPython string            `json:"requires-python"`
		} `json:"files"`
	}
	_ = json.Unmarshal(jsonBody, &doc)
	var b strings.Builder
	title := html.EscapeString("Links for " + project)
	b.WriteString("<!DOCTYPE html>\n<html>\n<head><meta name=\"pypi:repository-version\" content=\"1.0\"><title>")
	b.WriteString(title)
	b.WriteString("</title></head>\n<body>\n<h1>")
	b.WriteString(title)
	b.WriteString("</h1>\n")
	for _, f := range doc.Files {
		href := f.URL
		if sha := f.Hashes["sha256"]; sha != "" {
			href += "#sha256=" + sha
		}
		b.WriteString("<a href=\"" + html.EscapeString(href) + "\"")
		if f.RequiresPython != "" {
			b.WriteString(" data-requires-python=\"" + html.EscapeString(f.RequiresPython) + "\"")
		}
		b.WriteString(">" + html.EscapeString(f.Filename) + "</a><br/>\n")
	}
	b.WriteString("</body>\n</html>\n")
	return []byte(b.String())
}

// readBlob loads an artifact's blob fully into memory (index documents only).
func readBlob(ctx context.Context, e *Engine, art meta.Artifact) ([]byte, error) {
	rc, _, err := e.blobs.Open(ctx, art.BlobSHA256)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

// sameHost reports whether u points at the same host as the repository's
// configured upstream URL.
func sameHost(u *url.URL, upstream string) bool {
	up, err := url.Parse(upstream)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Hostname(), up.Hostname())
}

var pypiNormRe = regexp.MustCompile(`[-_.]+`)

// normalizePyPI applies PEP 503 project-name normalization.
func normalizePyPI(name string) string {
	return strings.ToLower(pypiNormRe.ReplaceAllString(name, "-"))
}

// pypiPackageFromFilename best-effort extracts the normalized project name from
// a distribution filename: wheels are name-version(-build)-python-abi-platform.whl
// (name uses underscores per the wheel spec), sdists end the stem with -version.
// PEP 658 .metadata files map to their distribution file. Returns "" when the
// name cannot be derived (the approval gate never blocks on unknown names).
func pypiPackageFromFilename(f string) string {
	if strings.HasSuffix(f, ".metadata") {
		return pypiPackageFromFilename(strings.TrimSuffix(f, ".metadata"))
	}
	switch {
	case strings.HasSuffix(f, ".whl"):
		parts := strings.SplitN(strings.TrimSuffix(f, ".whl"), "-", 3)
		if len(parts) >= 2 {
			return normalizePyPI(parts[0])
		}
	case strings.HasSuffix(f, ".tar.gz"):
		if stem := strings.TrimSuffix(f, ".tar.gz"); strings.LastIndex(stem, "-") > 0 {
			return normalizePyPI(stem[:strings.LastIndex(stem, "-")])
		}
	case strings.HasSuffix(f, ".zip"):
		if stem := strings.TrimSuffix(f, ".zip"); strings.LastIndex(stem, "-") > 0 {
			return normalizePyPI(stem[:strings.LastIndex(stem, "-")])
		}
	}
	return ""
}

// pypiVersion best-effort extracts the version from a distribution filename:
// wheels are name-version(-build)-python-abi-platform.whl, sdists end the stem
// with -version.
func pypiVersion(f string) string {
	switch {
	case strings.HasSuffix(f, ".whl"):
		parts := strings.Split(strings.TrimSuffix(f, ".whl"), "-")
		if len(parts) >= 2 {
			return parts[1]
		}
	case strings.HasSuffix(f, ".tar.gz"):
		stem := strings.TrimSuffix(f, ".tar.gz")
		if i := strings.LastIndex(stem, "-"); i >= 0 {
			return stem[i+1:]
		}
	case strings.HasSuffix(f, ".zip"):
		stem := strings.TrimSuffix(f, ".zip")
		if i := strings.LastIndex(stem, "-"); i >= 0 {
			return stem[i+1:]
		}
	}
	return ""
}
