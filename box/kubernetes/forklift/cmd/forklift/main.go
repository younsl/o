// Command forklift is a lightweight, Kubernetes-native artifact repository.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/go-chi/chi/v5"

	"github.com/younsl/o/box/kubernetes/forklift/internal/api"
	"github.com/younsl/o/box/kubernetes/forklift/internal/audit"
	"github.com/younsl/o/box/kubernetes/forklift/internal/auth"
	"github.com/younsl/o/box/kubernetes/forklift/internal/cluster"
	"github.com/younsl/o/box/kubernetes/forklift/internal/config"
	"github.com/younsl/o/box/kubernetes/forklift/internal/meta"
	"github.com/younsl/o/box/kubernetes/forklift/internal/openapi"
	"github.com/younsl/o/box/kubernetes/forklift/internal/replication"
	"github.com/younsl/o/box/kubernetes/forklift/internal/repo"
	"github.com/younsl/o/box/kubernetes/forklift/internal/server"
	"github.com/younsl/o/box/kubernetes/forklift/internal/storage"
	"github.com/younsl/o/box/kubernetes/forklift/internal/version"
	"github.com/younsl/o/box/kubernetes/forklift/internal/webui"
)

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("forklift", version.String())
		return
	}

	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log := newLogger(cfg)
	log.Info("starting forklift", "version", version.String(), "data_dir", cfg.DataDir)

	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return fmt.Errorf("create data dir: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	store, err := meta.Open(ctx, filepath.Join(cfg.DataDir, "forklift.db"))
	if err != nil {
		return fmt.Errorf("open metadata store: %w", err)
	}
	defer store.Close()

	blobs, err := storage.NewFSStore(cfg.DataDir)
	if err != nil {
		return fmt.Errorf("open blob store: %w", err)
	}

	reg := prometheus.NewRegistry()
	reg.MustRegister(prometheus.NewGoCollector(), prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))

	// Auth: optional Keycloak OIDC plus local users and PATs.
	var oidcProvider *auth.OIDCProvider
	if cfg.Auth.OIDC.Enabled {
		oidcProvider, err = auth.NewOIDC(ctx, auth.OIDCParams{
			IssuerURL:     cfg.Auth.OIDC.IssuerURL,
			ClientID:      cfg.Auth.OIDC.ClientID,
			ClientSecret:  cfg.Auth.OIDC.ClientSecret,
			RedirectURL:   cfg.Auth.OIDC.RedirectURL,
			UsernameClaim: cfg.Auth.OIDC.UsernameClaim,
			GroupsClaim:   cfg.Auth.OIDC.GroupsClaim,
		})
		if err != nil {
			log.Error("OIDC init failed; continuing without OIDC login", "err", err)
			oidcProvider = nil
		}
	}
	authSvc := auth.NewService(store, log, auth.Options{
		SessionSecret: []byte(cfg.Auth.SessionSecret),
		SessionTTL:    cfg.Auth.SessionTTL,
		AnonymousRead: cfg.Auth.AnonymousRead,
		OIDC:          oidcProvider,
		DefaultRole:   cfg.Auth.RBAC.DefaultRole,
	})
	if err := authSvc.BootstrapAdmin(ctx, cfg.Auth.BootstrapAdminUser, cfg.Auth.BootstrapAdminPassword); err != nil {
		return fmt.Errorf("bootstrap admin: %w", err)
	}
	// Declarative RBAC: reconcile chart-provided roles, grants, group mappings
	// and local accounts. No-op when no policy file is configured.
	if err := auth.ReconcileRBAC(ctx, store, log, cfg.Auth.RBAC.PolicyFile, cfg.Auth.RBAC.AccountsDir); err != nil {
		return fmt.Errorf("reconcile rbac: %w", err)
	}

	if cfg.SeedDefaultRepos {
		if err := repo.SeedDefaults(ctx, store, log); err != nil {
			return fmt.Errorf("seed default repositories: %w", err)
		}
	}

	// Audit recorder: nil (no-op) when disabled. Closed on shutdown so buffered
	// events flush before the store closes.
	var recorder *audit.Recorder
	if cfg.Audit.Enabled {
		recorder = audit.NewRecorder(store, log, reg)
		defer recorder.Close()
	}

	engine := repo.NewEngine(store, blobs, log, reg)
	manager := repo.NewManager(engine, store, authSvc, recorder, reg)
	manager.SetExternalURL(cfg.ExternalURL)

	// Pending approvals, computed on scrape (one indexed COUNT). Needs no leader
	// gating and stays accurate on standbys after a snapshot swap.
	reg.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Namespace: "forklift", Name: "approval_pending",
		Help: "Package approval requests currently pending.",
	}, func() float64 {
		gctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		n, err := store.CountApprovals(gctx, "", meta.ApprovalPending)
		if err != nil {
			return 0
		}
		return float64(n)
	}))

	srv := server.New(cfg, log, store, reg)
	apiHandler := api.New(store, authSvc, log, recorder)

	// Public OIDC login endpoints (no auth middleware required).
	if oidcProvider != nil {
		srv.Router().Get("/auth/login", authSvc.HandleLogin)
		srv.Router().Get("/auth/callback", authSvc.HandleCallback)
	}

	// OpenAPI spec and Scalar docs UI (public).
	openapi.Register(srv.Router())

	// Application routes carry the auth middleware so handlers see the principal.
	srv.Router().Group(func(r chi.Router) {
		r.Use(authSvc.Middleware)
		r.Mount("/api/v1", apiHandler.Routes())
		manager.Register(r)
	})

	// The embedded React SPA serves the UI and handles client-side routing for
	// any path not matched above.
	srv.Router().NotFound(webui.Handler())

	var elector *cluster.Elector
	if cfg.HA.Enabled {
		elector, err = cluster.New(cfg.HA, log)
		if err != nil {
			return fmt.Errorf("init leader election: %w", err)
		}
	}

	// PV-based replication: the leader serves token-gated snapshot/blob
	// endpoints; the standby pulls them onto its own volume and promotes that
	// copy when it wins the election. The mount sits outside the auth middleware
	// group because it carries its own bearer-token check.
	var replicator *replication.Replicator
	if cfg.Replication.Enabled {
		source := replication.NewSource(store, blobs, cfg.Replication.Token, cfg.DataDir, log)
		srv.Router().Mount("/internal/replication", source.Routes())

		resolver := replication.StaticLeaderURL(cfg.Replication.LeaderURL)
		if cfg.Replication.LeaderURL == "" {
			resolver = replication.LeaseLeaderURL(elector, cfg.HA.Identity,
				cfg.Replication.PeerService, cfg.Replication.PeerPort)
		}
		replicator = replication.New(replication.Options{
			Store:      store,
			Blobs:      blobs,
			DataDir:    cfg.DataDir,
			Token:      cfg.Replication.Token,
			Interval:   cfg.Replication.Interval,
			LeaderURL:  resolver,
			Log:        log,
			Registerer: reg,
		})
		go replicator.Run(ctx)

		// With per-pod volumes a StatefulSet rollout waits on pod readiness, so
		// readiness cannot encode leadership (the standby would block rollouts
		// forever). Every pod is Ready; the main Service instead selects the
		// forklift.io/role=leader pod label patched on (de)promotion.
		srv.SetReady(true)
	}
	setPodRole := func(roleCtx context.Context, role string) {
		if !cfg.Replication.Enabled || cfg.Replication.PodName == "" {
			return
		}
		if err := elector.SetPodRole(roleCtx, cfg.Replication.PodNamespace, cfg.Replication.PodName, role); err != nil {
			log.Error("set pod role label", "role", role, "err", err)
		}
	}

	// The blob sweeper and audit retention are gated on leadership. In
	// single-instance mode this process is always the leader; in HA mode a
	// Kubernetes Lease elects exactly one active instance so SQLite has a
	// single writer. With replication enabled, the replicated snapshot is
	// applied before this instance takes traffic.
	startLeading := func(leadCtx context.Context) {
		if replicator != nil {
			if err := replicator.Promote(leadCtx); err != nil {
				log.Error("replication: promote failed; serving local data", "err", err)
			}
		}
		srv.SetReady(true)
		setPodRole(leadCtx, cluster.RoleLeader)
		// A partitioned former leader may not have removed its own leader
		// label; strip it so the Service routes to this pod only.
		if cfg.Replication.Enabled && cfg.Replication.PodName != "" {
			if err := elector.DemotePeers(leadCtx, cfg.Replication.PodNamespace, cfg.Replication.PodName); err != nil {
				log.Error("demote peer leader labels", "err", err)
			}
		}
		go engine.RunSweeper(leadCtx, 5*time.Minute)
		if recorder != nil && cfg.Audit.Retention > 0 {
			go recorder.RunRetention(leadCtx, time.Hour, cfg.Audit.Retention)
		}
	}
	stopLeading := func() {
		if replicator != nil {
			// Stay Ready so rollouts proceed; the role label moves traffic away.
			replicator.Demote()
			demoteCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			setPodRole(demoteCtx, cluster.RoleStandby)
			return
		}
		srv.SetReady(false)
	}

	if cfg.HA.Enabled {
		go elector.Run(ctx, startLeading, stopLeading)
	} else {
		startLeading(ctx)
	}

	return srv.Run(ctx, reg)
}

func newLogger(cfg *config.Config) *slog.Logger {
	var level slog.Level
	switch cfg.LogLevel {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	if cfg.LogFormat == "text" {
		h = slog.NewTextHandler(os.Stdout, opts)
	} else {
		h = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(h)
}
