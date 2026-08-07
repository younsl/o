package recstore

import (
	"testing"
	"time"
)

var base = time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)

func storeAt(now time.Time) *Store {
	s := New()
	s.now = func() time.Time { return now }
	return s
}

func TestLookupFreshAndStale(t *testing.T) {
	s := storeAt(base)
	s.Publish("vol-1", Entry{Action: ActionIncrease, ThroughputMiBps: 250, ObservedAt: base.Add(-30 * time.Minute)})

	if _, ok := s.Lookup("vol-1", time.Hour); !ok {
		t.Error("entry 30m old with 1h maxAge should be returned")
	}
	if _, ok := s.Lookup("vol-1", 10*time.Minute); ok {
		t.Error("entry 30m old with 10m maxAge should be reported absent")
	}
	if _, ok := s.Lookup("vol-absent", time.Hour); ok {
		t.Error("unknown volume should be reported absent")
	}
}

func TestLookupExactBoundaryIsFresh(t *testing.T) {
	s := storeAt(base)
	s.Publish("vol-1", Entry{ObservedAt: base.Add(-time.Hour)})
	if _, ok := s.Lookup("vol-1", time.Hour); !ok {
		t.Error("entry exactly maxAge old should still be returned")
	}
}

func TestPublishOverwrites(t *testing.T) {
	s := storeAt(base)
	s.Publish("vol-1", Entry{ThroughputMiBps: 250, ObservedAt: base})
	s.Publish("vol-1", Entry{ThroughputMiBps: 375, ObservedAt: base})
	e, ok := s.Lookup("vol-1", time.Hour)
	if !ok || e.ThroughputMiBps != 375 {
		t.Errorf("Lookup = (%+v, %v), want the later entry with 375 MiB/s", e, ok)
	}
}

func TestPublishEmptyVolumeIDIsIgnored(t *testing.T) {
	s := storeAt(base)
	s.Publish("", Entry{ObservedAt: base})
	if len(s.entries) != 0 {
		t.Errorf("store holds %d entries after publishing an empty volume ID, want 0", len(s.entries))
	}
}

func TestDelete(t *testing.T) {
	s := storeAt(base)
	s.Publish("vol-1", Entry{ObservedAt: base})
	s.Delete("vol-1")
	if _, ok := s.Lookup("vol-1", time.Hour); ok {
		t.Error("deleted entry should be absent")
	}
	// Deleting an absent entry is a no-op, not a panic.
	s.Delete("vol-absent")
}

func TestRetainSweepsUnlistedVolumes(t *testing.T) {
	s := storeAt(base)
	s.Publish("vol-live", Entry{ObservedAt: base})
	s.Publish("vol-gone", Entry{ObservedAt: base})

	s.Retain(map[string]struct{}{"vol-live": {}})

	if _, ok := s.Lookup("vol-live", time.Hour); !ok {
		t.Error("retained volume should survive the sweep")
	}
	if _, ok := s.Lookup("vol-gone", time.Hour); ok {
		t.Error("unlisted volume should be swept")
	}
}

func TestNodeRefIgnoresAge(t *testing.T) {
	s := storeAt(base)
	// Ancient entry: Lookup refuses it, but the node attachment is still the
	// best known and NodeRef must return it.
	s.Publish("vol-1", Entry{NodeName: "node-1", NodeUID: "uid-1", ObservedAt: base.Add(-48 * time.Hour)})

	if _, ok := s.Lookup("vol-1", time.Hour); ok {
		t.Error("Lookup should refuse the stale entry")
	}
	name, uid, ok := s.NodeRef("vol-1")
	if !ok || name != "node-1" || uid != "uid-1" {
		t.Errorf("NodeRef = (%s, %s, %v), want (node-1, uid-1, true)", name, uid, ok)
	}
}

func TestNodeRefAbsentCases(t *testing.T) {
	s := storeAt(base)
	if _, _, ok := s.NodeRef("vol-absent"); ok {
		t.Error("NodeRef for an unknown volume should report absent")
	}
	s.Publish("vol-anon", Entry{ObservedAt: base})
	if _, _, ok := s.NodeRef("vol-anon"); ok {
		t.Error("NodeRef with an empty NodeName should report absent")
	}
}

func TestRetainNilClearsEverything(t *testing.T) {
	s := storeAt(base)
	s.Publish("vol-1", Entry{ObservedAt: base})
	s.Retain(nil)
	if len(s.entries) != 0 {
		t.Errorf("store holds %d entries after Retain(nil), want 0", len(s.entries))
	}
}
