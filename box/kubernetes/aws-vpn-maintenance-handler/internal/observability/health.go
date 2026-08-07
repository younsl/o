package observability

import (
	"context"
	"net/http"
	"sync/atomic"
)

// Health tracks readiness and serves the liveness and readiness probes.
type Health struct {
	ready atomic.Bool
	// slackConnected gates readiness on the Socket Mode connection, so a revoked
	// token or blocked egress shows up instead of maintenance piling up unapproved.
	slackConnected atomic.Bool
}

// NewHealth returns a Health that starts not-ready.
func NewHealth() *Health { return &Health{} }

// SetReady flips the readiness state.
func (h *Health) SetReady(ready bool) { h.ready.Store(ready) }

// SetSlackConnected records whether the Socket Mode connection is up.
func (h *Health) SetSlackConnected(connected bool) { h.slackConnected.Store(connected) }

// Serve runs the health server until ctx is cancelled. /healthz always returns 200,
// so a controller waiting for leadership is not restarted; /readyz also requires a
// live approval channel.
func (h *Health) Serve(ctx context.Context, port int) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		switch {
		case !h.ready.Load():
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("not ready"))
		case !h.slackConnected.Load():
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("slack socket mode disconnected"))
		default:
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ready"))
		}
	})
	return serveUntilDone(ctx, port, mux)
}
