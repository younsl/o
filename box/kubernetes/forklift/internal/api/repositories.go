package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	repopkg "github.com/younsl/o/box/kubernetes/forklift/internal/repo"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repoconfig"
)

// repositoryDTO is the JSON shape for a repository.
type repositoryDTO struct {
	ID          int64             `json:"id"`
	Name        string            `json:"name"`
	Format      string            `json:"format"`
	Type        string            `json:"type"`
	UpstreamURL string            `json:"upstream_url"`
	Config      repoconfig.Config `json:"config"`
	CreatedAt   time.Time         `json:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at"`
}

func toDTO(r meta.Repository) (repositoryDTO, error) {
	cfg, err := repoconfig.Parse(r.ConfigJSON)
	if err != nil {
		return repositoryDTO{}, err
	}
	return repositoryDTO{
		ID:          r.ID,
		Name:        r.Name,
		Format:      r.Format,
		Type:        r.Type,
		UpstreamURL: r.UpstreamURL,
		Config:      cfg,
		CreatedAt:   r.CreatedAt,
		UpdatedAt:   r.UpdatedAt,
	}, nil
}

// repositoryListItemDTO augments a repository with artifact aggregates for the
// list endpoint (the detail endpoint omits them).
type repositoryListItemDTO struct {
	repositoryDTO
	ArtifactCount int64 `json:"artifact_count"`
	TotalSize     int64 `json:"total_size"`
}

type createRepositoryReq struct {
	Name        string             `json:"name"`
	Format      string             `json:"format"`
	Type        string             `json:"type"`
	UpstreamURL string             `json:"upstream_url"`
	Config      *repoconfig.Config `json:"config"`
}

var validFormats = map[string]bool{
	meta.FormatMaven: true, meta.FormatNPM: true, meta.FormatCargo: true, meta.FormatGo: true,
	meta.FormatPyPI: true,
}

func (h *Handler) listRepositories(w http.ResponseWriter, r *http.Request) {
	repos, err := h.store.ListRepositories(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	stats, err := h.store.AllRepoStats(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	out := make([]repositoryListItemDTO, 0, len(repos))
	for _, repo := range repos {
		dto, err := toDTO(repo)
		if err != nil {
			mapError(w, err)
			return
		}
		st := stats[repo.ID]
		out = append(out, repositoryListItemDTO{
			repositoryDTO: dto,
			ArtifactCount: st.ArtifactCount,
			TotalSize:     st.TotalSize,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// repositoryNameDTO is the slim shape returned to any authenticated user for
// token-scope autocomplete: names only, no config, upstream URLs or stats.
type repositoryNameDTO struct {
	Name   string `json:"name"`
	Format string `json:"format"`
	Type   string `json:"type"`
}

// listRepositoryNames returns repository names so the token-creation UI can
// autocomplete scope patterns. Unlike listRepositories it is available to every
// authenticated user (scoping a token requires knowing the repository names),
// and deliberately exposes no configuration or upstream details.
func (h *Handler) listRepositoryNames(w http.ResponseWriter, r *http.Request) {
	repos, err := h.store.ListRepositories(r.Context())
	if err != nil {
		mapError(w, err)
		return
	}
	out := make([]repositoryNameDTO, 0, len(repos))
	for _, repo := range repos {
		out = append(out, repositoryNameDTO{Name: repo.Name, Format: repo.Format, Type: repo.Type})
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *Handler) createRepository(w http.ResponseWriter, r *http.Request) {
	var req createRepositoryReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if !validName(req.Name) {
		writeError(w, http.StatusBadRequest, "invalid repository name: "+nameRuleMsg)
		return
	}
	if !validFormats[req.Format] {
		writeError(w, http.StatusBadRequest, "invalid format")
		return
	}
	if req.Type != meta.TypeHosted && req.Type != meta.TypeProxy && req.Type != meta.TypeGroup {
		writeError(w, http.StatusBadRequest, "invalid type (hosted|proxy|group)")
		return
	}
	if req.Type == meta.TypeProxy && strings.TrimSpace(req.UpstreamURL) == "" {
		writeError(w, http.StatusBadRequest, "proxy repository requires upstream_url")
		return
	}

	cfg := repoconfig.Default()
	if req.Config != nil {
		cfg = *req.Config
	}
	if err := cfg.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Type == meta.TypeGroup {
		req.UpstreamURL = ""
		if err := repopkg.ValidateGroupMembers(r.Context(), h.store, req.Format, cfg.Group.Members); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	} else if len(cfg.Group.Members) > 0 {
		writeError(w, http.StatusBadRequest, "group members are only valid for group repositories")
		return
	}
	if cfg.Approval.Enabled && req.Type != meta.TypeProxy {
		writeError(w, http.StatusBadRequest, "approval is only valid for proxy repositories")
		return
	}
	cfgJSON, err := cfg.JSON()
	if err != nil {
		mapError(w, err)
		return
	}

	repo, err := h.store.CreateRepository(r.Context(), meta.Repository{
		Name:        req.Name,
		Format:      req.Format,
		Type:        req.Type,
		UpstreamURL: strings.TrimSpace(req.UpstreamURL),
		ConfigJSON:  cfgJSON,
	})
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeError(w, http.StatusConflict, "repository name already exists")
			return
		}
		mapError(w, err)
		return
	}
	dto, err := toDTO(repo)
	if err != nil {
		mapError(w, err)
		return
	}
	h.audit(r, repo.Name, meta.EventRepoCreate, http.StatusCreated)
	writeJSON(w, http.StatusCreated, dto)
}

func (h *Handler) getRepository(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	repo, err := h.store.GetRepository(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	dto, err := toDTO(repo)
	if err != nil {
		mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, dto)
}

type updateRepositoryReq struct {
	UpstreamURL string            `json:"upstream_url"`
	Config      repoconfig.Config `json:"config"`
}

func (h *Handler) updateRepository(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req updateRepositoryReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if err := req.Config.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	existing, err := h.store.GetRepository(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	if existing.Type == meta.TypeGroup {
		if err := repopkg.ValidateGroupMembers(r.Context(), h.store, existing.Format, req.Config.Group.Members); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	} else if len(req.Config.Group.Members) > 0 {
		writeError(w, http.StatusBadRequest, "group members are only valid for group repositories")
		return
	}
	if req.Config.Approval.Enabled && existing.Type != meta.TypeProxy {
		writeError(w, http.StatusBadRequest, "approval is only valid for proxy repositories")
		return
	}
	// PUT replaces the whole resource, so an omitted upstream_url would otherwise
	// zero out a proxy's upstream and silently break it. Mirror createRepository's
	// guard.
	if existing.Type == meta.TypeProxy && strings.TrimSpace(req.UpstreamURL) == "" {
		writeError(w, http.StatusBadRequest, "proxy repository requires upstream_url")
		return
	}
	cfgJSON, err := req.Config.JSON()
	if err != nil {
		mapError(w, err)
		return
	}
	if err := h.store.UpdateRepositoryConfig(r.Context(), id, strings.TrimSpace(req.UpstreamURL), cfgJSON); err != nil {
		mapError(w, err)
		return
	}
	repo, err := h.store.GetRepository(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	dto, err := toDTO(repo)
	if err != nil {
		mapError(w, err)
		return
	}
	h.audit(r, repo.Name, meta.EventRepoUpdate, http.StatusOK)
	writeJSON(w, http.StatusOK, dto)
}

type artifactDTO struct {
	Path           string     `json:"path"`
	Version        string     `json:"version"`
	Size           int64      `json:"size"`
	ContentType    string     `json:"content_type"`
	PublishedAt    *time.Time `json:"published_at"`
	CachedAt       time.Time  `json:"cached_at"`
	LastAccessedAt time.Time  `json:"last_accessed_at"`
}

// listArtifacts returns the artifacts stored (hosted or cached) in a repository,
// powering the Nexus-style artifact browser in the UI.
func (h *Handler) listArtifacts(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	prefix := r.URL.Query().Get("prefix")
	arts, err := h.store.ListRepoArtifacts(r.Context(), id, prefix, 500)
	if err != nil {
		mapError(w, err)
		return
	}
	count, _ := h.store.CountArtifacts(r.Context(), id)
	size, _ := h.store.RepoSize(r.Context(), id)
	out := make([]artifactDTO, 0, len(arts))
	for _, a := range arts {
		out = append(out, artifactDTO{
			Path: a.Path, Version: a.Version, Size: a.Size, ContentType: a.ContentType,
			PublishedAt: a.PublishedAt, CachedAt: a.CachedAt, LastAccessedAt: a.LastAccessedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"count": count, "total_size": size, "artifacts": out,
	})
}

// upstreamHealth probes a proxy repository's upstream with a short timeout. Any
// HTTP response (even 4xx) means the upstream is reachable; only transport
// errors are treated as unreachable.
func (h *Handler) upstreamHealth(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	repo, err := h.store.GetRepository(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	if repo.Type != meta.TypeProxy || repo.UpstreamURL == "" {
		writeJSON(w, http.StatusOK, map[string]any{"applicable": false})
		return
	}

	start := time.Now()
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, repo.UpstreamURL, nil)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"applicable": true, "reachable": false, "error": "bad upstream url"})
		return
	}
	resp, err := h.client.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"applicable": true, "reachable": false, "latency_ms": latency, "error": err.Error(),
		})
		return
	}
	defer resp.Body.Close()
	writeJSON(w, http.StatusOK, map[string]any{
		"applicable": true, "reachable": true, "status": resp.StatusCode, "latency_ms": latency,
	})
}

func (h *Handler) deleteRepository(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	// Resolve the name before deletion so the audit entry can reference it.
	repo, err := h.store.GetRepository(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	if err := h.store.DeleteRepository(r.Context(), id); err != nil {
		mapError(w, err)
		return
	}
	// Approvals and version denies must not outlive the repo: a recreated
	// same-name repo would silently inherit its trust decisions.
	if err := h.store.DeleteApprovalsForRepo(r.Context(), repo.Name); err != nil {
		h.log.Error("delete approvals for repo failed", "repo", repo.Name, "err", err)
	}
	if err := h.store.DeleteVersionDeniesForRepo(r.Context(), repo.Name); err != nil {
		h.log.Error("delete version denies for repo failed", "repo", repo.Name, "err", err)
	}
	h.audit(r, repo.Name, meta.EventRepoDelete, http.StatusNoContent)
	w.WriteHeader(http.StatusNoContent)
}

// auditLogDTO is the JSON shape for one audit log entry.
type auditLogDTO struct {
	ID        int64     `json:"id"`
	Event     string    `json:"event"`
	Path      string    `json:"path"`
	Username  string    `json:"username"`
	Method    string    `json:"method"`
	Status    int       `json:"status"`
	ClientIP  string    `json:"client_ip"`
	UserAgent string    `json:"user_agent"`
	CreatedAt time.Time `json:"created_at"`
}

// listAuditLogs returns a repository's audit log, newest first, with optional
// event filtering and limit/offset pagination.
func (h *Handler) listAuditLogs(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	repo, err := h.store.GetRepository(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}

	q := r.URL.Query()
	event := q.Get("event")
	limit := intParam(q.Get("limit"), 100)
	if limit < 1 || limit > 500 {
		limit = 100
	}
	offset := max(intParam(q.Get("offset"), 0), 0)

	logs, err := h.store.ListAuditLogs(r.Context(), repo.Name, event, limit, offset)
	if err != nil {
		mapError(w, err)
		return
	}
	count, err := h.store.CountAuditLogs(r.Context(), repo.Name, event)
	if err != nil {
		mapError(w, err)
		return
	}
	out := make([]auditLogDTO, 0, len(logs))
	for _, l := range logs {
		out = append(out, auditLogDTO{
			ID: l.ID, Event: l.Event, Path: l.Path, Username: l.Username, Method: l.Method,
			Status: l.Status, ClientIP: l.ClientIP, UserAgent: l.UserAgent, CreatedAt: l.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count, "logs": out})
}

func intParam(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := parseID(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid id")
		return 0, false
	}
	return id, true
}

func parseID(s string) (int64, error) {
	return strconv.ParseInt(s, 10, 64)
}
