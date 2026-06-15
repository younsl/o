package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// versionDenyDTO is the JSON shape for one version deny entry.
type versionDenyDTO struct {
	ID        int64     `json:"id"`
	RepoName  string    `json:"repo_name"`
	Package   string    `json:"package"`
	Version   string    `json:"version"`
	Reason    string    `json:"reason"`
	CreatedBy string    `json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
}

func versionDenyToDTO(d meta.VersionDeny) versionDenyDTO {
	return versionDenyDTO{
		ID: d.ID, RepoName: d.RepoName, Package: d.Package, Version: d.Version,
		Reason: d.Reason, CreatedBy: d.CreatedBy, CreatedAt: d.CreatedAt,
	}
}

// listVersionDenies returns deny entries, newest first, with an optional repo
// filter and limit/offset pagination.
func (h *Handler) listVersionDenies(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit := intParam(q.Get("limit"), 100)
	if limit < 1 || limit > 500 {
		limit = 100
	}
	offset := max(intParam(q.Get("offset"), 0), 0)

	rows, err := h.store.ListVersionDenies(r.Context(), q.Get("repo"), limit, offset)
	if err != nil {
		mapError(w, err)
		return
	}
	count, err := h.store.CountVersionDenies(r.Context(), q.Get("repo"))
	if err != nil {
		mapError(w, err)
		return
	}
	out := make([]versionDenyDTO, 0, len(rows))
	for _, d := range rows {
		out = append(out, versionDenyToDTO(d))
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count, "denies": out})
}

type createVersionDenyReq struct {
	Repo    string `json:"repo"`
	Package string `json:"package"`
	Version string `json:"version"`
	Reason  string `json:"reason"`
}

// createVersionDeny blocks one exact (package, version) in a proxy repository.
// The deny takes effect on the next request: the gate runs before any cache
// lookup, so already-cached copies stop being served immediately.
func (h *Handler) createVersionDeny(w http.ResponseWriter, r *http.Request) {
	var req createVersionDenyReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Package = strings.TrimSpace(req.Package)
	req.Version = strings.TrimSpace(req.Version)
	if req.Package == "" || req.Version == "" {
		writeError(w, http.StatusBadRequest, "package and version are required")
		return
	}
	repo, err := h.store.GetRepositoryByName(r.Context(), strings.TrimSpace(req.Repo))
	if err != nil {
		mapError(w, err)
		return
	}
	if repo.Type != meta.TypeProxy {
		writeError(w, http.StatusBadRequest, "version denies are only valid for proxy repositories")
		return
	}
	if !h.canApprove(w, r, repo.Name) {
		return
	}
	d, err := h.store.UpsertVersionDeny(r.Context(), repo.Name, req.Package, req.Version, req.Reason, principalName(r))
	if err != nil {
		mapError(w, err)
		return
	}
	h.auditVersionDeny(r, d, meta.EventDenyCreate, http.StatusCreated)
	writeJSON(w, http.StatusCreated, versionDenyToDTO(d))
}

// deleteVersionDeny removes one deny entry (un-deny). The version goes back
// through the regular approval and age gates on its next request.
func (h *Handler) deleteVersionDeny(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	// Resolve the row first: the per-repository permission check needs its repo.
	d, err := h.store.GetVersionDeny(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	if !h.canApprove(w, r, d.RepoName) {
		return
	}
	if err := h.store.DeleteVersionDeny(r.Context(), id); err != nil {
		mapError(w, err)
		return
	}
	h.auditVersionDeny(r, d, meta.EventDenyDelete, http.StatusNoContent)
	w.WriteHeader(http.StatusNoContent)
}

// auditVersionDeny records a deny list change in the repository's audit log,
// with the package@version coordinate in the path column.
func (h *Handler) auditVersionDeny(r *http.Request, d meta.VersionDeny, event string, status int) {
	h.rec.Record(audit.Event{
		Repo:      d.RepoName,
		Action:    event,
		Path:      d.Package + "@" + d.Version,
		Username:  principalName(r),
		Method:    r.Method,
		Status:    status,
		ClientIP:  audit.ClientIP(r),
		UserAgent: r.UserAgent(),
	})
}
