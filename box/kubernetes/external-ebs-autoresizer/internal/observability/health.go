package observability

import (
	"context"
	"net/http"
	"sync/atomic"
)

// Health tracks readiness and serves liveness/readiness probes.
type Health struct {
	ready atomic.Bool
}

// NewHealth returns a Health that starts not-ready.
func NewHealth() *Health {
	return &Health{}
}

// SetReady flips the readiness state reported by /readyz.
func (h *Health) SetReady(ready bool) {
	h.ready.Store(ready)
}

// Serve runs the health HTTP server until ctx is cancelled. /healthz always
// returns 200 (liveness); /readyz returns 200 only when ready.
func (h *Health) Serve(ctx context.Context, port int) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if h.ready.Load() {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ready"))
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("not ready"))
	})
	return serveUntilDone(ctx, port, mux)
}
