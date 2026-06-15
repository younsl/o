package cluster

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"

	"github.com/younsl/o/box/kubernetes/forklift/internal/config"
)

func testElector(objs ...any) *Elector {
	client := fake.NewSimpleClientset()
	for _, o := range objs {
		switch v := o.(type) {
		case *coordinationv1.Lease:
			client.CoordinationV1().Leases(v.Namespace).Create(context.Background(), v, metav1.CreateOptions{})
		case *corev1.Pod:
			client.CoreV1().Pods(v.Namespace).Create(context.Background(), v, metav1.CreateOptions{})
		}
	}
	cfg := config.HAConfig{LeaseName: "forklift-leader", LeaseNamespace: "tools", Identity: "forklift-1"}
	return NewWithClient(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), client)
}

func TestLeaderIdentity(t *testing.T) {
	ctx := context.Background()

	// No Lease yet: unknown leader, no error.
	e := testElector()
	id, err := e.LeaderIdentity(ctx)
	if err != nil || id != "" {
		t.Fatalf("missing lease: id %q err %v", id, err)
	}

	holder := "forklift-0"
	e = testElector(&coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: "forklift-leader", Namespace: "tools"},
		Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder},
	})
	id, err = e.LeaderIdentity(ctx)
	if err != nil || id != "forklift-0" {
		t.Fatalf("id %q err %v", id, err)
	}

	// Lease without holder.
	e = testElector(&coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: "forklift-leader", Namespace: "tools"},
	})
	id, err = e.LeaderIdentity(ctx)
	if err != nil || id != "" {
		t.Fatalf("holderless lease: id %q err %v", id, err)
	}
}

func TestSetPodRole(t *testing.T) {
	ctx := context.Background()
	e := testElector(&corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name: "forklift-1", Namespace: "tools",
			Labels: map[string]string{RoleLabel: RoleStandby},
		},
	})
	if err := e.SetPodRole(ctx, "tools", "forklift-1", RoleLeader); err != nil {
		t.Fatalf("set role: %v", err)
	}
	pod, err := e.client.CoreV1().Pods("tools").Get(ctx, "forklift-1", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if pod.Labels[RoleLabel] != RoleLeader {
		t.Fatalf("role label = %q", pod.Labels[RoleLabel])
	}

	if err := e.SetPodRole(ctx, "tools", "missing-pod", RoleLeader); err == nil {
		t.Fatal("expected error for missing pod")
	}
}

func TestDemotePeers(t *testing.T) {
	ctx := context.Background()
	pod := func(name, role string) *corev1.Pod {
		return &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
			Name: name, Namespace: "tools",
			Labels: map[string]string{RoleLabel: role},
		}}
	}

	// A stale peer still labeled leader is demoted; self keeps its label.
	e := testElector(pod("forklift-0", RoleLeader), pod("forklift-1", RoleLeader))
	if err := e.DemotePeers(ctx, "tools", "forklift-1"); err != nil {
		t.Fatalf("demote peers: %v", err)
	}
	for name, want := range map[string]string{"forklift-0": RoleStandby, "forklift-1": RoleLeader} {
		p, err := e.client.CoreV1().Pods("tools").Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if p.Labels[RoleLabel] != want {
			t.Fatalf("%s role = %q, want %q", name, p.Labels[RoleLabel], want)
		}
	}

	// Clean failover: only self is labeled leader, nothing to demote.
	e = testElector(pod("forklift-0", RoleStandby), pod("forklift-1", RoleLeader))
	if err := e.DemotePeers(ctx, "tools", "forklift-1"); err != nil {
		t.Fatalf("demote peers (no-op): %v", err)
	}
	p, err := e.client.CoreV1().Pods("tools").Get(ctx, "forklift-0", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if p.Labels[RoleLabel] != RoleStandby {
		t.Fatalf("standby peer role = %q", p.Labels[RoleLabel])
	}
}

func TestDemotePeersSurfacesErrors(t *testing.T) {
	ctx := context.Background()
	e := testElector(&corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: "forklift-0", Namespace: "tools",
		Labels: map[string]string{RoleLabel: RoleLeader},
	}})
	fc := e.client.(*fake.Clientset)

	fc.PrependReactor("patch", "pods", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("patch denied")
	})
	if err := e.DemotePeers(ctx, "tools", "forklift-1"); err == nil {
		t.Fatal("expected error when peer patch fails")
	}

	fc.PrependReactor("list", "pods", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("list denied")
	})
	if err := e.DemotePeers(ctx, "tools", "forklift-1"); err == nil {
		t.Fatal("expected error when pod listing fails")
	}
}
