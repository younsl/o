package repo

import (
	"net/http"
	"strings"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// handleGo serves the Go module proxy protocol (GOPROXY). Paths under
// /go/{repo}/ mirror the GOPROXY layout:
//
//	<module>/@v/list            list of versions          (metadata)
//	<module>/@v/<version>.info  version metadata + Time   (metadata)
//	<module>/@v/<version>.mod   the go.mod file           (artifact)
//	<module>/@v/<version>.zip   the module zip            (artifact)
//	<module>/@latest            latest version info       (metadata)
func (m *Manager) handleGo(w http.ResponseWriter, r *http.Request) {
	res, ok := m.resolve(w, r, meta.FormatGo)
	if !ok {
		return
	}
	if !m.authorize(w, r, res.repo.Name, actionForMethod(r.Method)) {
		return
	}
	if m.approvalGate(w, r, res, goPackage(res.path), goVersion(res.path)) {
		return
	}
	if m.vulnGate(w, r, res, goPackage(res.path), goVersion(res.path)) {
		return
	}

	switch r.Method {
	case http.MethodGet, http.MethodHead:
		m.engine.serve(w, r, fetchSpec{
			repo:             res.repo,
			cfg:              res.cfg,
			path:             res.path,
			upstreamURL:      joinUpstream(res.repo.UpstreamURL, res.path),
			kind:             goKind(res.path),
			version:          goVersion(res.path),
			contentType:      goContentType(res.path),
			extractPublished: lastModified,
		})
	case http.MethodPut:
		if res.repo.Type != meta.TypeHosted {
			http.Error(w, "uploads are only allowed on local repositories", http.StatusMethodNotAllowed)
			return
		}
		defer r.Body.Close()
		if err := m.engine.put(r.Context(), res.repo, res.path, goVersion(res.path),
			goContentType(res.path), nil, r.Body); err != nil {
			http.Error(w, "store failed", http.StatusInternalServerError)
			return
		}
		m.scanStored(res.repo, res.path)
		w.WriteHeader(http.StatusCreated)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func goKind(p string) kind {
	switch {
	case strings.HasSuffix(p, "/@v/list"), strings.HasSuffix(p, "/@latest"), strings.HasSuffix(p, ".info"):
		return kindMetadata
	default:
		return kindArtifact
	}
}

// goPackage extracts the module path from a GOPROXY protocol path (everything
// before /@v/ or /@latest), keeping the !-escaped form as the canonical key.
func goPackage(p string) string {
	if i := strings.Index(p, "/@v/"); i >= 0 {
		return p[:i]
	}
	if mod, ok := strings.CutSuffix(p, "/@latest"); ok {
		return mod
	}
	return ""
}

func goVersion(p string) string {
	idx := strings.Index(p, "/@v/")
	if idx < 0 {
		return ""
	}
	rest := p[idx+len("/@v/"):]
	for _, ext := range []string{".info", ".mod", ".zip"} {
		if strings.HasSuffix(rest, ext) {
			return strings.TrimSuffix(rest, ext)
		}
	}
	return ""
}

func goContentType(p string) string {
	switch {
	case strings.HasSuffix(p, ".info"), strings.HasSuffix(p, "/@latest"):
		return "application/json"
	case strings.HasSuffix(p, ".mod"):
		return "text/plain; charset=utf-8"
	case strings.HasSuffix(p, ".zip"):
		return "application/zip"
	default:
		return "text/plain; charset=utf-8"
	}
}
