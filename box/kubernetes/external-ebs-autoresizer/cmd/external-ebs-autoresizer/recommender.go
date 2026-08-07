package main

import (
	"context"
	"log/slog"
	"math"
	"time"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/config"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/events"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/nodes"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/promql"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/throughput"
)

// This file wires the node EBS throughput recommender, which is independent of
// the resize loop: it reads a Prometheus-compatible metrics backend and the
// Kubernetes API, and writes only Node annotations.

// buildRecommender constructs the recommender, or returns nil when it is disabled
// or cannot run. A nil return is not an error: the recommender is auxiliary, so a
// cluster without in-cluster access (running the binary locally) still runs the
// resize loop. sink may be nil to disable the in-process hand-off of decisions
// to the resizer; nodeEvents may be nil to disable Node Events.
func buildRecommender(ctx context.Context, cfg *config.Config, ec2 throughput.EC2API, rec throughput.Recorder, sink throughput.RecommendationSink, nodeEvents throughput.NodeEventEmitter, logger *slog.Logger) *throughput.Recommender {
	tr := cfg.ThroughputRecommendation
	if !tr.Enabled {
		logger.Info("EBS throughput recommendation disabled")
		return nil
	}

	nodeClient, err := nodes.New()
	if err != nil {
		logger.Error("EBS throughput recommendation disabled: no in-cluster Kubernetes access", "error", err)
		return nil
	}

	promClient := promql.New(tr.PrometheusURL, tr.PrometheusTenantID, throughput.QueryTimeout(), queryHeaders(tr), logger)
	logger.Info("EBS throughput recommendation enabled",
		"prometheus_url", tr.PrometheusURL,
		"tenant_id", tr.PrometheusTenantID,
		"bearer_token_set", tr.PrometheusBearerToken != "",
		"interval", tr.Interval.String(),
		"lookback_window", tr.LookbackWindow,
		"metric_node_name_label", tr.MetricNodeNameLabel,
		"annotation_prefix", throughput.AnnotationPrefix,
		"apply_on_resize", tr.ApplyOnResize,
		"dry_run", cfg.DryRun)
	// The preflight both verifies connectivity and pins the API path prefix, which
	// is what makes the same prometheusUrl work against Prometheus and Mimir.
	runPreflight(ctx, logger, "prometheus", promClient)

	recommender := throughput.New(recommenderConfig(cfg), nodeClient, promClient, ec2, rec, nodeEvents, sink, logger)
	// The probe logs the query it actually ran, which is the one an operator pastes
	// into Grafana. It cannot be logged before this point: the query is scoped to
	// this cluster's node names, so it does not exist until the Nodes are listed.
	logProbe(ctx, recommender, throughput.QueryTimeout(), tr.MetricNodeNameLabel, logger)
	return recommender
}

// buildNodeEventEmitter constructs the shared Node Event emitter, or nil when
// Node Events cannot be published (running outside a cluster). Node Events are
// auxiliary: losing them stops neither loop. The emitter is its own rather
// than the resize loop's Pod emitter because a Node's Events are stored in the
// "default" namespace, and client-go binds a sink to one namespace.
func buildNodeEventEmitter(logger *slog.Logger) (*events.NodeEmitter, func()) {
	emitter, err := events.NewNodeEmitter()
	if err != nil {
		logger.Warn("Node Event publishing disabled", "error", err)
		return nil, func() {}
	}
	return emitter, emitter.Shutdown
}

// queryHeaders builds the static headers for every query. The only one is the
// bearer token for a gateway fronting the metrics backend, which arrives from a
// Secret through PROMETHEUS_BEARER_TOKEN rather than the config file so it never
// lands in the ConfigMap.
func queryHeaders(tr config.ThroughputRecommendation) map[string]string {
	if tr.PrometheusBearerToken == "" {
		return nil
	}
	return map[string]string{"Authorization": "Bearer " + tr.PrometheusBearerToken}
}

// prober is the startup metrics check buildRecommender runs.
// throughput.Recommender implements it.
type prober interface {
	Probe(ctx context.Context) (throughput.Probe, error)
}

// logProbe runs the one-time metrics check and logs what came back. It never
// blocks startup: a backend that is briefly unavailable is no reason to keep the
// recommender from retrying on its own interval.
//
// This runs on every replica, before leader election, and deliberately so. The
// query is read-only, and a standby replica that cannot read the metrics backend
// is a problem worth seeing at startup rather than at failover.
func logProbe(ctx context.Context, p prober, timeout time.Duration, metricNodeNameLabel string, logger *slog.Logger) {
	pctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	probe, err := p.Probe(pctx)
	if err != nil {
		logger.Error("EBS throughput recommendation metrics check failed; the recommender will retry on its interval",
			"error", err, "latency", probe.Latency.Round(time.Millisecond).String(), "query", probe.Query)
		return
	}

	attrs := []any{
		"nodes", probe.Nodes,
		"series", probe.Series,
		"latency", probe.Latency.Round(time.Millisecond).String(),
	}
	if probe.MaxNode != "" {
		attrs = append(attrs,
			"busiest_node", probe.MaxNode,
			"busiest_node_peak_mibps", math.Round(probe.MaxPeakMiBps*10)/10)
	}

	switch {
	case probe.Nodes == 0 && probe.Series > 0:
		// Series came back but none carried the node label, which is the one
		// misconfiguration every connectivity check passes.
		logger.Error("EBS throughput recommendation metrics check returned no usable series: the configured node label is missing from every result",
			append(attrs, "metric_node_name_label", metricNodeNameLabel,
				"hint", `set throughputRecommendation.metricNodeNameLabel to the label carrying the Kubernetes node name (kube-prometheus-stack relabels it to "node"; a plain node exporter scrape leaves only "instance")`)...)
	case probe.Nodes == 0:
		logger.Warn("EBS throughput recommendation metrics check returned no data",
			append(attrs, "hint", "check that node exporter is scraped into this backend and that deviceRegex matches this cluster's block devices")...)
	default:
		logger.Info("EBS throughput recommendation metrics check succeeded", attrs...)
	}
}

// recommenderConfig maps the config file block onto the recommender's own
// configuration. The recommender inherits the global dryRun: it never mutates
// AWS, but annotating Nodes is still a cluster write, and a dry run must not
// write anything anywhere.
func recommenderConfig(cfg *config.Config) throughput.Config {
	tr := cfg.ThroughputRecommendation
	return throughput.Config{
		MetricNodeNameLabel: tr.MetricNodeNameLabel,
		Lookback:            tr.LookbackWindow,
		LookbackDuration:    tr.LookbackDuration,
		DryRun:              cfg.DryRun,
	}
}
