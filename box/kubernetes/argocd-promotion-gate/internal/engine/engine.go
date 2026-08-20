// Package engine gathers the facts a verdict depends on and delegates the
// verdict itself to the pure rules in the gate package.
//
// Both entry points share it: the admission webhook, which enforces, and the
// UI extension API, which previews. Sharing the engine is what keeps the panel
// in the Argo CD UI from disagreeing with the denial a user gets on Sync.
package engine

import (
	"context"
	"log/slog"

	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/argocd"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/config"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/gate"
	"github.com/younsl/o/box/kubernetes/argocd-promotion-gate/internal/observability"
)

// ImageResolver resolves the images a pending sync would deploy.
type ImageResolver interface {
	DesiredImages(ctx context.Context, app string) ([]gate.ImageRef, error)
}

// Engine evaluates the gate for one Application.
type Engine struct {
	cfg     config.Config
	reader  *argocd.Reader
	images  ImageResolver
	metrics *observability.Metrics
	logger  *slog.Logger
}

// New builds an engine. images may be nil, which disables the image
// comparison regardless of configuration.
func New(cfg config.Config, reader *argocd.Reader, images ImageResolver, metrics *observability.Metrics, logger *slog.Logger) *Engine {
	return &Engine{
		cfg:     cfg,
		reader:  reader,
		images:  images,
		metrics: metrics,
		logger:  logger,
	}
}

// Config exposes the effective configuration.
func (e *Engine) Config() config.Config { return e.cfg }

// Reader exposes the Application reader so callers can resolve an app by name.
func (e *Engine) Reader() *argocd.Reader { return e.reader }

// Evaluate gathers upstream state and desired images, then returns the verdict.
func (e *Engine) Evaluate(ctx context.Context, app gate.AppSnapshot) gate.Decision {
	if !e.cfg.IsGated(app.Project) {
		verdict := gate.NotGated(app.Name, app.Project, app.Identity)
		e.metrics.RecordDecision(verdict)
		return verdict
	}

	upstreamEnv, _ := e.cfg.UpstreamEnv(app.Project)
	upstreamApp := gate.AppNameFor(upstreamEnv, app.Identity)

	in := gate.Input{App: app}

	upstream, err := e.reader.Get(ctx, upstreamApp)
	if err != nil {
		// Reporting a failed read as "upstream missing" would silently open the
		// gate, so it stays a lookup failure and the onError policy decides.
		e.logger.Warn("upstream application lookup failed",
			"app", app.Name, "upstream", upstreamApp, "error", err)
		e.metrics.RecordLookupFailure("upstream")
		in.LookupError = err.Error()
		verdict := gate.WithUpstream(gate.Evaluate(in, e.cfg), upstreamEnv, upstreamApp, nil)
		e.metrics.RecordDecision(verdict)
		return verdict
	}
	in.Upstream = upstream

	// The desired image lookup is the only remote call, so it is skipped
	// whenever the verdict cannot depend on it: an upstream that already fails
	// the sync or health check denies before images matter.
	if e.needsImages(upstream, app) {
		images, err := e.images.DesiredImages(ctx, app.Name)
		if err != nil {
			e.logger.Warn("desired image lookup failed", "app", app.Name, "error", err)
			e.metrics.RecordLookupFailure("desired_images")
			in.LookupError = err.Error()
		} else {
			in.DesiredImages = images
		}
	}

	verdict := gate.WithUpstream(gate.Evaluate(in, e.cfg), upstreamEnv, upstreamApp, upstream)
	e.metrics.RecordDecision(verdict)
	return verdict
}

func (e *Engine) needsImages(upstream *gate.AppSnapshot, app gate.AppSnapshot) bool {
	if !e.cfg.ImageTag.Enabled || e.images == nil || upstream == nil || app.SkipRequested {
		return false
	}
	if e.cfg.Require.Sync && !upstream.IsSynced() {
		return false
	}
	if e.cfg.Require.Health && !upstream.IsHealthy() {
		return false
	}
	return true
}
