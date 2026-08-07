// Package throughput recommends an EBS throughput (and the IOPS it requires) for
// each Kubernetes Node in the cluster the addon runs in, and publishes the
// recommendation as annotations on the Node object.
//
// It only ever recommends. No EC2 mutation happens here and the package has no
// access to one: the AWS surface it depends on is read-only by construction.
// That separation is deliberate, because the demand signal is a statistical
// summary of past behavior and acting on it directly would modify a volume from
// an inference rather than a measurement. Whether a recommendation is ever
// applied is the consumer's decision: an operator reading the annotation, or
// the resizer folding an increase into a size expansion it is already making
// (the applyOnResize hand-off through a RecommendationSink), which keeps every
// mutation behind a trigger that is a measurement.
//
// The recommendation is intentionally undefined for anything but a single gp3
// volume per node. Mapping a node exporter device name back to an EBS volume ID
// needs the /dev/disk/by-id symlinks, which needs a privileged DaemonSet on every
// node; rather than take on that deployment shape, a node with more than one
// attached volume is reported as multiple_attached_volumes and left alone.
package throughput

import (
	"context"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"time"

	corev1 "k8s.io/api/core/v1"

	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/awsx"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/nodes"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/promql"
	"github.com/younsl/o/box/kubernetes/external-ebs-autoresizer/internal/recstore"
)

// NodeAPI is the subset of Kubernetes Node operations this package depends on.
// nodes.Client implements it.
type NodeAPI interface {
	List(ctx context.Context, labelSelector string) ([]nodes.Node, error)
	Annotate(ctx context.Context, name string, set map[string]string, remove []string) error
}

// MetricsAPI is the subset of the Prometheus-compatible query API this package
// depends on. promql.Client implements it, backed by either Prometheus or Mimir.
type MetricsAPI interface {
	Query(ctx context.Context, query string) ([]promql.Sample, error)
}

// EC2API is the read-only EC2 surface this package depends on. It deliberately
// excludes every mutating operation.
type EC2API interface {
	DescribeAttachedVolumes(ctx context.Context, instanceIDs []string) (map[string][]awsx.Volume, error)
	DescribeInstanceTypeEBSCaps(ctx context.Context, instanceTypes []string) (map[string]awsx.EBSCaps, error)
}

// NodeEventEmitter publishes Kubernetes Events against Node objects.
// events.NodeEmitter implements it. A nil NodeEventEmitter disables Events (e.g.
// when running outside a cluster or during tests).
type NodeEventEmitter interface {
	NodeEventf(name, uid, eventType, reason, messageFmt string, args ...any)
}

// Kubernetes Event reasons published against a Node.
const (
	// reasonMeasurementStarted marks the start of one Node's evaluation. Repeating
	// it every pass does not create a new Event object: the recorder aggregates it
	// into the existing one and bumps its count, which is what keeps a per-node
	// Event affordable on a large cluster.
	reasonMeasurementStarted = "ThroughputMeasurementStarted"
)

// Recorder receives metrics observations. observability.Metrics implements it.
type Recorder interface {
	ResetNodeThroughput()
	ObserveNodeThroughput(node, instanceID, volumeID string, currentMiBps, peakMiBps, recommendedMiBps float64)
	ObserveRecommendation(action, reason string)
	ObserveError(stage string)
}

// RecommendationSink receives each pass's decisions keyed by volume ID, so
// another subsystem in the same process (the resizer) can consult them.
// recstore.Store implements it. A nil RecommendationSink disables the hand-off.
//
// Publishing to the sink does not soften this package's no-mutation stance:
// the sink is process-local memory, and whether a recommendation is ever
// applied stays the consumer's decision behind its own configuration gate.
type RecommendationSink interface {
	Publish(volumeID string, e recstore.Entry)
	Delete(volumeID string)
	Retain(volumeIDs map[string]struct{})
}

// Recommender evaluates every Node in the cluster once per pass.
type Recommender struct {
	cfg      Config
	query    Query
	settings Settings
	nodes    NodeAPI
	prom     MetricsAPI
	ec2      EC2API
	rec      Recorder
	events   NodeEventEmitter
	sink     RecommendationSink
	logger   *slog.Logger
	// now is injectable so tests control the throughput-observed-at timestamp and the
	// staleness refresh.
	now func() time.Time
}

// New constructs a Recommender, deriving the query and the decision tunables from
// the operator-facing config and the fixed policy constants. events may be nil to
// disable Kubernetes Events; sink may be nil to disable the in-process hand-off
// of decisions to the resizer.
func New(cfg Config, nodeAPI NodeAPI, prom MetricsAPI, ec2 EC2API, rec Recorder, events NodeEventEmitter, sink RecommendationSink, logger *slog.Logger) *Recommender {
	return &Recommender{
		cfg:      cfg,
		query:    cfg.query(),
		settings: cfg.settings(),
		nodes:    nodeAPI,
		prom:     prom,
		ec2:      ec2,
		rec:      rec,
		events:   events,
		sink:     sink,
		logger:   logger,
		now:      time.Now,
	}
}

// observation is one node's fully gathered input, before the decision.
type observation struct {
	node   nodes.Node
	volume awsx.Volume
	input  Input
	// hasMetrics distinguishes a node the query returned no series for from one
	// whose measured peak is genuinely zero.
	hasMetrics bool
	// blocked is the reason this node cannot be evaluated, empty when it can.
	blocked string
}

// Reconcile evaluates every in-scope Node and publishes its recommendation,
// returning the number of Nodes considered. It gathers the whole cluster's data
// with four calls (two queries, two EC2 describes) rather than per node, so pass
// cost stays flat as the cluster grows. Per-node annotation failures are logged
// and counted but never abort the pass.
func (r *Recommender) Reconcile(ctx context.Context) (int, error) {
	// Every Node is evaluated. Nodes that cannot carry a recommendation report why
	// rather than being filtered out up front, which is what makes a
	// misconfiguration visible instead of silently narrowing the scope.
	nodeList, err := r.nodes.List(ctx, "")
	if err != nil {
		r.rec.ObserveError("node_list")
		return 0, fmt.Errorf("list nodes: %w", err)
	}
	if len(nodeList) == 0 {
		r.logger.Info("no nodes found to evaluate")
		// With no nodes there is no volume a recommendation could still apply
		// to, so the hand-off store is emptied rather than left holding entries
		// for volumes that no longer exist.
		if r.sink != nil {
			r.sink.Retain(nil)
		}
		return 0, nil
	}

	// Nodes too young to hold enough history are not queried at all. The
	// observation query is the most expensive thing the addon does, and a node
	// created an hour ago can only ever come back as insufficient_samples, so
	// reading a multi-day window for it is pure waste. Under Karpenter, where nodes
	// turn over constantly, this is most of the saving available.
	names, tooYoung := r.splitByAge(nodeList)
	if len(tooYoung) > 0 {
		r.logger.Info("skipping nodes younger than the observation window",
			"skipped", len(tooYoung), "queried", len(names),
			"minimum_age", r.cfg.minNodeAge().String(), "window", r.cfg.Lookback)
	}

	// The queries are scoped to this cluster's node names, so a metrics backend
	// shared by several clusters only ever reads the series that belong here. That
	// is why no tenancy matcher has to be configured. With no eligible node there is
	// nothing to ask: an unscoped query would read every series the backend holds.
	peaks, err := r.queryPerBatch(ctx, names, r.query.Peak)
	if err != nil {
		r.rec.ObserveError("query_peak")
		return len(nodeList), fmt.Errorf("query peak throughput: %w", err)
	}
	samples, err := r.queryPerBatch(ctx, names, r.query.SampleCount)
	if err != nil {
		r.rec.ObserveError("query_samples")
		return len(nodeList), fmt.Errorf("query sample count: %w", err)
	}

	volumes, caps, err := r.describe(ctx, nodeList)
	if err != nil {
		return len(nodeList), err
	}

	r.rec.ResetNodeThroughput()
	young := make(map[string]struct{}, len(tooYoung))
	for _, name := range tooYoung {
		young[name] = struct{}{}
	}
	// seen collects every volume evaluated this pass, so the hand-off store can
	// be swept down to exactly the volumes that still exist. It is only applied
	// after the loop completes: an aborted pass has not seen every volume, and
	// sweeping on partial knowledge would drop live entries.
	seen := make(map[string]struct{}, len(nodeList))
	for _, n := range nodeList {
		if ctx.Err() != nil {
			return len(nodeList), ctx.Err()
		}
		r.eventMeasurementStarted(n)
		_, skipped := young[n.Name]
		obs := r.observe(n, volumes, caps, peaks, samples, skipped)
		d := decideOrBlock(obs, r.settings)
		if obs.volume.ID != "" {
			seen[obs.volume.ID] = struct{}{}
		}
		r.handOff(obs, d)
		r.report(obs, d)
		res, err := r.publish(ctx, obs, d)
		if err != nil {
			r.rec.ObserveError("annotate")
			r.logger.Error("failed to annotate node with EBS throughput recommendation",
				"node", n.Name, "volume", obs.volume.ID,
				"recommendation", d.Action, "reason", d.Reason, "outcome", "failed", "error", err)
			continue
		}
		r.logAnnotationOutcome(obs, d, res)
	}
	if r.sink != nil {
		r.sink.Retain(seen)
	}
	return len(nodeList), nil
}

// handOff forwards one node's decision to the in-process sink. A decision the
// resizer could act on is published; a volume that can no longer be decided
// (too young after a reboot, metrics gone, unsupported type) has its entry
// deleted, so no earlier recommendation outlives the conditions that produced
// it. Nodes whose volume is unknown have nothing to key an entry by.
//
// The hand-off ignores DryRun on purpose: writing process-local memory is not
// a mutation, and the consumer sits behind the same global DryRun gate.
func (r *Recommender) handOff(obs observation, d Decision) {
	if r.sink == nil || obs.volume.ID == "" {
		return
	}
	if d.Action == ActionUnknown {
		r.sink.Delete(obs.volume.ID)
		return
	}
	r.sink.Publish(obs.volume.ID, recstore.Entry{
		NodeName:        obs.node.Name,
		NodeUID:         obs.node.UID,
		Action:          d.Action,
		ThroughputMiBps: d.RecommendedThroughputMiBps,
		IOPS:            d.RecommendedIOPS,
		CurrentMiBps:    obs.volume.ThroughputMiBps,
		CurrentIOPS:     obs.volume.IOPS,
		ObservedAt:      r.now(),
	})
}

// eventMeasurementStarted publishes a Node Event as that Node's evaluation begins,
// so the measurement is visible in kubectl describe node without reading the
// controller's logs. It is a no-op when Events are disabled.
func (r *Recommender) eventMeasurementStarted(n nodes.Node) {
	if r.events == nil {
		return
	}
	r.events.NodeEventf(n.Name, n.UID, corev1.EventTypeNormal, reasonMeasurementStarted,
		"Measuring EBS throughput over %s to recommend a gp3 throughput; no volume is modified", r.cfg.Window())
}

// describe fetches the volume and instance-type data for the node set.
func (r *Recommender) describe(ctx context.Context, nodeList []nodes.Node) (map[string][]awsx.Volume, map[string]awsx.EBSCaps, error) {
	var instanceIDs, instanceTypes []string
	for _, n := range nodeList {
		if n.InstanceID != "" {
			instanceIDs = append(instanceIDs, n.InstanceID)
		}
		if n.InstanceType != "" {
			instanceTypes = append(instanceTypes, n.InstanceType)
		}
	}
	volumes, err := r.ec2.DescribeAttachedVolumes(ctx, instanceIDs)
	if err != nil {
		r.rec.ObserveError("describe_volumes")
		return nil, nil, fmt.Errorf("describe attached volumes: %w", err)
	}
	caps, err := r.ec2.DescribeInstanceTypeEBSCaps(ctx, instanceTypes)
	if err != nil {
		r.rec.ObserveError("describe_instance_types")
		return nil, nil, fmt.Errorf("describe instance type EBS caps: %w", err)
	}
	return volumes, caps, nil
}

// observe assembles one node's decision input from the gathered data, or records
// why the node cannot be evaluated. tooYoung marks a node the queries deliberately
// skipped.
func (r *Recommender) observe(n nodes.Node, volumes map[string][]awsx.Volume, caps map[string]awsx.EBSCaps, peaks, samples map[string]float64, tooYoung bool) observation {
	obs := observation{node: n}
	if n.InstanceID == "" {
		obs.blocked = ReasonNotEC2Node
		return obs
	}
	attached := volumes[n.InstanceID]
	switch len(attached) {
	case 0:
		obs.blocked = ReasonNoVolume
		return obs
	case 1:
		obs.volume = attached[0]
	default:
		// The volume is known but which one carries the measured IO is not, so the
		// current provisioning is deliberately not reported either: attributing the
		// node's total throughput to an arbitrary one of its volumes would be wrong.
		obs.blocked = ReasonMultipleVolumes
		return obs
	}

	// Checked after the volume is resolved so the current provisioning is still
	// reported, and before the metrics lookup so a node that was never queried does
	// not read as a missing scrape. That distinction matters: no_metrics_for_node
	// sends an operator looking for a broken scrape, while this reason says to wait.
	if tooYoung {
		obs.blocked = ReasonNodeTooYoung
		return obs
	}

	peak, ok := peaks[n.Name]
	if !ok {
		obs.blocked = ReasonNoMetrics
		return obs
	}
	obs.hasMetrics = true
	obs.input = Input{
		VolumeType:             obs.volume.Type,
		CurrentThroughputMiBps: obs.volume.ThroughputMiBps,
		CurrentIOPS:            obs.volume.IOPS,
		PeakMiBps:              peak,
		Samples:                int(samples[n.Name]),
	}
	if c, ok := caps[n.InstanceType]; ok {
		obs.input.InstanceMaxMiBps = MBpsToMiBps(c.MaximumMBps)
		obs.input.InstanceBaselineMiBps = MBpsToMiBps(c.BaselineMBps)
	}
	return obs
}

// decideOrBlock returns the blocked reason as an unknown decision, or runs the
// decision when the node is evaluable.
func decideOrBlock(obs observation, s Settings) Decision {
	if obs.blocked != "" {
		return Decision{Action: ActionUnknown, Reason: obs.blocked}
	}
	return Decide(obs.input, s)
}

// report records metrics and logs one node's outcome. An actionable
// recommendation logs at info so it shows up without debug logging; everything
// else stays at debug, since a large cluster is mostly nodes with nothing to do.
func (r *Recommender) report(obs observation, d Decision) {
	r.rec.ObserveRecommendation(d.Action, d.Reason)
	if obs.blocked == "" {
		r.rec.ObserveNodeThroughput(obs.node.Name, obs.node.InstanceID, obs.volume.ID,
			float64(obs.volume.ThroughputMiBps), obs.input.PeakMiBps, float64(d.RecommendedThroughputMiBps))
	}

	log := r.logger.With(
		"node", obs.node.Name, "instance", obs.node.InstanceID, "volume", obs.volume.ID,
		"recommendation", d.Action, "reason", d.Reason)
	switch d.Action {
	case ActionIncrease, ActionDecrease:
		log.Info("EBS throughput recommendation",
			"current_mibps", obs.volume.ThroughputMiBps,
			"observed_peak_mibps", obs.input.PeakMiBps,
			"recommended_mibps", d.RecommendedThroughputMiBps,
			"current_iops", obs.volume.IOPS,
			"recommended_iops", d.RecommendedIOPS,
			"samples", obs.input.Samples,
			"capped", d.Capped)
	default:
		log.Debug("no EBS throughput change recommended",
			"current_mibps", obs.volume.ThroughputMiBps,
			"observed_peak_mibps", obs.input.PeakMiBps,
			"samples", obs.input.Samples,
			"capped", d.Capped)
	}
}

// Outcomes of one node's annotation attempt, reported in the per-node log so a
// pass is auditable from the logs alone: which Nodes were written, which were
// already current, and which were out of scope.
const (
	outcomeWritten       = "written"
	outcomeUnchanged     = "unchanged"
	outcomeDryRun        = "dry_run"
	outcomeNotApplicable = "not_applicable"
)

// publish writes the node's annotations and reports which outcome happened. The
// patch is skipped when nothing changed and throughput-observed-at is still fresh.
// A node that is not an EC2 instance is never annotated: the recommender has
// nothing to say about it, and writing a "not_an_ec2_node" annotation onto every
// Fargate or virtual node would be noise.
func (r *Recommender) publish(ctx context.Context, obs observation, d Decision) (publishResult, error) {
	if obs.blocked == ReasonNotEC2Node {
		return publishResult{outcome: outcomeNotApplicable}, nil
	}
	now := r.now().UTC()
	desired := r.buildAnnotations(obs, d)
	observedAtKey := AnnotationPrefix + "/" + keyObservedAt
	if !desired.needsWrite(obs.node.Annotations, observedAtKey, now) {
		return publishResult{outcome: outcomeUnchanged}, nil
	}
	desired.set[observedAtKey] = now.Format(time.RFC3339)
	if r.cfg.DryRun {
		return publishResult{outcome: outcomeDryRun, annotations: desired}, nil
	}
	if err := r.nodes.Annotate(ctx, obs.node.Name, desired.set, desired.remove); err != nil {
		return publishResult{}, err
	}
	return publishResult{outcome: outcomeWritten, annotations: desired}, nil
}

// publishResult is what happened to one node's annotations. annotations is only
// populated for an outcome that produced a patch, so the log can report exactly
// what landed without rebuilding it.
type publishResult struct {
	outcome     string
	annotations annotationSet
}

// logAnnotationOutcome logs what happened to one node's annotations.
//
// A write is logged at info because it is a cluster mutation, and it carries the
// values so the log alone is enough to reconstruct what landed on the Node.
// Everything else is at debug: in a steady state almost every node is unchanged on
// every pass, and logging those at info would bury the writes.
func (r *Recommender) logAnnotationOutcome(obs observation, d Decision, res publishResult) {
	log := r.logger.With(
		"node", obs.node.Name, "volume", obs.volume.ID,
		"recommendation", d.Action, "reason", d.Reason, "outcome", res.outcome)
	switch res.outcome {
	case outcomeWritten:
		log.Info("annotated node with EBS throughput recommendation",
			"annotations", res.annotations.set, "removed", res.annotations.remove)
	case outcomeDryRun:
		log.Info("dry-run: would annotate node with EBS throughput recommendation",
			"annotations", res.annotations.set, "removed", res.annotations.remove)
	case outcomeUnchanged:
		log.Debug("node annotations already current, no patch issued")
	default:
		log.Debug("node is out of scope for a throughput recommendation")
	}
}

// nodeNames returns the Node names to scope the queries to. Every Node is
// included, even one that will turn out not to be EC2-backed: the metrics backend
// is the wrong place to decide that, and an unmatched name in the alternation
// costs nothing.
func nodeNames(nodeList []nodes.Node) []string {
	out := make([]string, 0, len(nodeList))
	for _, n := range nodeList {
		out = append(out, n.Name)
	}
	return out
}

// splitByAge separates the Nodes worth querying from those too young to hold
// enough history. A Node with no creationTimestamp is queried: an unknown age is
// not evidence of youth, and treating it as young would silently drop the node.
func (r *Recommender) splitByAge(nodeList []nodes.Node) (query, tooYoung []string) {
	minAge := r.cfg.minNodeAge()
	now := r.now()
	for _, n := range nodeList {
		if !n.CreatedAt.IsZero() && now.Sub(n.CreatedAt) < minAge {
			tooYoung = append(tooYoung, n.Name)
			continue
		}
		query = append(query, n.Name)
	}
	return query, tooYoung
}

// queryPerBatch evaluates build() once per batch of node names and merges the
// results. Batching bounds the expression size on a large cluster without changing
// the total work: each series is still read exactly once, just across a few
// requests instead of one.
func (r *Recommender) queryPerBatch(ctx context.Context, names []string, build func([]string) string) (map[string]float64, error) {
	out := make(map[string]float64, len(names))
	for batch := range slices.Chunk(names, nodeBatch) {
		result, err := r.queryByNode(ctx, build(batch))
		if err != nil {
			return nil, err
		}
		maps.Copy(out, result)
	}
	return out, nil
}

// queryByNode runs one query and keys the result by the node name carried in the
// configured node label. Series missing that label are dropped with a warning:
// silently ignoring them would understate the peak for whichever node they belong
// to, and guessing the node from another label would be worse.
func (r *Recommender) queryByNode(ctx context.Context, query string) (map[string]float64, error) {
	r.logger.Debug("querying metrics backend", "query", query)
	result, err := r.prom.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	out := make(map[string]float64, len(result))
	unlabelled := 0
	for _, s := range result {
		name := s.Labels[r.query.NodeLabel]
		if name == "" {
			unlabelled++
			continue
		}
		out[name] = s.Value
	}
	if unlabelled > 0 {
		r.logger.Warn("dropped query result series with no node label",
			"metric_node_name_label", r.query.NodeLabel, "series", unlabelled,
			"hint", "set throughputRecommendation.metricNodeNameLabel to the label carrying the Kubernetes node name")
	}
	return out, nil
}
