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

// sessionStore maps a Slack thread to the A2A contextId its last turn returned,
// so a follow-up mention continues the same agent session instead of starting
// from nothing. It makes the same trade as store: an entry that falls out costs
// one cold turn, not correctness, and a restart drops the whole map.
type sessionStore struct {
	mu      sync.Mutex
	entries map[string]sessionEntry
	ttl     time.Duration
}

type sessionEntry struct {
	contextID string
	usedAt    time.Time
}

func newSessionStore(ttl time.Duration) *sessionStore {
	return &sessionStore{entries: map[string]sessionEntry{}, ttl: ttl}
}

// get returns the contextId held for key, or an empty string when the thread
// has none or has been idle for longer than the TTL.
func (s *sessionStore) get(key string, now time.Time) string {
	if s.ttl <= 0 {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gc(now)
	entry, ok := s.entries[key]
	if !ok || now.Sub(entry.usedAt) >= s.ttl {
		return ""
	}
	return entry.contextID
}

// put records the contextId a turn returned and refreshes the idle timer, so a
// thread that keeps being used keeps its session.
func (s *sessionStore) put(key, contextID string, now time.Time) {
	if s.ttl <= 0 || contextID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.gc(now)
	s.entries[key] = sessionEntry{contextID: contextID, usedAt: now}
}

// size reports how many threads currently hold a session, which is what the
// session gauge publishes.
func (s *sessionStore) size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// gc removes idle sessions. Callers hold the lock.
func (s *sessionStore) gc(now time.Time) {
	for k, entry := range s.entries {
		if now.Sub(entry.usedAt) >= s.ttl {
			delete(s.entries, k)
		}
	}
}
