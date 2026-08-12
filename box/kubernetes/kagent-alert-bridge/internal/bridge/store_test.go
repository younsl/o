package bridge

import (
	"sync"
	"testing"
	"time"
)

func TestStoreSuppressesWithinTTL(t *testing.T) {
	s := newStore(time.Hour)
	now := time.Now()

	if !s.allow("gk", now) {
		t.Fatal("first sighting must be allowed")
	}
	if s.allow("gk", now.Add(59*time.Minute)) {
		t.Error("a repeat inside the TTL must be suppressed")
	}
	if !s.allow("gk", now.Add(time.Hour)) {
		t.Error("a repeat past the TTL must be allowed again")
	}
	if !s.allow("other", now) {
		t.Error("a different key must not be suppressed")
	}
}

func TestStoreDisabledWhenTTLIsZero(t *testing.T) {
	s := newStore(0)
	now := time.Now()

	for range 3 {
		if !s.allow("gk", now) {
			t.Fatal("deduplication must be off when the TTL is zero")
		}
	}
}

func TestStoreForgetAllowsRetry(t *testing.T) {
	s := newStore(time.Hour)
	now := time.Now()

	s.allow("gk", now)
	s.forget("gk")
	if !s.allow("gk", now) {
		t.Error("a forgotten key must be allowed again immediately")
	}
}

// Expired entries have to be dropped, otherwise a long-running bridge holds
// every alert group it ever saw.
func TestStoreExpiresEntries(t *testing.T) {
	s := newStore(time.Minute)
	now := time.Now()

	s.allow("old", now)
	s.allow("fresh", now.Add(time.Minute))

	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.seen["old"]; ok {
		t.Error("expired entry was not collected")
	}
	if _, ok := s.seen["fresh"]; !ok {
		t.Error("live entry was collected")
	}
}

func TestStoreIsConcurrencySafe(t *testing.T) {
	s := newStore(time.Hour)
	now := time.Now()

	var wg sync.WaitGroup
	allowed := make(chan bool, 50)
	for range 50 {
		wg.Go(func() {
			allowed <- s.allow("gk", now)
		})
	}
	wg.Wait()
	close(allowed)

	count := 0
	for ok := range allowed {
		if ok {
			count++
		}
	}
	if count != 1 {
		t.Errorf("%d callers were allowed, want exactly 1", count)
	}
}

func TestSessionStoreReusesAndExpires(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s := newSessionStore(time.Hour)

	if got := s.get("C1/ts", base); got.contextID != "" {
		t.Fatalf("empty store returned %+v", got)
	}
	s.put("C1/ts", session{contextID: "ctx-1"}, base)
	if got := s.get("C1/ts", base.Add(59*time.Minute)); got.contextID != "ctx-1" {
		t.Fatalf("session within the TTL returned %+v", got)
	}
	// A used session keeps living: the idle timer restarts on every turn.
	s.put("C1/ts", session{contextID: "ctx-1"}, base.Add(59*time.Minute))
	if got := s.get("C1/ts", base.Add(90*time.Minute)); got.contextID != "ctx-1" {
		t.Fatalf("refreshed session returned %+v", got)
	}
	if got := s.get("C1/ts", base.Add(5*time.Hour)); got.contextID != "" {
		t.Fatalf("idle session returned %+v, want it dropped", got)
	}
}

func TestSessionStoreEvictsExpiredEntries(t *testing.T) {
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	s := newSessionStore(time.Minute)

	s.put("C1/ts", session{contextID: "ctx-1"}, base)
	s.put("C2/ts", session{contextID: "ctx-2"}, base)
	if got := s.size(); got != 2 {
		t.Fatalf("size = %d, want 2", got)
	}
	// A later write sweeps what has gone idle, so the gauge does not drift up
	// forever in a workspace full of one-off questions.
	s.put("C3/ts", session{contextID: "ctx-3"}, base.Add(2*time.Minute))
	if got := s.size(); got != 1 {
		t.Fatalf("size = %d after the sweep, want 1", got)
	}
}

// A zero TTL turns sessions off entirely, which makes every mention a cold turn.
func TestSessionStoreDisabled(t *testing.T) {
	now := time.Now()
	s := newSessionStore(0)
	s.put("C1/ts", session{contextID: "ctx-1"}, now)
	if got := s.get("C1/ts", now); got.contextID != "" {
		t.Fatalf("disabled store returned %+v", got)
	}
	if got := s.size(); got != 0 {
		t.Fatalf("disabled store holds %d entries", got)
	}
}

// An empty contextId is not a session, so it must not take a slot in the store.
func TestSessionStoreIgnoresEmptyContext(t *testing.T) {
	now := time.Now()
	s := newSessionStore(time.Hour)
	s.put("C1/ts", session{}, now)
	if got := s.size(); got != 0 {
		t.Fatalf("stored an empty context id, size = %d", got)
	}
}
