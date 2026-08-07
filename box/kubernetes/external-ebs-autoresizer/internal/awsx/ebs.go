package awsx

import (
	"context"
	"fmt"
	"maps"
	"slices"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// This file holds the read-only EBS and instance-type lookups the throughput
// recommender needs. Nothing here mutates AWS state: the recommender only ever
// publishes a recommendation, so it must not be able to change a volume even by
// accident.

const (
	// filterBatch bounds how many instance IDs go into a single DescribeVolumes
	// filter. EC2 caps filter values per request, and a long value list also
	// risks exceeding the request size limit.
	filterBatch = 100
	// instanceTypeBatch is the DescribeInstanceTypes per-request limit on the
	// InstanceTypes parameter.
	instanceTypeBatch = 100
)

// DescribeAttachedVolumes returns the attached EBS volumes of each given
// instance, keyed by instance ID. Instances with no attached EBS volume are
// absent from the result rather than mapped to an empty slice. An empty
// instanceIDs returns an empty map without calling AWS.
func (c *Clients) DescribeAttachedVolumes(ctx context.Context, instanceIDs []string) (map[string][]Volume, error) {
	out := make(map[string][]Volume, len(instanceIDs))
	for chunk := range slices.Chunk(instanceIDs, filterBatch) {
		input := &ec2.DescribeVolumesInput{Filters: []ec2types.Filter{
			{Name: aws.String("attachment.instance-id"), Values: chunk},
			{Name: aws.String("attachment.status"), Values: []string{"attached"}},
		}}
		paginator := ec2.NewDescribeVolumesPaginator(c.EC2, input)
		for paginator.HasMorePages() {
			page, err := paginator.NextPage(ctx)
			if err != nil {
				return nil, fmt.Errorf("describe attached volumes: %w", err)
			}
			for _, v := range page.Volumes {
				for _, vol := range newVolumes(v) {
					out[vol.InstanceID] = append(out[vol.InstanceID], vol)
				}
			}
		}
	}
	return out, nil
}

// newVolumes flattens one EC2 volume into one Volume per attachment. A volume is
// normally attached to a single instance; Multi-Attach io2 volumes report several
// attachments and yield one entry each, so every owning instance sees it.
func newVolumes(v ec2types.Volume) []Volume {
	base := Volume{
		ID:              aws.ToString(v.VolumeId),
		Type:            string(v.VolumeType),
		SizeGiB:         aws.ToInt32(v.Size),
		ThroughputMiBps: aws.ToInt32(v.Throughput),
		IOPS:            aws.ToInt32(v.Iops),
	}
	out := make([]Volume, 0, len(v.Attachments))
	for _, att := range v.Attachments {
		vol := base
		vol.Device = aws.ToString(att.Device)
		vol.InstanceID = aws.ToString(att.InstanceId)
		out = append(out, vol)
	}
	return out
}

// DescribeInstanceTypeEBSCaps returns the EBS bandwidth caps of each given
// instance type, keyed by instance type name. Results are cached for the process
// lifetime: instance type capabilities are static AWS catalog data, so a cluster
// with a handful of instance types settles into zero API calls after the first
// pass. Types AWS does not report EBS-optimized info for are absent from the
// result.
func (c *Clients) DescribeInstanceTypeEBSCaps(ctx context.Context, instanceTypes []string) (map[string]EBSCaps, error) {
	out := make(map[string]EBSCaps, len(instanceTypes))
	missing := c.cachedEBSCaps(instanceTypes, out)
	if len(missing) == 0 {
		return out, nil
	}

	fetched := make(map[string]EBSCaps, len(missing))
	for chunk := range slices.Chunk(missing, instanceTypeBatch) {
		types := make([]ec2types.InstanceType, 0, len(chunk))
		for _, t := range chunk {
			types = append(types, ec2types.InstanceType(t))
		}
		paginator := ec2.NewDescribeInstanceTypesPaginator(c.EC2, &ec2.DescribeInstanceTypesInput{InstanceTypes: types})
		for paginator.HasMorePages() {
			page, err := paginator.NextPage(ctx)
			if err != nil {
				return nil, fmt.Errorf("describe instance types: %w", err)
			}
			for _, it := range page.InstanceTypes {
				caps, ok := newEBSCaps(it)
				if !ok {
					continue
				}
				fetched[string(it.InstanceType)] = caps
			}
		}
	}

	c.storeEBSCaps(fetched)
	maps.Copy(out, fetched)
	return out, nil
}

// newEBSCaps extracts the EBS bandwidth caps from one instance type. It reports
// false when AWS publishes no EBS-optimized bandwidth for the type, which is the
// case for older non-EBS-optimizable families.
func newEBSCaps(it ec2types.InstanceTypeInfo) (EBSCaps, bool) {
	if it.EbsInfo == nil || it.EbsInfo.EbsOptimizedInfo == nil {
		return EBSCaps{}, false
	}
	info := it.EbsInfo.EbsOptimizedInfo
	caps := EBSCaps{
		BaselineMBps: aws.ToFloat64(info.BaselineThroughputInMBps),
		MaximumMBps:  aws.ToFloat64(info.MaximumThroughputInMBps),
	}
	if caps.MaximumMBps <= 0 {
		return EBSCaps{}, false
	}
	// A non-burstable type reports only the maximum; treat it as the sustainable
	// rate too, so callers never see a zero baseline they have to special-case.
	if caps.BaselineMBps <= 0 {
		caps.BaselineMBps = caps.MaximumMBps
	}
	return caps, true
}

// cachedEBSCaps copies every already-cached entry into dst and returns the
// instance types still to fetch, deduplicated.
func (c *Clients) cachedEBSCaps(instanceTypes []string, dst map[string]EBSCaps) []string {
	c.ebsCapsMu.Lock()
	defer c.ebsCapsMu.Unlock()

	var missing []string
	seen := make(map[string]struct{}, len(instanceTypes))
	for _, t := range instanceTypes {
		if t == "" {
			continue
		}
		if _, dup := seen[t]; dup {
			continue
		}
		seen[t] = struct{}{}
		if caps, ok := c.ebsCaps[t]; ok {
			dst[t] = caps
			continue
		}
		missing = append(missing, t)
	}
	return missing
}

func (c *Clients) storeEBSCaps(caps map[string]EBSCaps) {
	c.ebsCapsMu.Lock()
	defer c.ebsCapsMu.Unlock()
	if c.ebsCaps == nil {
		c.ebsCaps = make(map[string]EBSCaps, len(caps))
	}
	maps.Copy(c.ebsCaps, caps)
}
