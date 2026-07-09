// Command opensearch-conflict-viewer aggregates mapping conflicts across
// OpenSearch Dashboards index patterns and serves them as a web UI, a JSON
// API, and Prometheus metrics.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/config"
	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/conflict"
	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/opensearch"
	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/server"
	"github.com/younsl/o/box/kubernetes/opensearch-conflict-viewer/internal/version"
)

func main() {
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("opensearch-conflict-viewer", version.String())
		return
	}

	if err := run(context.Background()); err != nil {
		fmt.Fprintln(os.Stderr, "fatal:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	log := newLogger(cfg)
	log.Info("starting opensearch-conflict-viewer",
		"version", version.String(),
		"opensearch_url", cfg.OpenSearchURL,
		"index_targets", cfg.IndexTargets,
		"refresh_interval", cfg.RefreshInterval.String(),
	)

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	reg := prometheus.NewRegistry()
	reg.MustRegister(
		prometheus.NewGoCollector(),
		prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}),
	)

	fetcher := &conflict.Fetcher{
		Source:      opensearch.New(cfg.OpenSearchURL, cfg.Username, cfg.Password),
		KibanaIndex: cfg.KibanaIndex,
		Targets:     cfg.IndexTargets,
		ClusterName: cfg.ClusterName,
	}
	svc := server.NewService(fetcher, &server.Store{}, server.NewMetrics(reg), log)

	go svc.RunRefresher(ctx, cfg.RefreshInterval)

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.ListenPort),
		Handler:           svc.Handler(reg),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
	}

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return srv.Shutdown(shutdownCtx)
}

func newLogger(cfg config.Config) *slog.Logger {
	var level slog.Level
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		level = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler
	if cfg.LogFormat == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(handler)
}
