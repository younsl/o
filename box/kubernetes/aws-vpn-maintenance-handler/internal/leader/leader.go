// Package leader provides single-active-instance leader election backed by a Lease.
//
// A correctness requirement, not an availability nicety: two active replicas could
// each pick a different tunnel of the same connection, both pass preflight against a
// peer the other is about to replace, and take the connection down.
package leader

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
)

// Lease timing, matching the common controller defaults.
const (
	leaseDuration = 15 * time.Second
	renewDeadline = 10 * time.Second
	retryPeriod   = 2 * time.Second
)

// Config parameterizes leader election.
type Config struct {
	// Identity uniquely identifies this candidate; use the Pod name.
	Identity string
	// Namespace holds the Lease; use the Pod namespace.
	Namespace string
	// LeaseName is the Lease shared by all candidates.
	LeaseName string
}

// Run blocks running fn as the elected leader. fn's context is cancelled the moment
// leadership is lost, so the new leader resumes from persisted state instead of two
// controllers narrating the same replacement.
func Run(ctx context.Context, client kubernetes.Interface, cfg Config, logger *slog.Logger, fn func(context.Context)) error {
	if cfg.Identity == "" || cfg.Namespace == "" || cfg.LeaseName == "" {
		return fmt.Errorf("leader election requires identity, namespace, and lease name")
	}

	lock := &resourcelock.LeaseLock{
		LeaseMeta:  metav1.ObjectMeta{Name: cfg.LeaseName, Namespace: cfg.Namespace},
		Client:     client.CoordinationV1(),
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
				logger.Info("acquired leadership, starting reconcile loop", "identity", cfg.Identity)
				fn(ctx)
			},
			OnStoppedLeading: func() {
				logger.Info("lost leadership, stopping reconcile loop", "identity", cfg.Identity)
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
