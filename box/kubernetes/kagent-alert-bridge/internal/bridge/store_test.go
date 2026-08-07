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
		wg.Add(1)
		go func() {
			defer wg.Done()
			allowed <- s.allow("gk", now)
		}()
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
