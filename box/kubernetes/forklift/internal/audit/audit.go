// Package audit records per-repository audit events (artifact traffic and
// repository configuration changes) into the metadata store. Writes are
// buffered through a channel and flushed by a background worker so the hot
// request path never blocks on SQLite's single write connection.
package audit

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
)

const bufferSize = 1024

// Event is one auditable occurrence on a repository.
type Event struct {
	Repo      string
	Action    string // meta.Event* constant
	Path      string
	Username  string
	Method    string
	Status    int
	ClientIP  string
	UserAgent string
}

// Recorder asynchronously persists audit events. A nil *Recorder is a valid
// no-op, which keeps call sites unconditional and tests simple.
type Recorder struct {
	store *meta.Store
	log   *slog.Logger
	ch    chan meta.AuditLog
	done  chan struct{}
	now   func() time.Time

	dropped prometheus.Counter
}

// NewRecorder builds a Recorder and starts its background writer.
func NewRecorder(store *meta.Store, log *slog.Logger, reg prometheus.Registerer) *Recorder {
	r := &Recorder{
		store: store,
		log:   log,
		ch:    make(chan meta.AuditLog, bufferSize),
		done:  make(chan struct{}),
		now:   time.Now,
		dropped: prometheus.NewCounter(prometheus.CounterOpts{
			Namespace: "forklift", Name: "audit_events_dropped_total",
			Help: "Audit events dropped because the write buffer was full.",
		}),
	}
	reg.MustRegister(r.dropped)
	go r.run()
	return r
}

// Record enqueues an event without blocking; when the buffer is full the event
// is dropped and counted rather than stalling artifact traffic.
func (r *Recorder) Record(e Event) {
	if r == nil {
		return
	}
	l := meta.AuditLog{
		RepoName:  e.Repo,
		Event:     e.Action,
		Path:      e.Path,
		Username:  e.Username,
		Method:    e.Method,
		Status:    e.Status,
		ClientIP:  e.ClientIP,
		UserAgent: e.UserAgent,
		CreatedAt: r.now(),
	}
	select {
	case r.ch <- l:
	default:
		r.dropped.Inc()
		r.log.Warn("audit event dropped, buffer full", "repo", e.Repo, "event", e.Action)
	}
}

func (r *Recorder) run() {
	defer close(r.done)
	for l := range r.ch {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := r.store.InsertAuditLog(ctx, l); err != nil {
			r.log.Error("audit insert failed", "repo", l.RepoName, "event", l.Event, "err", err)
		}
		cancel()
	}
}

// Close stops accepting events and waits for buffered ones to be written.
func (r *Recorder) Close() {
	if r == nil {
		return
	}
	close(r.ch)
	<-r.done
}

// RunRetention periodically prunes audit log entries older than retention. It
// must be leader-gated by the caller in HA mode (single SQLite writer).
func (r *Recorder) RunRetention(ctx context.Context, interval, retention time.Duration) {
	if r == nil || retention <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		r.pruneOnce(ctx, retention)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *Recorder) pruneOnce(ctx context.Context, retention time.Duration) {
	n, err := r.store.PruneAuditLogs(ctx, r.now().Add(-retention))
	if err != nil {
		if ctx.Err() == nil {
			r.log.Error("audit retention prune failed", "err", err)
		}
		return
	}
	if n > 0 {
		r.log.Info("audit retention pruned entries", "count", n)
	}
}

// ClientIP extracts the originating client IP, preferring the first
// X-Forwarded-For hop (set by the ingress) over the TCP peer address.
func ClientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if first, _, ok := strings.Cut(xff, ","); ok {
			return strings.TrimSpace(first)
		}
		return strings.TrimSpace(xff)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
