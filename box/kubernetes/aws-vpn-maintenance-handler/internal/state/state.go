// Package state persists the controller's memory in a ConfigMap, so no
// PersistentVolume is needed. Three facts must survive a restart: a running
// replacement, which still needs verifying and reporting, the per-connection cooldown,
// which otherwise re-arms a connection that was just replaced, and which maintenance
// the approvers have already been notified about, which otherwise gets announced again
// on every restart.
package state

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/util/retry"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
)

// dataKey is the ConfigMap key holding the serialized snapshot.
const dataKey = "state.json"

// Phase is where an in-flight replacement had got to when it was last recorded.
type Phase string

const (
	// PhaseRequested: the AWS call is about to be made, or was made with an
	// unknown result. A restart here must not assume it did not happen.
	PhaseRequested Phase = "requested"
	// PhaseVerifying: accepted, and the tunnel is being watched.
	PhaseVerifying Phase = "verifying"
	// PhaseWaiting: nothing is in flight at AWS. One tunnel of an approved run is
	// done and the next is waiting for the replaced one to become a peer worth
	// failing over to. The record exists so a restart in that gap finishes the run
	// the approver was told about, instead of leaving the connection half done.
	PhaseWaiting Phase = "waiting"
)

// InFlight describes the single replacement currently in progress. There is at
// most one across all managed connections.
type InFlight struct {
	RequestID    string    `json:"requestID"`
	ConnectionID string    `json:"connectionID"`
	TunnelIP     string    `json:"tunnelIP"`
	PeerIP       string    `json:"peerIP"`
	Phase        Phase     `json:"phase"`
	StartedAt    time.Time `json:"startedAt"`
	// RunStartedAt is when the whole approved run began, which is earlier than
	// StartedAt for every tunnel after the first. Persisted so the closing report of a
	// run that outlived a rollout still states how long the connection really took,
	// rather than how long the surviving process happened to be watching.
	RunStartedAt time.Time `json:"runStartedAt,omitzero"`
	// ApprovedBy is the Slack user who authorized this replacement.
	ApprovedBy string `json:"approvedBy,omitempty"`
	// Thread is where progress goes, so a resumed run keeps reporting into the
	// same Slack conversation.
	Thread []slackx.MessageRef `json:"thread,omitempty"`
	// Queue holds the connection's remaining tunnels, still covered by the same
	// approval. Persisting it is what lets a restart continue the chain instead of
	// stopping halfway through a connection with one tunnel replaced and one not.
	Queue []string `json:"queue,omitempty"`
	// Done counts the tunnels already replaced under this approval. It is what keeps
	// "Step 2 of 2" reading the same after a restart as it did before one. The total
	// needs no field: it is Done plus this tunnel plus the queue.
	Done int `json:"done,omitempty"`
}

// TunnelIP means different things by phase: the tunnel being replaced in requested
// and verifying, the tunnel about to be replaced in waiting.

// Approval is an outstanding approval request waiting on a human.
type Approval struct {
	RequestID string              `json:"requestID"`
	PostedAt  time.Time           `json:"postedAt"`
	Thread    []slackx.MessageRef `json:"thread,omitempty"`
}

// Connection is the replacement history of one VPN connection.
type Connection struct {
	// LastReplacementAt starts the cooldown. A failed attempt sets it too.
	LastReplacementAt time.Time `json:"lastReplacementAt"`
	LastTunnelIP      string    `json:"lastTunnelIP,omitempty"`
	LastResult        string    `json:"lastResult,omitempty"`
}

// Snapshot is the whole persisted state.
type Snapshot struct {
	InFlight *InFlight `json:"inFlight,omitempty"`
	// Approvals is keyed by request ID.
	Approvals map[string]Approval `json:"approvals,omitempty"`
	// Notices records when the approvers were first told about a request ID, so the
	// detection notice is sent once per maintenance cycle rather than every pass.
	// The request ID carries the AWS deadline, so newly queued work is a new key and
	// gets its own notice without anything having to expire this one.
	Notices map[string]time.Time `json:"notices,omitempty"`
	// Connections is keyed by VPN connection ID.
	Connections map[string]Connection `json:"connections,omitempty"`
	UpdatedAt   time.Time             `json:"updatedAt"`
}

// Store reads and writes the snapshot in a ConfigMap.
type Store struct {
	client    kubernetes.Interface
	namespace string
	name      string
}

// NewStore builds a Store for the named ConfigMap.
func NewStore(client kubernetes.Interface, namespace, name string) *Store {
	return &Store{client: client, namespace: namespace, name: name}
}

// Load reads the snapshot, returning an empty one when the ConfigMap or its key
// does not exist yet. A first run is not an error.
func (s *Store) Load(ctx context.Context) (Snapshot, error) {
	cm, err := s.client.CoreV1().ConfigMaps(s.namespace).Get(ctx, s.name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return emptySnapshot(), nil
	}
	if err != nil {
		return Snapshot{}, fmt.Errorf("get state configmap %s/%s: %w", s.namespace, s.name, err)
	}
	return decode(cm)
}

// Mutate applies fn to the current snapshot and persists it, retrying on conflict
// so a racing write cannot silently drop the in-flight record.
func (s *Store) Mutate(ctx context.Context, fn func(*Snapshot)) (Snapshot, error) {
	var result Snapshot
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		cm, err := s.client.CoreV1().ConfigMaps(s.namespace).Get(ctx, s.name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			snap := emptySnapshot()
			fn(&snap)
			snap.UpdatedAt = time.Now().UTC()
			encoded, err := encode(snap)
			if err != nil {
				return err
			}
			_, err = s.client.CoreV1().ConfigMaps(s.namespace).Create(ctx, &corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{Name: s.name, Namespace: s.namespace},
				Data:       map[string]string{dataKey: encoded},
			}, metav1.CreateOptions{})
			if err != nil {
				return fmt.Errorf("create state configmap %s/%s: %w", s.namespace, s.name, err)
			}
			result = snap
			return nil
		}
		if err != nil {
			return fmt.Errorf("get state configmap %s/%s: %w", s.namespace, s.name, err)
		}

		snap, err := decode(cm)
		if err != nil {
			return err
		}
		fn(&snap)
		snap.UpdatedAt = time.Now().UTC()
		encoded, err := encode(snap)
		if err != nil {
			return err
		}
		if cm.Data == nil {
			cm.Data = map[string]string{}
		}
		cm.Data[dataKey] = encoded
		if _, err := s.client.CoreV1().ConfigMaps(s.namespace).Update(ctx, cm, metav1.UpdateOptions{}); err != nil {
			return err
		}
		result = snap
		return nil
	})
	if err != nil {
		return Snapshot{}, fmt.Errorf("update state configmap %s/%s: %w", s.namespace, s.name, err)
	}
	return result, nil
}

// SetInFlight records the start of a replacement, before the AWS call. A crash
// between the two then leaves state saying one may have started, so the
// controller verifies instead of issuing a second.
func (s *Store) SetInFlight(ctx context.Context, f InFlight) error {
	_, err := s.Mutate(ctx, func(snap *Snapshot) {
		copied := f
		snap.InFlight = &copied
		delete(snap.Approvals, f.RequestID)
	})
	return err
}

// SetPhase advances the phase of the in-flight replacement.
func (s *Store) SetPhase(ctx context.Context, phase Phase) error {
	_, err := s.Mutate(ctx, func(snap *Snapshot) {
		if snap.InFlight != nil {
			snap.InFlight.Phase = phase
		}
	})
	return err
}

// FinishInFlight clears the in-flight record and starts the cooldown in one write,
// so a crash cannot leave no in-flight and no cooldown.
func (s *Store) FinishInFlight(ctx context.Context, connectionID, tunnelIP, result string, at time.Time) error {
	_, err := s.Mutate(ctx, func(snap *Snapshot) {
		snap.InFlight = nil
		if snap.Connections == nil {
			snap.Connections = map[string]Connection{}
		}
		snap.Connections[connectionID] = Connection{
			LastReplacementAt: at.UTC(),
			LastTunnelIP:      tunnelIP,
			LastResult:        result,
		}
	})
	return err
}

// AdvanceChain finishes one tunnel of an approved run and records the next in a
// single write: the cooldown for what was just replaced, and the waiting record for
// what comes next. Two writes could leave a crash between them with a replaced tunnel
// and no memory of the rest of the run.
func (s *Store) AdvanceChain(ctx context.Context, connectionID, tunnelIP, result string, at time.Time, next InFlight) error {
	_, err := s.Mutate(ctx, func(snap *Snapshot) {
		copied := next
		snap.InFlight = &copied
		if snap.Connections == nil {
			snap.Connections = map[string]Connection{}
		}
		snap.Connections[connectionID] = Connection{
			LastReplacementAt: at.UTC(),
			LastTunnelIP:      tunnelIP,
			LastResult:        result,
		}
	})
	return err
}

// ClearInFlight drops the record without touching the cooldown, for a run that ends
// between tunnels. The cooldown was already written when the previous tunnel finished,
// and rewriting it here would move it forward for a replacement that never happened.
func (s *Store) ClearInFlight(ctx context.Context) error {
	_, err := s.Mutate(ctx, func(snap *Snapshot) { snap.InFlight = nil })
	return err
}

// AddApproval records an outstanding approval request.
func (s *Store) AddApproval(ctx context.Context, a Approval) error {
	_, err := s.Mutate(ctx, func(snap *Snapshot) {
		if snap.Approvals == nil {
			snap.Approvals = map[string]Approval{}
		}
		snap.Approvals[a.RequestID] = a
	})
	return err
}

// RemoveApproval drops an approval request that was answered or expired.
func (s *Store) RemoveApproval(ctx context.Context, requestID string) error {
	_, err := s.Mutate(ctx, func(snap *Snapshot) {
		delete(snap.Approvals, requestID)
	})
	return err
}

// AddNotice records that the approvers have been told about requestID. Storing it is
// what makes the notice once-per-cycle across restarts and leader handovers, where an
// in-memory set would send it again.
func (s *Store) AddNotice(ctx context.Context, requestID string, at time.Time) error {
	_, err := s.Mutate(ctx, func(snap *Snapshot) {
		if snap.Notices == nil {
			snap.Notices = map[string]time.Time{}
		}
		snap.Notices[requestID] = at.UTC()
	})
	return err
}

// PruneNotices drops every notice whose request ID is no longer among the tunnels AWS
// reports maintenance for, so the ConfigMap does not grow one entry per cycle forever.
//
// Keyed on what the latest pass saw rather than on age: a notice matters only for as
// long as its maintenance is still queued, and the deadline embedded in the request ID
// is not a reliable expiry because AWS may move it.
func (s *Store) PruneNotices(ctx context.Context, live map[string]bool) error {
	_, err := s.Mutate(ctx, func(snap *Snapshot) {
		for id := range snap.Notices {
			if !live[id] {
				delete(snap.Notices, id)
			}
		}
	})
	return err
}

func emptySnapshot() Snapshot {
	return Snapshot{
		Approvals:   map[string]Approval{},
		Notices:     map[string]time.Time{},
		Connections: map[string]Connection{},
	}
}

func decode(cm *corev1.ConfigMap) (Snapshot, error) {
	raw, ok := cm.Data[dataKey]
	if !ok || raw == "" {
		return emptySnapshot(), nil
	}
	var snap Snapshot
	if err := json.Unmarshal([]byte(raw), &snap); err != nil {
		return Snapshot{}, fmt.Errorf("decode %s from configmap %s/%s: %w", dataKey, cm.Namespace, cm.Name, err)
	}
	if snap.Approvals == nil {
		snap.Approvals = map[string]Approval{}
	}
	if snap.Notices == nil {
		snap.Notices = map[string]time.Time{}
	}
	if snap.Connections == nil {
		snap.Connections = map[string]Connection{}
	}
	return snap, nil
}

func encode(snap Snapshot) (string, error) {
	// Indented so `kubectl get cm -o yaml` stays readable.
	b, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode state: %w", err)
	}
	return string(b), nil
}
