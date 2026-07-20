// Package collector polls the EC2 DescribeInstances API and exposes each
// instance's private IP and Name tag as Prometheus metrics.
package collector

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/prometheus/client_golang/prometheus"
)

// InfoLabels is the ordered label set published on ec2_metadata_instance_info.
// It is the single source of truth for both metric construction and the startup
// log; the per-instance values in Collect must be passed in this same order.
var InfoLabels = []string{
	"instance_id",
	"name",
	"private_ip",
	"instance_type",
	"availability_zone",
	"state",
	"lifecycle",
	"architecture",
}

// Instance is the subset of EC2 instance data the exporter publishes.
type Instance struct {
	ID               string
	Name             string
	PrivateIP        string
	InstanceType     string
	AvailabilityZone string
	State            string
	Lifecycle        string
	Architecture     string
}

// ReadinessReporter receives readiness transitions driven by scrape outcomes.
// *observability.Health satisfies it.
type ReadinessReporter interface {
	SetReady(bool)
}

// Collector polls EC2 and serves the latest snapshot as Prometheus metrics.
// It implements prometheus.Collector: instance metrics are emitted as const
// metrics from the snapshot, so a scrape during a refresh never observes a
// half-populated (or empty) result, and terminated instances disappear as
// soon as a new snapshot lands.
type Collector struct {
	client   ec2.DescribeInstancesAPIClient
	logger   *slog.Logger
	registry *prometheus.Registry
	ready    ReadinessReporter

	mu       sync.RWMutex
	snapshot []Instance

	infoDesc      *prometheus.Desc
	instancesDesc *prometheus.Desc

	scrapeErrors   prometheus.Counter
	scrapeDuration prometheus.Histogram
	lastSuccess    prometheus.Gauge
}

// New builds a Collector and registers its metrics on a private registry.
// ready may be nil; when set, it is marked ready on the first successful
// scrape.
func New(client ec2.DescribeInstancesAPIClient, logger *slog.Logger, ready ReadinessReporter) *Collector {
	c := &Collector{
		client:   client,
		logger:   logger,
		registry: prometheus.NewRegistry(),
		ready:    ready,
		infoDesc: prometheus.NewDesc(
			"ec2_metadata_instance_info",
			"EC2 instance metadata. Value is always 1; labels carry the private IP, Name tag, instance type, availability zone, lifecycle (on-demand or spot), and CPU architecture.",
			InfoLabels, nil,
		),
		instancesDesc: prometheus.NewDesc(
			"ec2_metadata_instances",
			"Number of EC2 instances observed in the last successful scrape, by instance state.",
			[]string{"state"}, nil,
		),
		scrapeErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ec2_metadata_scrape_errors_total",
			Help: "Total EC2 API scrape failures.",
		}),
		scrapeDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "ec2_metadata_scrape_duration_seconds",
			Help:    "Duration of EC2 API scrapes.",
			Buckets: prometheus.ExponentialBuckets(0.05, 2, 10), // 50ms .. ~25.6s
		}),
		lastSuccess: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ec2_metadata_last_scrape_success_timestamp_seconds",
			Help: "Unix timestamp of the last successful EC2 API scrape.",
		}),
	}
	c.registry.MustRegister(c, c.scrapeErrors, c.scrapeDuration, c.lastSuccess)
	return c
}

// Registry returns the registry holding all exporter metrics.
func (c *Collector) Registry() *prometheus.Registry {
	return c.registry
}

// Describe implements prometheus.Collector.
func (c *Collector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.infoDesc
	ch <- c.instancesDesc
}

// Collect implements prometheus.Collector. It reads the snapshot atomically,
// so concurrent refreshes never surface partial state to a scrape.
func (c *Collector) Collect(ch chan<- prometheus.Metric) {
	c.mu.RLock()
	snapshot := c.snapshot
	c.mu.RUnlock()

	byState := make(map[string]int)
	for _, inst := range snapshot {
		ch <- prometheus.MustNewConstMetric(c.infoDesc, prometheus.GaugeValue, 1,
			inst.ID, inst.Name, inst.PrivateIP, inst.InstanceType, inst.AvailabilityZone, inst.State, inst.Lifecycle, inst.Architecture)
		byState[inst.State]++
	}
	for state, count := range byState {
		ch <- prometheus.MustNewConstMetric(c.instancesDesc, prometheus.GaugeValue, float64(count), state)
	}
}

// Run refreshes once immediately, then on every tick until ctx is cancelled.
func (c *Collector) Run(ctx context.Context, interval time.Duration) {
	c.refresh(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.refresh(ctx)
		}
	}
}

// refresh polls EC2 and swaps in a new snapshot. On failure the previous
// snapshot keeps serving so a transient API error never blanks the metrics.
func (c *Collector) refresh(ctx context.Context) {
	start := time.Now()
	instances, err := c.describeAll(ctx)
	c.scrapeDuration.Observe(time.Since(start).Seconds())
	if err != nil {
		c.scrapeErrors.Inc()
		c.logger.Error("failed to describe EC2 instances", "error", err)
		return
	}

	c.mu.Lock()
	c.snapshot = instances
	c.mu.Unlock()

	c.lastSuccess.SetToCurrentTime()
	if c.ready != nil {
		c.ready.SetReady(true)
	}
	c.logger.Info("refreshed EC2 instance metrics", "instances", len(instances), "duration", time.Since(start).String())
}

// describeAll pages through DescribeInstances and returns every non-terminated
// instance that has a private IP address.
func (c *Collector) describeAll(ctx context.Context) ([]Instance, error) {
	input := &ec2.DescribeInstancesInput{
		Filters: []ec2types.Filter{{
			Name:   aws.String("instance-state-name"),
			Values: []string{"pending", "running", "stopping", "stopped"},
		}},
	}

	var instances []Instance
	paginator := ec2.NewDescribeInstancesPaginator(c.client, input)
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, reservation := range page.Reservations {
			for _, inst := range reservation.Instances {
				if inst.PrivateIpAddress == nil {
					continue
				}
				instances = append(instances, Instance{
					ID:               aws.ToString(inst.InstanceId),
					Name:             nameTag(inst.Tags),
					PrivateIP:        aws.ToString(inst.PrivateIpAddress),
					InstanceType:     string(inst.InstanceType),
					AvailabilityZone: availabilityZone(inst.Placement),
					State:            string(inst.State.Name),
					Lifecycle:        lifecycle(inst.InstanceLifecycle),
					Architecture:     string(inst.Architecture),
				})
			}
		}
	}
	return instances, nil
}

func availabilityZone(placement *ec2types.Placement) string {
	if placement == nil {
		return ""
	}
	return aws.ToString(placement.AvailabilityZone)
}

// lifecycle maps the EC2 InstanceLifecycle field to a metric label value. The
// field is empty for on-demand instances and "spot" for Spot instances; other
// values (scheduled, capacity-block) pass through verbatim.
func lifecycle(l ec2types.InstanceLifecycleType) string {
	if l == "" {
		return "on-demand"
	}
	return string(l)
}

func nameTag(tags []ec2types.Tag) string {
	for _, tag := range tags {
		if aws.ToString(tag.Key) == "Name" {
			return aws.ToString(tag.Value)
		}
	}
	return ""
}
