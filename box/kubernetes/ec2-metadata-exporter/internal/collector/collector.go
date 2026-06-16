// Package collector polls the EC2 DescribeInstances API and exposes each
// instance's private IP and Name tag as Prometheus metrics.
package collector

import (
	"context"
	"log/slog"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/prometheus/client_golang/prometheus"
)

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

// Collector polls EC2 and keeps the metric registry in sync with the latest
// snapshot. Each refresh fully resets the info gauge so terminated instances
// disappear instead of going stale.
type Collector struct {
	client   ec2.DescribeInstancesAPIClient
	logger   *slog.Logger
	registry *prometheus.Registry

	info           *prometheus.GaugeVec
	instances      prometheus.Gauge
	scrapeErrors   prometheus.Counter
	scrapeDuration prometheus.Gauge
	lastSuccess    prometheus.Gauge
}

// New builds a Collector and registers its metrics on a private registry.
func New(client ec2.DescribeInstancesAPIClient, logger *slog.Logger) *Collector {
	c := &Collector{
		client:   client,
		logger:   logger,
		registry: prometheus.NewRegistry(),
		info: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "ec2_metadata_instance_info",
			Help: "EC2 instance metadata. Value is always 1; labels carry the private IP, Name tag, instance type, availability zone, lifecycle (on-demand or spot), and CPU architecture.",
		}, []string{"instance_id", "name", "private_ip", "instance_type", "availability_zone", "state", "lifecycle", "architecture"}),
		instances: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ec2_metadata_instances",
			Help: "Number of EC2 instances observed in the last successful scrape.",
		}),
		scrapeErrors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "ec2_metadata_scrape_errors_total",
			Help: "Total EC2 API scrape failures.",
		}),
		scrapeDuration: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ec2_metadata_scrape_duration_seconds",
			Help: "Duration of the last EC2 API scrape.",
		}),
		lastSuccess: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "ec2_metadata_last_scrape_success_timestamp_seconds",
			Help: "Unix timestamp of the last successful EC2 API scrape.",
		}),
	}
	c.registry.MustRegister(c.info, c.instances, c.scrapeErrors, c.scrapeDuration, c.lastSuccess)
	return c
}

// Registry returns the registry holding all exporter metrics.
func (c *Collector) Registry() *prometheus.Registry {
	return c.registry
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

func (c *Collector) refresh(ctx context.Context) {
	start := time.Now()
	instances, err := c.describeAll(ctx)
	c.scrapeDuration.Set(time.Since(start).Seconds())
	if err != nil {
		c.scrapeErrors.Inc()
		c.logger.Error("failed to describe EC2 instances", "error", err)
		return
	}

	c.info.Reset()
	for _, inst := range instances {
		c.info.WithLabelValues(inst.ID, inst.Name, inst.PrivateIP, inst.InstanceType, inst.AvailabilityZone, inst.State, inst.Lifecycle, inst.Architecture).Set(1)
	}
	c.instances.Set(float64(len(instances)))
	c.lastSuccess.SetToCurrentTime()
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
