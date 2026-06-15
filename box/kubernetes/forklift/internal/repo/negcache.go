package repo

import (
	"sync"
	"time"
)

// negCache is a small in-memory negative (404) cache keyed by repo-relative
// path. It bounds upstream round-trips for missing artifacts. Entries are not
// shared across replicas, which is acceptable: a stale negative entry only
// causes one extra upstream fetch after failover.
type negCache struct {
	mu      sync.Mutex
	entries map[string]time.Time
	now     func() time.Time
}

func newNegCache() *negCache {
	return &negCache{entries: map[string]time.Time{}, now: time.Now}
}

func (c *negCache) has(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	exp, ok := c.entries[key]
	if !ok {
		return false
	}
	if c.now().After(exp) {
		delete(c.entries, key)
		return false
	}
	return true
}

func (c *negCache) set(key string, ttl time.Duration) {
	if ttl <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = c.now().Add(ttl)
}

func (c *negCache) clear(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}
