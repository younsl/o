package awsx

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

// TagFilter is a single EC2 tag key/value pair used to scope discovery.
type TagFilter struct {
	Key   string
	Value string
}

// DescribeTargetInstances returns running instances matching every tag filter,
// resolving each instance's root EBS volume ID and current size. When filters is
// empty every running instance in the account/region is a candidate. When
// excludeEKSNodes is true, instances that belong to an EKS cluster are dropped so
// only standalone EC2 instances remain.
func (c *Clients) DescribeTargetInstances(ctx context.Context, filters []TagFilter, excludeEKSNodes bool) ([]Instance, error) {
	ec2Filters := []ec2types.Filter{{
		Name:   aws.String("instance-state-name"),
		Values: []string{"running"},
	}}
	for _, f := range filters {
		ec2Filters = append(ec2Filters, ec2types.Filter{
			Name:   aws.String("tag:" + f.Key),
			Values: []string{f.Value},
		})
	}

	var instances []Instance
	paginator := ec2.NewDescribeInstancesPaginator(c.EC2, &ec2.DescribeInstancesInput{Filters: ec2Filters})
	for paginator.HasMorePages() {
		page, err := paginator.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("describe instances: %w", err)
		}
		for _, res := range page.Reservations {
			for _, inst := range res.Instances {
				if excludeEKSNodes && isEKSNode(inst) {
					continue
				}
				instances = append(instances, newInstance(inst))
			}
		}
	}

	for i := range instances {
		if instances[i].RootVolumeID == "" {
			continue
		}
		size, err := c.volumeSize(ctx, instances[i].RootVolumeID)
		if err != nil {
			return nil, err
		}
		instances[i].RootVolumeSizeGiB = size
	}
	return instances, nil
}

func newInstance(inst ec2types.Instance) Instance {
	out := Instance{
		ID:             aws.ToString(inst.InstanceId),
		RootDeviceName: aws.ToString(inst.RootDeviceName),
	}
	for _, tag := range inst.Tags {
		if aws.ToString(tag.Key) == "Name" {
			out.Name = aws.ToString(tag.Value)
		}
	}
	for _, bdm := range inst.BlockDeviceMappings {
		if aws.ToString(bdm.DeviceName) == out.RootDeviceName && bdm.Ebs != nil {
			out.RootVolumeID = aws.ToString(bdm.Ebs.VolumeId)
		}
	}
	return out
}

// isEKSNode reports whether an instance belongs to an EKS cluster, based on the
// tags AWS and Karpenter attach to cluster nodes:
//   - eks:cluster-name / aws:eks:cluster-name: EKS managed node groups
//   - kubernetes.io/cluster/<name>: any instance joined to a cluster (managed,
//     self-managed, or Karpenter-provisioned)
//   - karpenter.sh/*: Karpenter-provisioned nodes
func isEKSNode(inst ec2types.Instance) bool {
	for _, tag := range inst.Tags {
		key := aws.ToString(tag.Key)
		switch {
		case key == "eks:cluster-name", key == "aws:eks:cluster-name":
			return true
		case strings.HasPrefix(key, "kubernetes.io/cluster/"):
			return true
		case strings.HasPrefix(key, "karpenter.sh/"):
			return true
		}
	}
	return false
}

func (c *Clients) volumeSize(ctx context.Context, volumeID string) (int32, error) {
	out, err := c.EC2.DescribeVolumes(ctx, &ec2.DescribeVolumesInput{VolumeIds: []string{volumeID}})
	if err != nil {
		return 0, fmt.Errorf("describe volume %s: %w", volumeID, err)
	}
	if len(out.Volumes) == 0 {
		return 0, fmt.Errorf("volume %s not found", volumeID)
	}
	return aws.ToInt32(out.Volumes[0].Size), nil
}

// ModifyVolume requests a new size (GiB) for the given EBS volume.
func (c *Clients) ModifyVolume(ctx context.Context, volumeID string, sizeGiB int32) error {
	_, err := c.EC2.ModifyVolume(ctx, &ec2.ModifyVolumeInput{
		VolumeId: aws.String(volumeID),
		Size:     aws.Int32(sizeGiB),
	})
	if err != nil {
		return fmt.Errorf("modify volume %s to %d GiB: %w", volumeID, sizeGiB, err)
	}
	return nil
}

// DescribeLastModification returns the most recent modification for a volume,
// or nil if the volume has never been modified.
func (c *Clients) DescribeLastModification(ctx context.Context, volumeID string) (*VolumeModification, error) {
	out, err := c.EC2.DescribeVolumesModifications(ctx, &ec2.DescribeVolumesModificationsInput{
		VolumeIds: []string{volumeID},
	})
	if err != nil {
		return nil, fmt.Errorf("describe volume modifications %s: %w", volumeID, err)
	}
	if len(out.VolumesModifications) == 0 {
		return nil, nil
	}
	m := out.VolumesModifications[0]
	return &VolumeModification{
		State:     string(m.ModificationState),
		StartTime: aws.ToTime(m.StartTime),
		TargetGiB: aws.ToInt32(m.TargetSize),
	}, nil
}

// errModificationPending is returned by the poller while a modification has not
// yet reached a usable state.
var errModificationPending = errors.New("modification still in progress")

// WaitForModification polls until the volume modification reaches "optimizing"
// or "completed" (filesystem extension is safe from optimizing onward), or the
// timeout elapses.
func (c *Clients) WaitForModification(ctx context.Context, volumeID string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		m, err := c.DescribeLastModification(ctx, volumeID)
		if err != nil {
			return err
		}
		if m != nil {
			switch m.State {
			case "optimizing", "completed":
				return nil
			case "failed":
				return fmt.Errorf("volume %s modification failed", volumeID)
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("volume %s modification did not reach optimizing within %s: %w", volumeID, timeout, errModificationPending)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(c.pollInterval()):
		}
	}
}
