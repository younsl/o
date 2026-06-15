package cluster

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"

	"github.com/younsl/o/box/kubernetes/forklift/internal/config"
)

// RoleLabel is patched onto pods in replication mode so the main Service can
// select the leader. With per-pod volumes every replica must stay Ready (a
// StatefulSet rollout waits on readiness), so readiness can no longer encode
// leadership; the label takes over traffic routing instead.
const RoleLabel = "forklift.io/role"

// Role label values.
const (
	RoleLeader  = "leader"
	RoleStandby = "standby"
)

// NewWithClient builds an Elector with an injected Kubernetes client (tests).
func NewWithClient(cfg config.HAConfig, log *slog.Logger, client kubernetes.Interface) *Elector {
	return &Elector{cfg: cfg, log: log, client: client}
}

// SetPodRole patches this pod's role label. The leader sets "leader" on
// promotion and "standby" on demotion; the pod template default is "standby"
// so restarted pods start unlabeled as leader.
func (e *Elector) SetPodRole(ctx context.Context, namespace, name, role string) error {
	patch := fmt.Sprintf(`{"metadata":{"labels":{%q:%q}}}`, RoleLabel, role)
	_, err := e.client.CoreV1().Pods(namespace).Patch(ctx, name,
		types.StrategicMergePatchType, []byte(patch), metav1.PatchOptions{})
	if err != nil {
		return fmt.Errorf("patch pod role label: %w", err)
	}
	return nil
}

// DemotePeers patches role=standby onto every pod still labeled leader except
// self. A new leader calls this after labeling itself: a former leader that
// was demoted because it lost the API server typically cannot remove its own
// label, and until someone does, the Service would split traffic between the
// stale pod and the new leader.
func (e *Elector) DemotePeers(ctx context.Context, namespace, self string) error {
	pods, err := e.client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
		LabelSelector: RoleLabel + "=" + RoleLeader,
	})
	if err != nil {
		return fmt.Errorf("list leader pods: %w", err)
	}
	var errs []error
	for _, p := range pods.Items {
		if p.Name == self {
			continue
		}
		if err := e.SetPodRole(ctx, namespace, p.Name, RoleStandby); err != nil {
			errs = append(errs, err)
		} else {
			e.log.Warn("demoted stale leader label on peer", "pod", p.Name)
		}
	}
	return errors.Join(errs...)
}
