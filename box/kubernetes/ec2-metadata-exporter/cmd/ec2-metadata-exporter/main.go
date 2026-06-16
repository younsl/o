// Command ec2-metadata-exporter polls the EC2 DescribeInstances API and
// exposes every instance's private IP and Name tag as Prometheus metrics.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"

	"github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/collector"
	"github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/config"
	"github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/observability"
	"github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/version"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("configuration error", "error", err)
		os.Exit(1)
	}

	logger := newLogger(cfg.LogLevel, cfg.LogFormat)
	logger.Info("starting ec2-metadata-exporter",
		"version", version.Version, "commit", version.Commit,
		"region", cfg.Region, "scrape_interval", cfg.ScrapeInterval.String(),
		"metrics_port", cfg.MetricsPort, "health_port", cfg.HealthPort)
	logger.Info("collecting EC2 instance metadata",
		"labels", strings.Join(collector.InfoLabels, ","),
		"label_count", len(collector.InfoLabels))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(cfg.Region))
	if err != nil {
		logger.Error("failed to load AWS config", "error", err)
		os.Exit(1)
	}

	col := collector.New(ec2.NewFromConfig(awsCfg), logger)
	health := observability.NewHealth()

	go func() {
		if err := health.Serve(ctx, cfg.HealthPort); err != nil {
			logger.Error("health server failed", "error", err)
		}
	}()
	go func() {
		if err := observability.ServeMetrics(ctx, cfg.MetricsPort, col.Registry()); err != nil {
			logger.Error("metrics server failed", "error", err)
		}
	}()

	health.SetReady(true)
	col.Run(ctx, cfg.ScrapeInterval)
	health.SetReady(false)
	logger.Info("shutdown complete")
}

func newLogger(level, format string) *slog.Logger {
	var lvl slog.Level
	switch strings.ToLower(level) {
	case "debug":
		lvl = slog.LevelDebug
	case "warn":
		lvl = slog.LevelWarn
	case "error":
		lvl = slog.LevelError
	default:
		lvl = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: lvl}
	var handler slog.Handler
	if strings.ToLower(format) == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(handler)
}
