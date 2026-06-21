package repo

import (
	"net/http"
	"path"
	"strings"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// handleCargo serves the Cargo sparse-registry protocol. Paths under
// /cargo/{repo}/:
//
//	config.json                          registry config (synthesised)
//	<a>/<b>/<crate>                       sparse index entries  (metadata)
//	api/v1/crates/<crate>/<ver>/download  the .crate tarball    (artifact)
//
// config.json is generated to point cargo at this repository's own download
// endpoint so that artifacts are served (and cached/age-gated) through forklift.
func (m *Manager) handleCargo(w http.ResponseWriter, r *http.Request) {
	res, ok := m.resolve(w, r, meta.FormatCargo)
	if !ok {
		return
	}
	if !m.authorize(w, r, res.repo.Name, actionForMethod(r.Method)) {
		return
	}

	if res.path == "config.json" && (r.Method == http.MethodGet || r.Method == http.MethodHead) {
		m.cargoConfig(w, r, res)
		return
	}
	if m.approvalGate(w, r, res, cargoPackage(res.path), cargoVersion(res.path)) {
		return
	}
	if m.vulnGate(w, r, res, cargoPackage(res.path), cargoVersion(res.path)) {
		return
	}

	switch r.Method {
	case http.MethodGet, http.MethodHead:
		m.engine.serve(w, r, fetchSpec{
			repo:             res.repo,
			cfg:              res.cfg,
			path:             res.path,
			upstreamURL:      joinUpstream(res.repo.UpstreamURL, res.path),
			kind:             cargoKind(res.path),
			version:          cargoVersion(res.path),
			contentType:      cargoContentType(res.path),
			extractPublished: lastModified,
		})
	case http.MethodPut:
		if res.repo.Type != meta.TypeHosted {
			http.Error(w, "uploads are only allowed on local repositories", http.StatusMethodNotAllowed)
			return
		}
		defer r.Body.Close()
		if err := m.engine.put(r.Context(), res.repo, res.path, cargoVersion(res.path),
			cargoContentType(res.path), nil, r.Body); err != nil {
			http.Error(w, "store failed", http.StatusInternalServerError)
			return
		}
		m.scanStored(res.repo, res.path)
		w.WriteHeader(http.StatusCreated)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// cargoConfig synthesises the sparse registry config.json, pointing cargo's
// download URL at this repository so .crate fetches flow through forklift.
func (m *Manager) cargoConfig(w http.ResponseWriter, r *http.Request, res resolved) {
	base := m.externalBase(r) + "/cargo/" + res.repo.Name
	w.Header().Set("Content-Type", "application/json")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write([]byte(`{"dl":"` + base + `/api/v1/crates/{crate}/{version}/download","api":"` + base + `"}` + "\n"))
}

func cargoKind(p string) kind {
	// Match "api/v1/crates/" unanchored: the download path arrives repo-relative
	// with the leading slash stripped (resolveRepo), so requiring "/api/v1/..."
	// would misclassify real downloads as metadata. Mirrors cargoPackage.
	if strings.Contains(p, "api/v1/crates/") && strings.HasSuffix(p, "/download") {
		return kindArtifact
	}
	return kindMetadata
}

func cargoVersion(p string) string {
	// .../api/v1/crates/<crate>/<version>/download — matched unanchored so the
	// leading-slash-stripped repo-relative download path also resolves a version.
	if i := strings.Index(p, "api/v1/crates/"); i >= 0 {
		rest := strings.TrimSuffix(p[i+len("api/v1/crates/"):], "/download")
		parts := strings.Split(rest, "/")
		if len(parts) == 2 {
			return parts[1]
		}
	}
	return ""
}

// cargoPackage extracts the crate name from a cargo protocol path: the crate
// segment of a download URL, or the final segment of a sparse-index entry
// (layouts 1/<c>, 2/<cr>, 3/<a>/<crate>, <aa>/<bb>/<crate>). Crate names are
// case-insensitive in the index, so the result is lowercased.
func cargoPackage(p string) string {
	if p == "config.json" {
		return ""
	}
	if i := strings.Index(p, "api/v1/crates/"); i >= 0 {
		crate, _, _ := strings.Cut(p[i+len("api/v1/crates/"):], "/")
		return strings.ToLower(crate)
	}
	return strings.ToLower(path.Base(p))
}

func cargoContentType(p string) string {
	if cargoKind(p) == kindArtifact {
		return "application/gzip"
	}
	return "text/plain; charset=utf-8"
}

// externalBase returns the externally-visible base URL used when synthesising
// URLs in responses. When FORKLIFT_EXTERNAL_URL is configured it is used
// verbatim; otherwise the base is derived from the request, taking
// reverse-proxy headers into account so synthesised URLs are reachable.
// Request-derived values (Host, X-Forwarded-*) are client-controlled, so they
// must never be embedded in cached bodies — metadata is cached in its original
// upstream form and rewritten per request.
func (m *Manager) externalBase(r *http.Request) string {
	if m.externalURL != "" {
		return m.externalURL
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	host := r.Host
	if fwd := r.Header.Get("X-Forwarded-Host"); fwd != "" {
		host = fwd
	}
	return scheme + "://" + host
}
