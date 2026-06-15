package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

// approvalDTO is the JSON shape for one package approval row.
type approvalDTO struct {
	ID               int64      `json:"id"`
	RepoName         string     `json:"repo_name"`
	Package          string     `json:"package"`
	Status           string     `json:"status"`
	RequestedBy      string     `json:"requested_by"`
	DecidedBy        string     `json:"decided_by"`
	Note             string     `json:"note"`
	RequestCount     int64      `json:"request_count"`
	FirstRequestedAt time.Time  `json:"first_requested_at"`
	LastRequestedAt  time.Time  `json:"last_requested_at"`
	DecidedAt        *time.Time `json:"decided_at"`
}

func approvalToDTO(a meta.PackageApproval) approvalDTO {
	return approvalDTO{
		ID: a.ID, RepoName: a.RepoName, Package: a.Package, Status: a.Status,
		RequestedBy: a.RequestedBy, DecidedBy: a.DecidedBy, Note: a.Note,
		RequestCount: a.RequestCount, FirstRequestedAt: a.FirstRequestedAt,
		LastRequestedAt: a.LastRequestedAt, DecidedAt: a.DecidedAt,
	}
}

// listApprovals returns approval rows, newest first, with optional repo/status
// filters and limit/offset pagination.
func (h *Handler) listApprovals(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	repoName := q.Get("repo")
	status := q.Get("status")
	if status != "" && !validApprovalStatus(status) {
		writeError(w, http.StatusBadRequest, "invalid status (pending|approved|rejected)")
		return
	}
	limit := intParam(q.Get("limit"), 100)
	if limit < 1 || limit > 500 {
		limit = 100
	}
	offset := max(intParam(q.Get("offset"), 0), 0)

	rows, err := h.store.ListApprovals(r.Context(), repoName, status, limit, offset)
	if err != nil {
		mapError(w, err)
		return
	}
	count, err := h.store.CountApprovals(r.Context(), repoName, status)
	if err != nil {
		mapError(w, err)
		return
	}
	out := make([]approvalDTO, 0, len(rows))
	for _, a := range rows {
		out = append(out, approvalToDTO(a))
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count, "approvals": out})
}

// countApprovals returns just the matching row count (sidebar badge).
func (h *Handler) countApprovals(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	if status != "" && !validApprovalStatus(status) {
		writeError(w, http.StatusBadRequest, "invalid status (pending|approved|rejected)")
		return
	}
	count, err := h.store.CountApprovals(r.Context(), r.URL.Query().Get("repo"), status)
	if err != nil {
		mapError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count})
}

type createApprovalReq struct {
	Repo    string `json:"repo"`
	Package string `json:"package"`
	Status  string `json:"status"`
	Note    string `json:"note"`
}

// createApproval records a manual decision for a package that may not have been
// requested yet (pre-approval, or pre-emptive rejection).
func (h *Handler) createApproval(w http.ResponseWriter, r *http.Request) {
	var req createApprovalReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Package = strings.TrimSpace(req.Package)
	if req.Package == "" {
		writeError(w, http.StatusBadRequest, "package is required")
		return
	}
	if req.Status != meta.ApprovalApproved && req.Status != meta.ApprovalRejected {
		writeError(w, http.StatusBadRequest, "status must be approved or rejected")
		return
	}
	repo, err := h.store.GetRepositoryByName(r.Context(), strings.TrimSpace(req.Repo))
	if err != nil {
		mapError(w, err)
		return
	}
	if repo.Type != meta.TypeProxy {
		writeError(w, http.StatusBadRequest, "approval is only valid for proxy repositories")
		return
	}
	if !h.canApprove(w, r, repo.Name) {
		return
	}
	a, err := h.store.UpsertApprovalDecision(r.Context(), repo.Name, req.Package, req.Status, principalName(r), req.Note)
	if err != nil {
		mapError(w, err)
		return
	}
	h.auditApproval(r, a, http.StatusCreated)
	writeJSON(w, http.StatusCreated, approvalToDTO(a))
}

type decideApprovalReq struct {
	Note string `json:"note"`
}

func (h *Handler) approveApproval(w http.ResponseWriter, r *http.Request) {
	h.decideApproval(w, r, meta.ApprovalApproved)
}

func (h *Handler) rejectApproval(w http.ResponseWriter, r *http.Request) {
	h.decideApproval(w, r, meta.ApprovalRejected)
}

// decideApproval flips one approval row to the given status. Re-deciding is
// allowed: approving a rejected package (and vice versa) takes effect on the
// next package request because the gate runs before any cache lookup.
func (h *Handler) decideApproval(w http.ResponseWriter, r *http.Request, status string) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req decideApprovalReq
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&req) // body is optional
	}
	// Resolve the row first: the per-repository permission check needs its repo.
	existing, err := h.store.GetApproval(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	if !h.canApprove(w, r, existing.RepoName) {
		return
	}
	if err := h.store.DecideApproval(r.Context(), id, status, principalName(r), req.Note); err != nil {
		mapError(w, err)
		return
	}
	a, err := h.store.GetApproval(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	h.auditApproval(r, a, http.StatusOK)
	writeJSON(w, http.StatusOK, approvalToDTO(a))
}

// canApprove enforces the per-repository approve permission (admin qualifies
// via admin-implies-all). With authz disabled (tests) it allows everything.
func (h *Handler) canApprove(w http.ResponseWriter, r *http.Request, repoName string) bool {
	if h.authz == nil {
		return true
	}
	p := auth.FromContext(r.Context())
	if p == nil || !p.Can(repoName, auth.ActionApprove) {
		writeError(w, http.StatusForbidden, "approve permission required for repository "+repoName)
		return false
	}
	return true
}

// auditApproval records an approval decision in the repository's audit log,
// with the package name in the path column.
func (h *Handler) auditApproval(r *http.Request, a meta.PackageApproval, status int) {
	event := meta.EventApprovalApprove
	if a.Status == meta.ApprovalRejected {
		event = meta.EventApprovalReject
	}
	h.rec.Record(audit.Event{
		Repo:      a.RepoName,
		Action:    event,
		Path:      a.Package,
		Username:  principalName(r),
		Method:    r.Method,
		Status:    status,
		ClientIP:  audit.ClientIP(r),
		UserAgent: r.UserAgent(),
	})
}

func principalName(r *http.Request) string {
	if p := auth.FromContext(r.Context()); p != nil {
		return p.Username
	}
	return ""
}

func validApprovalStatus(s string) bool {
	return s == meta.ApprovalPending || s == meta.ApprovalApproved || s == meta.ApprovalRejected
}
