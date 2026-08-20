package admission

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/argocd"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/engine"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/gate"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/observability"
)

// denyReason is the reason string attached to a denial, visible in the Argo CD
// error toast alongside the message.
const denyReason = "PromotionGateBlocked"

// maxBodyBytes bounds the request body. An AdmissionReview for one Application
// is small; anything larger is not a request this webhook should spend memory
// on.
const maxBodyBytes = 4 << 20

// Handler serves the admission endpoint.
type Handler struct {
	engine  *engine.Engine
	metrics *observability.Metrics
	logger  *slog.Logger
}

// NewHandler builds the admission handler.
func NewHandler(eng *engine.Engine, metrics *observability.Metrics, logger *slog.Logger) *Handler {
	return &Handler{engine: eng, metrics: metrics, logger: logger}
}

// ServeHTTP validates one AdmissionReview.
//
// The webhook registration already narrows traffic to sync requests in gated
// projects, but every condition is re-checked here: a misconfigured
// registration must not be able to turn into a wrong verdict.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	started := time.Now()

	var review ReviewRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(&review); err != nil {
		h.logger.Warn("promotion gate skipped a request it could not read",
			"outcome", "malformed", "reason", "undecodable body", "error", err)
		h.metrics.RecordAdmission("malformed")
		// Failing open on an unreadable body keeps a malformed request from
		// blocking every sync; the gate cannot judge what it cannot read.
		writeJSON(w, h.logger, Allow("", []string{"promotion gate could not decode the AdmissionReview"}))
		return
	}

	if review.Request == nil {
		h.logger.Warn("promotion gate skipped a request it could not read",
			"outcome", "malformed", "reason", "no request in the review")
		h.metrics.RecordAdmission("malformed")
		writeJSON(w, h.logger, Allow("", []string{"promotion gate received an AdmissionReview without a request"}))
		return
	}

	result := h.decide(r.Context(), review.Request)
	h.metrics.RecordAdmission(result.outcome)
	h.log(review.Request, result, time.Since(started))
	writeJSON(w, h.logger, result.response)
}

// result is one verdict plus everything worth writing down about it.
type result struct {
	response ReviewResponse
	// outcome is the metric label: allowed, denied, or skipped.
	outcome string
	// reason is why, in a form that survives grep.
	reason string
	// verdict is nil on the early exits that never reach the rules.
	verdict *gate.Decision
}

// log writes exactly one line per request, whatever happened.
//
// A gate that refuses a deploy has to be able to answer "which application, and
// why" from the logs alone, and the same is true of one that let a deploy
// through. So the allow path is as loud as the deny path, and both name the
// target and the reason. Denials go out at warn because they are what somebody
// will come asking about.
func (h *Handler) log(req *Request, res result, elapsed time.Duration) {
	fields := []any{
		"outcome", res.outcome,
		"reason", res.reason,
		"app", req.Name,
		"namespace", req.Namespace,
		"principal", Username(req),
		"durationMs", elapsed.Milliseconds(),
	}
	if initiator := InitiatedBy(req); initiator != "" {
		fields = append(fields, "initiatedBy", initiator)
	}
	if revision := SyncRevision(req); revision != "" {
		fields = append(fields, "revision", revision)
	}

	if v := res.verdict; v != nil {
		fields = append(fields,
			"env", v.Env,
			"identity", v.Identity,
			"code", string(v.Code),
			"allowed", v.Allowed,
			"message", v.Message,
		)
		if v.Upstream != nil {
			fields = append(fields,
				"upstream", v.Upstream.App,
				"upstreamEnv", v.Upstream.Env,
				"upstreamExists", v.Upstream.Exists,
			)
			if v.Upstream.Exists {
				fields = append(fields,
					"upstreamSync", v.Upstream.SyncStatus,
					"upstreamHealth", v.Upstream.HealthStatus,
				)
			}
		}
		if summary := imageSummary(v.Images); summary != "" {
			fields = append(fields, "images", summary)
		}
		if len(v.Warnings) > 0 {
			fields = append(fields, "warnings", v.Warnings)
		}
	}

	switch res.outcome {
	case "denied":
		h.logger.Warn("promotion gate denied a sync", fields...)
	case "allowed":
		h.logger.Info("promotion gate allowed a sync", fields...)
	default:
		h.logger.Info("promotion gate skipped a request", fields...)
	}
}

// imageSummary compresses the comparison into one field, because a log line is
// read at a glance and a nested structure is not.
func imageSummary(images []gate.ImageComparison) string {
	if len(images) == 0 {
		return ""
	}
	parts := make([]string, 0, len(images))
	for _, image := range images {
		operator := "=="
		if !image.Matched {
			operator = "!="
		}
		parts = append(parts, fmt.Sprintf("%s %s%s%s",
			image.Repository, orDash(image.DesiredTag), operator, orDash(image.UpstreamTag)))
	}
	return strings.Join(parts, " ")
}

func orDash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func (h *Handler) decide(ctx context.Context, req *Request) result {
	uid := req.UID

	if !IsSyncRequest(req) {
		return result{response: Allow(uid, nil), outcome: "skipped", reason: "not a sync request"}
	}

	cfg := h.engine.Config()
	principal := Username(req)
	if slices.Contains(cfg.Exempt.Usernames, principal) {
		return result{response: Allow(uid, nil), outcome: "skipped", reason: "principal is exempt"}
	}

	if cfg.Exempt.Automated && IsAutomated(req) {
		return result{response: Allow(uid, nil), outcome: "skipped", reason: "operation is automated"}
	}

	if req.Object == nil {
		return result{
			response: Allow(uid, []string{"promotion gate could not read the Application object"}),
			outcome:  "allowed",
			reason:   "no object in the request",
		}
	}

	snapshot, err := argocd.SnapshotFromMap(req.Object, cfg.Exempt.Annotation)
	if err != nil {
		return result{
			response: Allow(uid, []string{"promotion gate could not parse the Application object: " + err.Error()}),
			outcome:  "allowed",
			reason:   "unparsable object: " + err.Error(),
		}
	}

	verdict := h.engine.Evaluate(ctx, snapshot)
	if verdict.Code == gate.CodeNotGated {
		return result{
			response: Allow(uid, nil),
			outcome:  "skipped",
			reason:   "environment is not gated",
			verdict:  &verdict,
		}
	}

	if verdict.Allowed {
		return result{
			response: Allow(uid, verdict.Warnings),
			outcome:  "allowed",
			reason:   string(verdict.Code),
			verdict:  &verdict,
		}
	}
	return result{
		response: Deny(uid, denyReason, verdict.Message),
		outcome:  "denied",
		reason:   string(verdict.Code),
		verdict:  &verdict,
	}
}

func writeJSON(w http.ResponseWriter, logger *slog.Logger, response ReviewResponse) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		logger.Error("could not write admission response", "error", err)
	}
}
