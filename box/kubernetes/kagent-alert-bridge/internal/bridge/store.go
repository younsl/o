package bridge

import (
	"sync"
	"time"
)

// store remembers which alert groups were already analysed so a group that
// Alertmanager resends every repeat_interval does not pay for a new agent run
// each time. It is intentionally in-memory: an entry only has to outlive the
// resend interval, and a restart losing the history costs one extra analysis,
// not correctness.
type store struct {
	mu   sync.Mutex
	seen map[string]time.Time
	ttl  time.Duration
}

func newStore(ttl time.Duration) *store {
	return &store{seen: map[string]time.Time{}, ttl: ttl}
}

// allow reports whether key has not been seen within the TTL, and records it
// when it has not. A non-positive TTL disables deduplication entirely.
func (s *store) allow(key string, now time.Time) bool {
	if s.ttl <= 0 {
		return true
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gc(now)
	if seenAt, ok := s.seen[key]; ok && now.Sub(seenAt) < s.ttl {
		return false
	}
	s.seen[key] = now
	return true
}

// forget drops a key so a failed analysis can be retried on the next resend
// instead of staying suppressed for the whole TTL.
func (s *store) forget(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.seen, key)
}

// size reports how many alert groups are currently suppressed, which is what
// the dedupe gauge publishes. Expired entries linger until the next allow
// sweeps them, so the count can read slightly high between webhooks.
func (s *store) size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.seen)
}

// gc removes expired entries. Callers hold the lock. Sweeping the whole map on
// every insert is fine because the map only ever holds the alert groups seen
// within one TTL window.
func (s *store) gc(now time.Time) {
	for k, seenAt := range s.seen {
		if now.Sub(seenAt) >= s.ttl {
			delete(s.seen, k)
		}
	}
}
