// Package recstore is the in-memory hand-off point between the throughput
// recommender and the resizer. The recommender publishes its latest decision
// per volume; the resizer looks a volume up right before modifying it, so an
// increase recommendation can ride along on the same ModifyVolume call (and
// the same once-per-6h modification slot) as a size expansion.
//
// The store is deliberately process-local. Both loops run in the same binary
// under the same leader, so shared memory is the whole persistence this needs:
// a restart empties the store and the next recommender pass refills it, and
// until then the resizer simply falls back to size-only modifications.
package recstore

import (
	"sync"
	"time"
)

// ActionIncrease mirrors throughput.ActionIncrease without importing the
// package: it is the only action a consumer of this store acts on, and this
// package must stay a leaf both subsystems can import.
const ActionIncrease = "increase"

// Entry is one volume's most recent throughput recommendation, as published by
// the recommender.
type Entry struct {
	// NodeName and NodeUID identify the Kubernetes Node the volume was attached
	// to when the recommendation was made, so the consumer can publish Events
	// against the Node and name it in logs.
	NodeName string
	NodeUID  string
	// Action is the recommendation action (increase, decrease, none, unknown).
	// The resizer only ever consumes increase; the rest are stored so a stale
	// increase is overwritten rather than lingering after demand drops.
	Action string
	// ThroughputMiBps and IOPS are the recommended values. IOPS already carries
	// the gp3 throughput-to-IOPS ratio bump computed by the recommender.
	ThroughputMiBps int32
	IOPS            int32
	// CurrentMiBps and CurrentIOPS are the provisioned values at observation
	// time, kept so the consumer can re-check the direction of the change and
	// describe it in human-readable reporting.
	CurrentMiBps int32
	CurrentIOPS  int32
	// ObservedAt is when the recommendation was computed. Lookup uses it to
	// refuse entries older than the caller's freshness bound.
	ObservedAt time.Time
}

// Store holds the latest Entry per volume ID. The zero value is not usable;
// construct with New.
type Store struct {
	mu      sync.Mutex
	entries map[string]Entry
	// now is injectable so tests control the staleness clock.
	now func() time.Time
}

// New returns an empty Store.
func New() *Store {
	return &Store{entries: make(map[string]Entry), now: time.Now}
}

// Publish records the latest recommendation for a volume, replacing any
// previous one.
func (s *Store) Publish(volumeID string, e Entry) {
	if volumeID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[volumeID] = e
}

// Delete removes a volume's entry. The recommender calls it when a volume can
// no longer be evaluated (detached, metrics gone), so a recommendation from a
// past life never outlives the conditions that produced it.
func (s *Store) Delete(volumeID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, volumeID)
}

// Retain drops every entry whose volume ID is not in keep. The recommender
// calls it at the end of each successful pass with the volumes it saw, which is
// what keeps the store from growing without bound under node churn: a
// Karpenter cluster replaces nodes (and their volumes) continuously, and
// without this sweep every terminated node's volume would leave an entry
// behind forever.
func (s *Store) Retain(keep map[string]struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.entries {
		if _, ok := keep[id]; !ok {
			delete(s.entries, id)
		}
	}
}

// Lookup returns the entry for a volume when one exists and its ObservedAt is
// within maxAge of now. A stale entry is reported as absent rather than
// returned with a flag: every caller would otherwise have to remember to check
// it, and a stale recommendation must never be applied.
func (s *Store) Lookup(volumeID string, maxAge time.Duration) (Entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[volumeID]
	if !ok {
		return Entry{}, false
	}
	if s.now().Sub(e.ObservedAt) > maxAge {
		return Entry{}, false
	}
	return e, true
}

// NodeRef returns the Kubernetes Node a volume was last seen attached to.
// Unlike Lookup it ignores the entry's age: node identity is used to address
// Events, not to apply a recommendation, and the attachment does not go stale
// on a recommender hiccup the way a demand estimate does.
func (s *Store) NodeRef(volumeID string) (name, uid string, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, found := s.entries[volumeID]
	if !found || e.NodeName == "" {
		return "", "", false
	}
	return e.NodeName, e.NodeUID, true
}
