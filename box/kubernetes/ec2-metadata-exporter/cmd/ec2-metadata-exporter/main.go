// Command ec2-metadata-exporter polls the EC2 DescribeInstances API and
// exposes every instance's private IP and Name tag as Prometheus metrics.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/smithy-go/logging"

	"github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/collector"
	"github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/config"
	"github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/observability"
	"github.com/younsl/o/box/kubernetes/ec2-metadata-exporter/internal/version"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		// Config failed to load, so log the error with the default
		// level and format to keep the output structured.
		newLogger("info", "json").Error("configuration error", "error", err)
		os.Exit(1)
	}
	logger := newLogger(cfg.LogLevel, cfg.LogFormat)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := run(ctx, cfg, logger); err != nil {
		logger.Error("exporter failed", "error", err)
		os.Exit(1)
	}
}

// run wires the collector and HTTP servers and blocks until ctx is cancelled.
func run(ctx context.Context, cfg config.Config, logger *slog.Logger) error {
	logger.Info("starting ec2-metadata-exporter",
		"version", version.Version, "commit", version.Commit,
		"region", cfg.Region, "scrape_interval", cfg.ScrapeInterval.String(),
		"metrics_port", cfg.MetricsPort, "health_port", cfg.HealthPort)
	logger.Info("collecting EC2 instance metadata",
		"labels", strings.Join(collector.InfoLabels, ","),
		"label_count", len(collector.InfoLabels))

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(cfg.Region),
		awsconfig.WithLogger(slogAWSLogger{logger}))
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}

	health := observability.NewHealth()
	col := collector.New(ec2.NewFromConfig(awsCfg), logger, health)
	observability.RegisterBuildInfo(col.Registry(), version.Version, version.Commit)

	go func() {
		if err := health.Serve(ctx, cfg.HealthPort, logger); err != nil {
			logger.Error("health server failed", "error", err)
		}
	}()
	go func() {
		if err := observability.ServeMetrics(ctx, cfg.MetricsPort, col.Registry(), logger); err != nil {
			logger.Error("metrics server failed", "error", err)
		}
	}()

	// Readiness flips to true inside the collector after the first
	// successful scrape, so rollouts never route to an empty exporter.
	col.Run(ctx, cfg.ScrapeInterval)
	health.SetReady(false)
	logger.Info("shutdown complete")
	return nil
}

// slogAWSLogger adapts *slog.Logger to the smithy logging.Logger interface so
// AWS SDK internal messages (retries, deprecation warnings) come out through
// the same structured handler as the rest of the exporter.
type slogAWSLogger struct {
	logger *slog.Logger
}

func (l slogAWSLogger) Logf(classification logging.Classification, format string, v ...any) {
	msg := fmt.Sprintf(format, v...)
	if classification == logging.Warn {
		l.logger.Warn(msg, "source", "aws-sdk")
		return
	}
	l.logger.Debug(msg, "source", "aws-sdk")
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
