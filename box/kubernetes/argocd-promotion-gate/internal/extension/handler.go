// Package extension serves the read-only API behind the Argo CD UI extension.
//
// The extension itself only renders; it cannot block a sync. Its value is
// telling someone why the gate will refuse before they press Sync, and it does
// that by asking this endpoint for the same verdict the webhook would return.
package extension

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/engine"
)

// appHeader identifies the Application a proxy-extension request is about,
// formatted as "<namespace>:<name>".
//
// argocd-server does not add this. It requires the caller to send it, uses it
// to authorize the request against Argo CD RBAC, and rejects the call with a
// plain text "Invalid headers" when it is missing. The UI extension supplies it
// from the application it is rendering.
const appHeader = "Argocd-Application-Name"

// Handler serves the gate preview and the effective configuration.
type Handler struct {
	engine *engine.Engine
	logger *slog.Logger
}

// NewHandler builds the extension API handler.
func NewHandler(eng *engine.Engine, logger *slog.Logger) *Handler {
	return &Handler{engine: eng, logger: logger}
}

// Gate returns the verdict for one Application.
func (h *Handler) Gate(w http.ResponseWriter, r *http.Request) {
	appName, ok := AppNameFrom(r)
	if !ok {
		writeJSON(w, h.logger, http.StatusBadRequest, map[string]string{
			"error": "neither the " + appHeader + " header nor an app query parameter was set",
		})
		return
	}

	snapshot, err := h.engine.Reader().Get(r.Context(), appName)
	if err != nil {
		h.logger.Warn("gate preview lookup failed", "app", appName, "error", err)
		writeJSON(w, h.logger, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	if snapshot == nil {
		writeJSON(w, h.logger, http.StatusNotFound, map[string]string{
			"error": "application " + appName + " not found",
		})
		return
	}

	writeJSON(w, h.logger, http.StatusOK, h.engine.Evaluate(r.Context(), *snapshot))
}

// Config publishes the effective promotion chain so the extension can label
// the upstream environment without hardcoding the order.
func (h *Handler) Config(w http.ResponseWriter, r *http.Request) {
	cfg := h.engine.Config()
	writeJSON(w, h.logger, http.StatusOK, map[string]any{
		"chain":           cfg.Chain,
		"gatedEnvs":       cfg.GatedEnvs,
		"requireSync":     cfg.Require.Sync,
		"requireHealth":   cfg.Require.Health,
		"imageTagEnabled": cfg.ImageTag.Enabled,
		"imageTagMode":    string(cfg.ImageTag.Mode),
		"skipAnnotation":  cfg.Exempt.Annotation,
	})
}

// AppNameFrom resolves the Application name from the header the UI extension
// sends, falling back to an explicit query parameter for local debugging and
// for calls that bypass argocd-server.
func AppNameFrom(r *http.Request) (string, bool) {
	if raw := r.Header.Get(appHeader); raw != "" {
		// The header is "<namespace>:<name>"; only the name matters because
		// the reader is already scoped to the Argo CD namespace.
		if _, name, found := strings.Cut(raw, ":"); found {
			raw = name
		}
		if name := strings.TrimSpace(raw); name != "" {
			return name, true
		}
	}
	if name := strings.TrimSpace(r.URL.Query().Get("app")); name != "" {
		return name, true
	}
	return "", false
}

func writeJSON(w http.ResponseWriter, logger *slog.Logger, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		logger.Error("could not write extension response", "error", err)
	}
}
