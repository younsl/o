// Package approval routes Slack button clicks to whoever is waiting on them. The
// broker is the authorization boundary: a click only counts if it names an
// outstanding request and comes from a configured approver.
package approval

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
)

// Decision is a resolved approval.
type Decision struct {
	Approved bool
	UserID   string
	UserName string
	At       time.Time
}

// ErrTimeout reports that nobody answered in time. The tunnel is left untouched.
var ErrTimeout = errors.New("approval request timed out")

// Broker tracks outstanding approval requests.
type Broker struct {
	mu      sync.Mutex
	pending map[string]chan Decision
	allowed map[string]bool
	logger  *slog.Logger
}

// New builds a Broker that only accepts decisions from the given Slack user IDs.
func New(allowedUserIDs []string, logger *slog.Logger) *Broker {
	allowed := make(map[string]bool, len(allowedUserIDs))
	for _, id := range allowedUserIDs {
		allowed[id] = true
	}
	return &Broker{
		pending: map[string]chan Decision{},
		allowed: allowed,
		logger:  logger,
	}
}

// Watch registers the request and hands back the channel its decision arrives on,
// plus the release to call when the caller stops listening.
//
// It exists for a caller that does more than block: one re-checking preconditions on a
// ticker cannot express that as repeated short Waits, because each Wait unregisters on
// the way out and a click landing between two of them would be dropped as no longer
// outstanding. Holding one registration across the whole wait is what makes those
// re-checks free of that risk.
func (b *Broker) Watch(requestID string) (<-chan Decision, func()) {
	ch := b.register(requestID)
	return ch, func() { b.unregister(requestID) }
}

// Wait blocks until the request is answered, the timeout expires, or ctx is
// cancelled, returning ErrTimeout on expiry. Registration happens before blocking,
// so an early decision is buffered rather than dropped.
func (b *Broker) Wait(ctx context.Context, requestID string, timeout time.Duration) (Decision, error) {
	ch, release := b.Watch(requestID)
	defer release()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case d := <-ch:
		return d, nil
	case <-timer.C:
		return Decision{}, ErrTimeout
	case <-ctx.Done():
		return Decision{}, ctx.Err()
	}
}

// register creates the delivery channel. The buffer of one keeps Handle from
// blocking on a waiter that has not reached its select yet.
func (b *Broker) register(requestID string) chan Decision {
	b.mu.Lock()
	defer b.mu.Unlock()
	ch := make(chan Decision, 1)
	b.pending[requestID] = ch
	return ch
}

func (b *Broker) unregister(requestID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.pending, requestID)
}

// Pending reports the request IDs awaiting a decision, so the planner skips a
// tunnel already in front of an approver.
func (b *Broker) Pending() map[string]bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make(map[string]bool, len(b.pending))
	for id := range b.pending {
		out[id] = true
	}
	return out
}

// Handle delivers one interaction. It is the Socket Mode callback and must not
// block. Clicks from unconfigured users, or for requests no longer outstanding, are
// logged and dropped; both are normal, since resolved cards stay clickable.
func (b *Broker) Handle(i slackx.Interaction) {
	if !b.allowed[i.UserID] {
		b.logger.Warn("ignoring Slack approval click from an unconfigured user",
			"user_id", i.UserID, "user_name", i.UserName, "request_id", i.RequestID, "approved", i.Approved)
		return
	}

	b.mu.Lock()
	ch, ok := b.pending[i.RequestID]
	if ok {
		delete(b.pending, i.RequestID)
	}
	b.mu.Unlock()

	if !ok {
		b.logger.Info("ignoring Slack approval click for a request that is no longer outstanding",
			"user_id", i.UserID, "request_id", i.RequestID)
		return
	}

	b.logger.Info("received Slack approval decision",
		"user_id", i.UserID, "user_name", i.UserName, "request_id", i.RequestID, "approved", i.Approved)
	ch <- Decision{
		Approved: i.Approved,
		UserID:   i.UserID,
		UserName: i.UserName,
		At:       time.Now().UTC(),
	}
}
