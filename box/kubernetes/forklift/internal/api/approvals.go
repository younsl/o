package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	repopkg "github.com/younsl/o/box/kubernetes/forklift/internal/repo"
)

// approvalDTO is the JSON shape for one package approval row.
type approvalDTO struct {
	ID                   int64      `json:"id"`
	RepoName             string     `json:"repo_name"`
	Package              string     `json:"package"`
	Status               string     `json:"status"`
	RequestedBy          string     `json:"requested_by"`
	DecidedBy            string     `json:"decided_by"`
	Note                 string     `json:"note"`
	RequestCount         int64      `json:"request_count"`
	LastRequestedVersion string     `json:"last_requested_version"`
	FirstRequestedAt     time.Time  `json:"first_requested_at"`
	LastRequestedAt      time.Time  `json:"last_requested_at"`
	DecidedAt            *time.Time `json:"decided_at"`
	// Vulnerability scan surfaced for the approval decision. VulnScope is
	// "version" when the scan is for the exact requested version, or "package"
	// when the version was unknown and the scan covers the package across all
	// versions. Empty when the coordinate has not been scanned yet.
	VulnSeverity   string              `json:"vuln_severity,omitempty"`
	VulnIDs        []string            `json:"vuln_ids,omitempty"`
	VulnScope      string              `json:"vuln_scope,omitempty"`
	VulnCounts     map[string]int      `json:"vuln_counts,omitempty"`
	VulnAdvisories []meta.VulnAdvisory `json:"vuln_advisories,omitempty"`
	VulnSource     string              `json:"vuln_source,omitempty"`
	VulnScannedAt  *time.Time          `json:"vuln_scanned_at,omitempty"`
	VulnScanMS     int64               `json:"vuln_scan_ms,omitempty"`
	// Reviewers lists usernames permitted to approve this repository. Populated
	// only on the single-approval detail endpoint.
	Reviewers []string `json:"reviewers,omitempty"`
}

func approvalToDTO(a meta.PackageApproval) approvalDTO {
	return approvalDTO{
		ID: a.ID, RepoName: a.RepoName, Package: a.Package, Status: a.Status,
		RequestedBy: a.RequestedBy, DecidedBy: a.DecidedBy, Note: a.Note,
		RequestCount: a.RequestCount, LastRequestedVersion: a.LastRequestedVersion,
		FirstRequestedAt: a.FirstRequestedAt, LastRequestedAt: a.LastRequestedAt, DecidedAt: a.DecidedAt,
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
	// Map repo name -> OSV ecosystem so each approval's last requested version can
	// be annotated with its stored vulnerability scan, if any.
	ecoByRepo := map[string]string{}
	if repos, rerr := h.store.ListRepositories(r.Context()); rerr == nil {
		for _, repo := range repos {
			ecoByRepo[repo.Name] = repopkg.OSVEcosystem(repo.Format)
		}
	}
	out := make([]approvalDTO, 0, len(rows))
	for _, a := range rows {
		dto := approvalToDTO(a)
		h.annotateApprovalVuln(r.Context(), &dto, a, ecoByRepo[a.RepoName])
		out = append(out, dto)
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": count, "approvals": out})
}

// annotateApprovalVuln fills dto's vulnerability fields from the stored scan for
// the approval's coordinate: the exact requested version when known (scope
// "version"), otherwise a package-level scan (scope "package"), so the reviewer
// always has a signal even when the requested version is unknown. A no-op when
// eco is empty (format OSV does not cover) or the coordinate is not scanned yet.
func (h *Handler) annotateApprovalVuln(ctx context.Context, dto *approvalDTO, a meta.PackageApproval, eco string) {
	if eco == "" {
		return
	}
	scope := "version"
	if a.LastRequestedVersion == "" {
		scope = "package"
	}
	if scan, err := h.store.GetVulnScan(ctx, eco, a.Package, a.LastRequestedVersion); err == nil {
		dto.VulnSeverity = scan.MaxSeverity
		dto.VulnIDs = scan.VulnIDs
		dto.VulnScope = scope
		dto.VulnCounts = scan.SeverityCounts
		dto.VulnAdvisories = scan.Advisories
		dto.VulnSource = scan.Source
		dto.VulnScanMS = scan.DurationMS
		t := scan.ScannedAt
		dto.VulnScannedAt = &t
	}
}

// getApproval returns one approval row with its joined vulnerability scan, for
// the approval detail page.
func (h *Handler) getApproval(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	a, err := h.store.GetApproval(r.Context(), id)
	if err != nil {
		mapError(w, err)
		return
	}
	dto := approvalToDTO(a)
	if repo, rerr := h.store.GetRepositoryByName(r.Context(), a.RepoName); rerr == nil {
		h.annotateApprovalVuln(r.Context(), &dto, a, repopkg.OSVEcosystem(repo.Format))
	}
	if h.authz != nil {
		if reviewers, rerr := h.authz.ApproversFor(r.Context(), a.RepoName); rerr == nil {
			dto.Reviewers = reviewers
		}
	}
	writeJSON(w, http.StatusOK, dto)
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

type approveAllReq struct {
	Repo string `json:"repo"`
	Note string `json:"note"`
}

// approveAllPending approves every pending package in one proxy repository.
// Scoped to a single repository so the per-repository approve permission check
// is unambiguous; the response reports how many rows were approved.
func (h *Handler) approveAllPending(w http.ResponseWriter, r *http.Request) {
	var req approveAllReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json body")
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
	approved, err := h.store.ApproveAllPending(r.Context(), repo.Name, principalName(r), req.Note)
	if err != nil {
		mapError(w, err)
		return
	}
	for _, a := range approved {
		h.auditApproval(r, a, http.StatusOK)
	}
	writeJSON(w, http.StatusOK, map[string]any{"approved": len(approved)})
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
