package state

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
)

const (
	ns   = "kube-system"
	name = "aws-vpn-maintenance-handler-state"
)

func newStore() (*Store, *fake.Clientset) {
	client := fake.NewSimpleClientset()
	return NewStore(client, ns, name), client
}

func thread() []slackx.MessageRef {
	return []slackx.MessageRef{{ChannelID: "D123", TS: "1750000000.000100"}}
}

// A first run has no ConfigMap yet, which is not an error.
func TestLoadOnAFreshInstall(t *testing.T) {
	store, _ := newStore()

	snap, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if snap.InFlight != nil {
		t.Fatal("a fresh install has no in-flight replacement")
	}
	// Non-nil maps, so callers can index without a nil check.
	if snap.Approvals == nil || snap.Notices == nil || snap.Connections == nil {
		t.Fatal("maps must be initialized")
	}
}

// A notice is remembered so it is sent once per maintenance cycle, and forgotten once
// its maintenance is no longer queued.
func TestNoticeLifecycle(t *testing.T) {
	store, _ := newStore()
	ctx := context.Background()

	const live, finished = "vpn-a|1.1.1.1|100", "vpn-b|3.3.3.3|200"
	sentAt := time.Now().Add(-2 * time.Hour)
	for _, id := range []string{live, finished} {
		if err := store.AddNotice(ctx, id, sentAt); err != nil {
			t.Fatalf("AddNotice(%s) returned error: %v", id, err)
		}
	}

	snap, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snap.Notices) != 2 {
		t.Fatalf("both notices must be recorded, got %v", snap.Notices)
	}
	// UTC, so the record reads the same wherever it is inspected.
	if got := snap.Notices[live]; got.Location() != time.UTC || !got.Equal(sentAt) {
		t.Fatalf("notice time = %s, want %s in UTC", got, sentAt.UTC())
	}

	if err := store.PruneNotices(ctx, map[string]bool{live: true}); err != nil {
		t.Fatalf("PruneNotices returned error: %v", err)
	}
	snap, err = store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if _, ok := snap.Notices[finished]; ok {
		t.Fatal("a notice whose maintenance is gone must be pruned")
	}
	if _, ok := snap.Notices[live]; !ok {
		t.Fatal("pruning must keep the notices still being tracked")
	}
}

// Pruning against nothing live empties the map rather than leaving it to grow.
func TestPruneNoticesWithNothingLive(t *testing.T) {
	store, _ := newStore()
	ctx := context.Background()

	if err := store.AddNotice(ctx, "vpn-a|1.1.1.1|100", time.Now()); err != nil {
		t.Fatalf("AddNotice returned error: %v", err)
	}
	if err := store.PruneNotices(ctx, nil); err != nil {
		t.Fatalf("PruneNotices returned error: %v", err)
	}
	snap, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if len(snap.Notices) != 0 {
		t.Fatalf("no maintenance is queued, so no notice should remain: %v", snap.Notices)
	}
}

func TestSetInFlightCreatesTheConfigMap(t *testing.T) {
	store, client := newStore()
	ctx := context.Background()

	f := InFlight{
		RequestID:    "vpn-a|1.1.1.1|100",
		ConnectionID: "vpn-a",
		TunnelIP:     "1.1.1.1",
		PeerIP:       "2.2.2.2",
		Phase:        PhaseRequested,
		StartedAt:    time.Now().UTC(),
		ApprovedBy:   "U1",
		Thread:       thread(),
	}
	if err := store.SetInFlight(ctx, f); err != nil {
		t.Fatalf("SetInFlight returned error: %v", err)
	}

	cm, err := client.CoreV1().ConfigMaps(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		t.Fatalf("the ConfigMap should have been created: %v", err)
	}
	if _, ok := cm.Data[dataKey]; !ok {
		t.Fatalf("ConfigMap has no %s key", dataKey)
	}

	snap, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if snap.InFlight == nil {
		t.Fatal("in-flight record was not persisted")
	}
	// The thread has to survive: a resumed run must report into the same Slack
	// conversation rather than starting a new one.
	if len(snap.InFlight.Thread) != 1 || snap.InFlight.Thread[0].TS != "1750000000.000100" {
		t.Fatalf("thread refs not round-tripped: %+v", snap.InFlight.Thread)
	}
	if snap.InFlight.ApprovedBy != "U1" {
		t.Fatalf("approver not persisted: %q", snap.InFlight.ApprovedBy)
	}
}

// Recording an in-flight replacement clears its approval, so a restart does not both
// resume the replacement and re-wait for the same approval.
func TestSetInFlightDropsTheMatchingApproval(t *testing.T) {
	store, _ := newStore()
	ctx := context.Background()

	if err := store.AddApproval(ctx, Approval{RequestID: "req-1", PostedAt: time.Now(), Thread: thread()}); err != nil {
		t.Fatalf("AddApproval returned error: %v", err)
	}
	if err := store.SetInFlight(ctx, InFlight{RequestID: "req-1", ConnectionID: "vpn-a", TunnelIP: "1.1.1.1"}); err != nil {
		t.Fatalf("SetInFlight returned error: %v", err)
	}

	snap, err := store.Load(ctx)
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if _, still := snap.Approvals["req-1"]; still {
		t.Fatal("the approval should be gone once the replacement is in flight")
	}
}

func TestSetPhase(t *testing.T) {
	store, _ := newStore()
	ctx := context.Background()

	if err := store.SetInFlight(ctx, InFlight{RequestID: "r", ConnectionID: "vpn-a", Phase: PhaseRequested}); err != nil {
		t.Fatalf("SetInFlight returned error: %v", err)
	}
	if err := store.SetPhase(ctx, PhaseVerifying); err != nil {
		t.Fatalf("SetPhase returned error: %v", err)
	}

	snap, _ := store.Load(ctx)
	if snap.InFlight.Phase != PhaseVerifying {
		t.Fatalf("Phase = %q, want %q", snap.InFlight.Phase, PhaseVerifying)
	}
}

// SetPhase with nothing in flight must not panic or invent a record.
func TestSetPhaseWithNothingInFlight(t *testing.T) {
	store, _ := newStore()
	ctx := context.Background()

	if err := store.SetPhase(ctx, PhaseVerifying); err != nil {
		t.Fatalf("SetPhase returned error: %v", err)
	}
	snap, _ := store.Load(ctx)
	if snap.InFlight != nil {
		t.Fatal("SetPhase must not create an in-flight record")
	}
}

// Clearing in-flight and starting the cooldown happen together, so a crash cannot
// leave a connection free to have its second tunnel replaced immediately.
func TestFinishInFlightClearsAndStartsCooldownTogether(t *testing.T) {
	store, _ := newStore()
	ctx := context.Background()
	at := time.Now().UTC()

	if err := store.SetInFlight(ctx, InFlight{RequestID: "r", ConnectionID: "vpn-a", TunnelIP: "1.1.1.1"}); err != nil {
		t.Fatalf("SetInFlight returned error: %v", err)
	}
	if err := store.FinishInFlight(ctx, "vpn-a", "1.1.1.1", "succeeded", at); err != nil {
		t.Fatalf("FinishInFlight returned error: %v", err)
	}

	snap, _ := store.Load(ctx)
	if snap.InFlight != nil {
		t.Fatal("in-flight should be cleared")
	}
	rec, ok := snap.Connections["vpn-a"]
	if !ok {
		t.Fatal("the connection should have a cooldown record")
	}
	if rec.LastResult != "succeeded" || rec.LastTunnelIP != "1.1.1.1" {
		t.Fatalf("record = %+v", rec)
	}
	if !rec.LastReplacementAt.Equal(at) {
		t.Fatalf("LastReplacementAt = %s, want %s", rec.LastReplacementAt, at)
	}
}

// A failed replacement still starts the cooldown: a connection that just had a bad
// replacement is the last one that should get another.
func TestFinishInFlightStartsCooldownOnFailure(t *testing.T) {
	store, _ := newStore()
	ctx := context.Background()

	if err := store.FinishInFlight(ctx, "vpn-a", "1.1.1.1", "verify_timeout", time.Now()); err != nil {
		t.Fatalf("FinishInFlight returned error: %v", err)
	}
	snap, _ := store.Load(ctx)
	if snap.Connections["vpn-a"].LastReplacementAt.IsZero() {
		t.Fatal("a failed replacement must still start the cooldown")
	}
}

func TestApprovalLifecycle(t *testing.T) {
	store, _ := newStore()
	ctx := context.Background()
	posted := time.Now().UTC()

	if err := store.AddApproval(ctx, Approval{RequestID: "req-1", PostedAt: posted, Thread: thread()}); err != nil {
		t.Fatalf("AddApproval returned error: %v", err)
	}
	snap, _ := store.Load(ctx)
	rec, ok := snap.Approvals["req-1"]
	if !ok {
		t.Fatal("approval was not persisted")
	}
	if !rec.PostedAt.Equal(posted) || len(rec.Thread) != 1 {
		t.Fatalf("approval = %+v", rec)
	}

	if err := store.RemoveApproval(ctx, "req-1"); err != nil {
		t.Fatalf("RemoveApproval returned error: %v", err)
	}
	snap, _ = store.Load(ctx)
	if _, still := snap.Approvals["req-1"]; still {
		t.Fatal("approval should be gone")
	}
}

// Several approvals can be outstanding in the ConfigMap even though only one is
// waited on at a time, so removing one must not disturb the others.
func TestRemoveApprovalLeavesTheOthers(t *testing.T) {
	store, _ := newStore()
	ctx := context.Background()

	for _, id := range []string{"a", "b", "c"} {
		if err := store.AddApproval(ctx, Approval{RequestID: id, PostedAt: time.Now()}); err != nil {
			t.Fatalf("AddApproval(%s) returned error: %v", id, err)
		}
	}
	if err := store.RemoveApproval(ctx, "b"); err != nil {
		t.Fatalf("RemoveApproval returned error: %v", err)
	}

	snap, _ := store.Load(ctx)
	if len(snap.Approvals) != 2 {
		t.Fatalf("expected 2 approvals left, got %+v", snap.Approvals)
	}
}

// An existing ConfigMap owned by someone else, or one whose key was cleared, must not
// crash the controller on startup.
func TestLoadToleratesAnEmptyKey(t *testing.T) {
	client := fake.NewSimpleClientset(&corev1.ConfigMap{
		Name: name, Namespace: ns,
		Data: map[string]string{"unrelated": "value"},
	})
	store := NewStore(client, ns, name)

	snap, err := store.Load(context.Background())
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if snap.InFlight != nil || len(snap.Approvals) != 0 {
		t.Fatalf("expected an empty snapshot, got %+v", snap)
	}
}

// Corrupt state is an error rather than a silent reset: silently forgetting an
// in-flight replacement would leave a tunnel down with nobody watching.
func TestLoadRejectsCorruptState(t *testing.T) {
	client := fake.NewSimpleClientset(&corev1.ConfigMap{
		Name: name, Namespace: ns,
		Data: map[string]string{dataKey: "{not json"},
	})
	store := NewStore(client, ns, name)

	if _, err := store.Load(context.Background()); err == nil {
		t.Fatal("corrupt state must be reported, not silently reset")
	}
}

func TestMutateStampsUpdatedAt(t *testing.T) {
	store, _ := newStore()
	before := time.Now().UTC().Add(-time.Second)

	snap, err := store.Mutate(context.Background(), func(s *Snapshot) {
		s.Connections["vpn-a"] = Connection{LastReplacementAt: time.Now().UTC()}
	})
	if err != nil {
		t.Fatalf("Mutate returned error: %v", err)
	}
	if snap.UpdatedAt.Before(before) {
		t.Fatalf("UpdatedAt = %s, want a fresh timestamp", snap.UpdatedAt)
	}
}
