// Package leader provides single-active-instance leader election backed by a
// coordination.k8s.io Lease. It lets the Deployment run multiple replicas for
// high availability while guaranteeing that only the leader reconciles, which
// avoids concurrent ModifyVolume calls against the same EBS volume.
package leader

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

// Lease timing. These mirror the common controller defaults: the leader renews
// every RetryPeriod and must succeed within RenewDeadline; a standby waits out
// LeaseDuration before taking over.
const (
	leaseDuration = 15 * time.Second
	renewDeadline = 10 * time.Second
	retryPeriod   = 2 * time.Second
)

// Config parameterizes leader election.
type Config struct {
	// Identity uniquely identifies this candidate; use the Pod name.
	Identity string
	// Namespace holds the Lease object; use the Pod namespace.
	Namespace string
	// LeaseName is the Lease object name shared by all candidates.
	LeaseName string
}

// Run blocks running fn as the elected leader. fn receives a context that is
// canceled the moment leadership is lost, so the reconcile loop stops promptly.
// Run returns when the parent ctx is canceled (graceful shutdown releases the
// Lease) or when leadership is lost, allowing the process to restart and
// re-contend.
func Run(ctx context.Context, cfg Config, logger *slog.Logger, fn func(context.Context)) error {
	if cfg.Identity == "" || cfg.Namespace == "" || cfg.LeaseName == "" {
		return fmt.Errorf("leader election requires identity, namespace, and lease name")
	}

	restCfg, err := rest.InClusterConfig()
	if err != nil {
		return fmt.Errorf("in-cluster config: %w", err)
	}
	clientset, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return fmt.Errorf("kubernetes client: %w", err)
	}

	lock := &resourcelock.LeaseLock{
		LeaseMeta:  metav1.ObjectMeta{Name: cfg.LeaseName, Namespace: cfg.Namespace},
		Client:     clientset.CoordinationV1(),
		LockConfig: resourcelock.ResourceLockConfig{Identity: cfg.Identity},
	}

	logger.Info("starting leader election",
		"lease_namespace", cfg.Namespace, "lease_name", cfg.LeaseName, "identity", cfg.Identity)

	leaderelection.RunOrDie(ctx, leaderelection.LeaderElectionConfig{
		Lock:            lock,
		ReleaseOnCancel: true,
		LeaseDuration:   leaseDuration,
		RenewDeadline:   renewDeadline,
		RetryPeriod:     retryPeriod,
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: func(ctx context.Context) {
				logger.Info("acquired leadership, starting reconcile loop",
					"lease_namespace", cfg.Namespace, "lease_name", cfg.LeaseName, "identity", cfg.Identity)
				fn(ctx)
			},
			OnStoppedLeading: func() {
				logger.Info("lost leadership, stopping reconcile loop",
					"lease_namespace", cfg.Namespace, "lease_name", cfg.LeaseName, "identity", cfg.Identity)
			},
			OnNewLeader: func(identity string) {
				if identity != cfg.Identity {
					logger.Info("observed leader", "leader", identity)
				}
			},
		},
	})
	return nil
}
