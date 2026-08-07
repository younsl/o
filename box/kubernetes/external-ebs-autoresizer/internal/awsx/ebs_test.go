package awsx

import (
	"context"
	"errors"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

func TestDescribeAttachedVolumes(t *testing.T) {
	fake := &fakeEC2SDK{describeVolumes: &ec2.DescribeVolumesOutput{
		Volumes: []ec2types.Volume{
			{
				VolumeId:   aws.String("vol-1"),
				VolumeType: ec2types.VolumeTypeGp3,
				Size:       aws.Int32(100),
				Iops:       aws.Int32(3000),
				Throughput: aws.Int32(125),
				Attachments: []ec2types.VolumeAttachment{{
					Device: aws.String("/dev/xvda"), InstanceId: aws.String("i-1"),
				}},
			},
			{
				VolumeId:   aws.String("vol-2"),
				VolumeType: ec2types.VolumeTypeGp2,
				Size:       aws.Int32(50),
				Attachments: []ec2types.VolumeAttachment{{
					Device: aws.String("/dev/xvdb"), InstanceId: aws.String("i-2"),
				}},
			},
		},
	}}
	c := &Clients{EC2: fake}

	got, err := c.DescribeAttachedVolumes(context.Background(), []string{"i-1", "i-2"})
	if err != nil {
		t.Fatalf("DescribeAttachedVolumes() error = %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("instances = %d, want 2", len(got))
	}
	v := got["i-1"][0]
	if v.ID != "vol-1" || v.Type != "gp3" || v.ThroughputMiBps != 125 || v.IOPS != 3000 || v.SizeGiB != 100 {
		t.Errorf("volume = %+v, want the gp3 performance values populated", v)
	}
	if v.Device != "/dev/xvda" || v.InstanceID != "i-1" {
		t.Errorf("volume attachment = %q on %q, want /dev/xvda on i-1", v.Device, v.InstanceID)
	}
	// gp2 reports no throughput; the zero must survive rather than become a
	// misleading default.
	if got["i-2"][0].ThroughputMiBps != 0 {
		t.Errorf("gp2 throughput = %d, want 0", got["i-2"][0].ThroughputMiBps)
	}

	// Only attached volumes are of interest: a volume in the process of detaching
	// no longer carries the node's IO.
	if len(fake.describeVolumesInputs) != 1 {
		t.Fatalf("describe calls = %d, want 1", len(fake.describeVolumesInputs))
	}
	var names []string
	for _, f := range fake.describeVolumesInputs[0].Filters {
		names = append(names, aws.ToString(f.Name))
	}
	if len(names) != 2 || names[0] != "attachment.instance-id" || names[1] != "attachment.status" {
		t.Errorf("filters = %v, want instance-id and attached status", names)
	}
}

func TestDescribeAttachedVolumesMultiAttach(t *testing.T) {
	// A Multi-Attach io2 volume reports one attachment per instance; every owning
	// instance must see it, or a node would look like it has no volume.
	fake := &fakeEC2SDK{describeVolumes: &ec2.DescribeVolumesOutput{
		Volumes: []ec2types.Volume{{
			VolumeId:   aws.String("vol-shared"),
			VolumeType: ec2types.VolumeTypeIo2,
			Attachments: []ec2types.VolumeAttachment{
				{Device: aws.String("/dev/xvdf"), InstanceId: aws.String("i-1")},
				{Device: aws.String("/dev/xvdf"), InstanceId: aws.String("i-2")},
			},
		}},
	}}
	c := &Clients{EC2: fake}

	got, err := c.DescribeAttachedVolumes(context.Background(), []string{"i-1", "i-2"})
	if err != nil {
		t.Fatalf("DescribeAttachedVolumes() error = %v", err)
	}
	if len(got["i-1"]) != 1 || len(got["i-2"]) != 1 {
		t.Errorf("volumes = %v, want the shared volume on both instances", got)
	}
}

func TestDescribeAttachedVolumesNoInstances(t *testing.T) {
	fake := &fakeEC2SDK{}
	c := &Clients{EC2: fake}

	got, err := c.DescribeAttachedVolumes(context.Background(), nil)
	if err != nil {
		t.Fatalf("DescribeAttachedVolumes() error = %v", err)
	}
	if len(got) != 0 {
		t.Errorf("volumes = %v, want empty", got)
	}
	if len(fake.describeVolumesInputs) != 0 {
		t.Errorf("describe calls = %d, want none for an empty instance set", len(fake.describeVolumesInputs))
	}
}

func TestDescribeAttachedVolumesChunksLargeInstanceSets(t *testing.T) {
	// EC2 caps filter values per request, so a cluster larger than the batch size
	// must be split rather than sent as one oversized filter.
	instanceIDs := make([]string, filterBatch+1)
	for i := range instanceIDs {
		instanceIDs[i] = "i-" + string(rune('a'+i%26))
	}
	fake := &fakeEC2SDK{describeVolumes: &ec2.DescribeVolumesOutput{}}
	c := &Clients{EC2: fake}

	if _, err := c.DescribeAttachedVolumes(context.Background(), instanceIDs); err != nil {
		t.Fatalf("DescribeAttachedVolumes() error = %v", err)
	}
	if len(fake.describeVolumesInputs) != 2 {
		t.Fatalf("describe calls = %d, want 2 batches", len(fake.describeVolumesInputs))
	}
	if got := len(fake.describeVolumesInputs[0].Filters[0].Values); got != filterBatch {
		t.Errorf("first batch = %d instance IDs, want %d", got, filterBatch)
	}
	if got := len(fake.describeVolumesInputs[1].Filters[0].Values); got != 1 {
		t.Errorf("second batch = %d instance IDs, want 1", got)
	}
}

func TestDescribeAttachedVolumesError(t *testing.T) {
	c := &Clients{EC2: &fakeEC2SDK{describeVolumesErr: errors.New("throttled")}}
	if _, err := c.DescribeAttachedVolumes(context.Background(), []string{"i-1"}); err == nil {
		t.Fatal("DescribeAttachedVolumes() error = nil, want the API error")
	}
}

func instanceTypeInfo(name string, baseline, maximum *float64) ec2types.InstanceTypeInfo {
	return ec2types.InstanceTypeInfo{
		InstanceType: ec2types.InstanceType(name),
		EbsInfo: &ec2types.EbsInfo{EbsOptimizedInfo: &ec2types.EbsOptimizedInfo{
			BaselineThroughputInMBps: baseline,
			MaximumThroughputInMBps:  maximum,
		}},
	}
}

func TestDescribeInstanceTypeEBSCaps(t *testing.T) {
	fake := &fakeEC2SDK{instanceTypes: &ec2.DescribeInstanceTypesOutput{
		InstanceTypes: []ec2types.InstanceTypeInfo{
			instanceTypeInfo("m5.large", aws.Float64(81.25), aws.Float64(593.75)),
			// A non-burstable type publishes only the maximum.
			instanceTypeInfo("m5.24xlarge", nil, aws.Float64(2375)),
			// An older family with no EBS-optimized info at all.
			{InstanceType: ec2types.InstanceType("t1.micro")},
		},
	}}
	c := &Clients{EC2: fake}

	got, err := c.DescribeInstanceTypeEBSCaps(context.Background(), []string{"m5.large", "m5.24xlarge", "t1.micro"})
	if err != nil {
		t.Fatalf("DescribeInstanceTypeEBSCaps() error = %v", err)
	}
	if got["m5.large"] != (EBSCaps{BaselineMBps: 81.25, MaximumMBps: 593.75}) {
		t.Errorf("m5.large = %+v, want 81.25/593.75", got["m5.large"])
	}
	// A missing baseline becomes the maximum so callers never see a zero they have
	// to special-case as "unlimited".
	if got["m5.24xlarge"] != (EBSCaps{BaselineMBps: 2375, MaximumMBps: 2375}) {
		t.Errorf("m5.24xlarge = %+v, want the maximum used as the baseline", got["m5.24xlarge"])
	}
	if _, ok := got["t1.micro"]; ok {
		t.Errorf("t1.micro = %+v, want it absent rather than zero-valued", got["t1.micro"])
	}
}

func TestDescribeInstanceTypeEBSCapsCaches(t *testing.T) {
	// Instance type capabilities are static catalog data, so a steady cluster must
	// settle into zero API calls instead of re-describing the same types hourly.
	fake := &fakeEC2SDK{instanceTypes: &ec2.DescribeInstanceTypesOutput{
		InstanceTypes: []ec2types.InstanceTypeInfo{
			instanceTypeInfo("m5.large", aws.Float64(81.25), aws.Float64(593.75)),
		},
	}}
	c := &Clients{EC2: fake}

	for range 3 {
		got, err := c.DescribeInstanceTypeEBSCaps(context.Background(), []string{"m5.large", "m5.large"})
		if err != nil {
			t.Fatalf("DescribeInstanceTypeEBSCaps() error = %v", err)
		}
		if got["m5.large"].MaximumMBps != 593.75 {
			t.Fatalf("m5.large = %+v, want the cached value", got["m5.large"])
		}
	}
	if len(fake.instanceTypesInputs) != 1 {
		t.Errorf("describe calls = %d, want 1: later passes must hit the cache", len(fake.instanceTypesInputs))
	}
	// The duplicate instance type in the request must not be described twice.
	if got := len(fake.instanceTypesInputs[0].InstanceTypes); got != 1 {
		t.Errorf("described types = %d, want 1 after deduplication", got)
	}
}

func TestDescribeInstanceTypeEBSCapsSkipsEmptyNames(t *testing.T) {
	// A Node without the instance-type label yields an empty string; describing it
	// would fail the whole request for every other node.
	fake := &fakeEC2SDK{}
	c := &Clients{EC2: fake}

	got, err := c.DescribeInstanceTypeEBSCaps(context.Background(), []string{"", ""})
	if err != nil {
		t.Fatalf("DescribeInstanceTypeEBSCaps() error = %v", err)
	}
	if len(got) != 0 {
		t.Errorf("caps = %v, want empty", got)
	}
	if len(fake.instanceTypesInputs) != 0 {
		t.Errorf("describe calls = %d, want none", len(fake.instanceTypesInputs))
	}
}

func TestDescribeInstanceTypeEBSCapsError(t *testing.T) {
	c := &Clients{EC2: &fakeEC2SDK{instanceTypesErr: errors.New("throttled")}}
	if _, err := c.DescribeInstanceTypeEBSCaps(context.Background(), []string{"m5.large"}); err == nil {
		t.Fatal("DescribeInstanceTypeEBSCaps() error = nil, want the API error")
	}
}
