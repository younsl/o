package repo

import (
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// handleMaven serves the Maven repository layout, which Gradle also consumes
// (Gradle Module Metadata .module files are ordinary artifacts here). Artifacts
// live at <group-path>/<artifact>/<version>/<file>; maven-metadata.xml documents
// are mutable indexes revalidated on the metadata TTL.
func (m *Manager) handleMaven(w http.ResponseWriter, r *http.Request) {
	res, ok := m.resolve(w, r, meta.FormatMaven)
	if !ok {
		return
	}
	if !m.authorize(w, r, res.repo.Name, actionForMethod(r.Method)) {
		return
	}
	if m.approvalGate(w, r, res, mavenPackage(res.path), mavenVersion(res.path)) {
		return
	}
	if m.vulnGate(w, r, res, mavenPackage(res.path), mavenVersion(res.path)) {
		return
	}

	switch r.Method {
	case http.MethodGet, http.MethodHead:
		m.engine.serve(w, r, fetchSpec{
			repo:             res.repo,
			cfg:              res.cfg,
			path:             res.path,
			upstreamURL:      joinUpstream(res.repo.UpstreamURL, res.path),
			kind:             mavenKind(res.path),
			version:          mavenVersion(res.path),
			contentType:      mavenContentType(res.path),
			extractPublished: lastModified,
		})
	case http.MethodPut:
		if res.repo.Type != meta.TypeHosted {
			http.Error(w, "uploads are only allowed on local repositories", http.StatusMethodNotAllowed)
			return
		}
		defer r.Body.Close()
		if err := m.engine.put(r.Context(), res.repo, res.path, mavenVersion(res.path),
			mavenContentType(res.path), nil, r.Body); err != nil {
			http.Error(w, "store failed", http.StatusInternalServerError)
			return
		}
		m.scanStored(res.repo, res.path)
		w.WriteHeader(http.StatusCreated)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// mavenKind classifies maven-metadata.xml (and its checksums) as mutable
// metadata; everything else is an immutable artifact.
func mavenKind(p string) kind {
	if strings.HasPrefix(path.Base(p), "maven-metadata.xml") {
		return kindMetadata
	}
	return kindArtifact
}

// mavenVersion best-effort extracts the version directory from an artifact path.
func mavenVersion(p string) string {
	if mavenKind(p) == kindMetadata {
		return ""
	}
	parts := strings.Split(p, "/")
	if len(parts) >= 2 {
		return parts[len(parts)-2]
	}
	return ""
}

// mavenPackage heuristically extracts the group:artifact coordinate from a
// repository path. Artifacts live at <group-path>/<artifact>/<version>/<file>;
// maven-metadata.xml sits at the artifact level, or inside a -SNAPSHOT version
// directory. Returns "" when too few segments remain (never block on unknown).
func mavenPackage(p string) string {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if strings.HasPrefix(path.Base(p), "maven-metadata.xml") {
		parts = parts[:len(parts)-1]
		if len(parts) > 0 && strings.HasSuffix(parts[len(parts)-1], "-SNAPSHOT") {
			parts = parts[:len(parts)-1]
		}
	} else if len(parts) >= 2 {
		parts = parts[:len(parts)-2]
	} else {
		return ""
	}
	if len(parts) < 2 {
		return ""
	}
	return strings.Join(parts[:len(parts)-1], ".") + ":" + parts[len(parts)-1]
}

func mavenContentType(p string) string {
	switch {
	case strings.HasSuffix(p, ".xml"), strings.HasSuffix(p, ".pom"):
		return "application/xml"
	case strings.HasSuffix(p, ".jar"), strings.HasSuffix(p, ".war"):
		return "application/java-archive"
	case strings.HasSuffix(p, ".module"), strings.HasSuffix(p, ".json"):
		return "application/json"
	case strings.HasSuffix(p, ".sha1"), strings.HasSuffix(p, ".md5"),
		strings.HasSuffix(p, ".sha256"), strings.HasSuffix(p, ".sha512"):
		return "text/plain"
	default:
		return "application/octet-stream"
	}
}

// lastModified parses the upstream Last-Modified header into a release time for
// the age policy. Maven artifacts carry no per-version timestamp natively, so
// the upstream file mtime is the best available signal.
func lastModified(resp *http.Response) *time.Time {
	v := resp.Header.Get("Last-Modified")
	if v == "" {
		return nil
	}
	t, err := http.ParseTime(v)
	if err != nil {
		return nil
	}
	return &t
}
