package awsx

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
	"github.com/aws/smithy-go"
)

type fakeEC2SDK struct {
	describeInstances     *ec2.DescribeInstancesOutput
	describeVolumes       *ec2.DescribeVolumesOutput
	modifications         *ec2.DescribeVolumesModificationsOutput
	modificationsSequence []*ec2.DescribeVolumesModificationsOutput
	modificationsErr      error
	modifyInput           *ec2.ModifyVolumeInput
	modCallIdx            int
}

func (f *fakeEC2SDK) DescribeInstances(context.Context, *ec2.DescribeInstancesInput, ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error) {
	return f.describeInstances, nil
}
func (f *fakeEC2SDK) DescribeVolumes(context.Context, *ec2.DescribeVolumesInput, ...func(*ec2.Options)) (*ec2.DescribeVolumesOutput, error) {
	return f.describeVolumes, nil
}
func (f *fakeEC2SDK) ModifyVolume(_ context.Context, in *ec2.ModifyVolumeInput, _ ...func(*ec2.Options)) (*ec2.ModifyVolumeOutput, error) {
	f.modifyInput = in
	return &ec2.ModifyVolumeOutput{}, nil
}
func (f *fakeEC2SDK) DescribeVolumesModifications(context.Context, *ec2.DescribeVolumesModificationsInput, ...func(*ec2.Options)) (*ec2.DescribeVolumesModificationsOutput, error) {
	if f.modificationsErr != nil {
		return nil, f.modificationsErr
	}
	if len(f.modificationsSequence) > 0 {
		out := f.modificationsSequence[f.modCallIdx]
		if f.modCallIdx < len(f.modificationsSequence)-1 {
			f.modCallIdx++
		}
		return out, nil
	}
	return f.modifications, nil
}

func TestDescribeTargetInstances(t *testing.T) {
	fake := &fakeEC2SDK{
		describeInstances: &ec2.DescribeInstancesOutput{
			Reservations: []ec2types.Reservation{{
				Instances: []ec2types.Instance{{
					InstanceId:     aws.String("i-1"),
					RootDeviceName: aws.String("/dev/xvda"),
					Tags:           []ec2types.Tag{{Key: aws.String("Name"), Value: aws.String("web")}},
					BlockDeviceMappings: []ec2types.InstanceBlockDeviceMapping{{
						DeviceName: aws.String("/dev/xvda"),
						Ebs:        &ec2types.EbsInstanceBlockDevice{VolumeId: aws.String("vol-1")},
					}},
				}},
			}},
		},
		describeVolumes: &ec2.DescribeVolumesOutput{
			Volumes: []ec2types.Volume{{Size: aws.Int32(100)}},
		},
	}
	c := &Clients{EC2: fake}

	got, err := c.DescribeTargetInstances(context.Background(), []TagFilter{{Key: "App", Value: "web"}}, true)
	if err != nil {
		t.Fatalf("DescribeTargetInstances error: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d instances, want 1", len(got))
	}
	inst := got[0]
	if inst.ID != "i-1" || inst.Name != "web" || inst.RootVolumeID != "vol-1" || inst.RootVolumeSizeGiB != 100 {
		t.Errorf("instance = %+v, unexpected fields", inst)
	}
}

func TestDescribeTargetInstancesExcludesEKSNodes(t *testing.T) {
	tagged := func(id string, tags ...ec2types.Tag) ec2types.Instance {
		return ec2types.Instance{
			InstanceId:     aws.String(id),
			RootDeviceName: aws.String("/dev/xvda"),
			Tags:           tags,
			BlockDeviceMappings: []ec2types.InstanceBlockDeviceMapping{{
				DeviceName: aws.String("/dev/xvda"),
				Ebs:        &ec2types.EbsInstanceBlockDevice{VolumeId: aws.String("vol-" + id)},
			}},
		}
	}
	tag := func(k, v string) ec2types.Tag { return ec2types.Tag{Key: aws.String(k), Value: aws.String(v)} }

	fake := &fakeEC2SDK{
		describeInstances: &ec2.DescribeInstancesOutput{
			Reservations: []ec2types.Reservation{{
				Instances: []ec2types.Instance{
					tagged("standalone", tag("Name", "app")),
					tagged("mng", tag("eks:cluster-name", "prod")),
					tagged("self", tag("kubernetes.io/cluster/prod", "owned")),
					tagged("karpenter", tag("karpenter.sh/nodepool", "default")),
				},
			}},
		},
		describeVolumes: &ec2.DescribeVolumesOutput{Volumes: []ec2types.Volume{{Size: aws.Int32(50)}}},
	}
	c := &Clients{EC2: fake}

	got, err := c.DescribeTargetInstances(context.Background(), nil, true)
	if err != nil {
		t.Fatalf("DescribeTargetInstances error: %v", err)
	}
	if len(got) != 1 || got[0].ID != "standalone" {
		t.Fatalf("got %+v, want only the standalone instance", got)
	}

	got, err = c.DescribeTargetInstances(context.Background(), nil, false)
	if err != nil {
		t.Fatalf("DescribeTargetInstances error: %v", err)
	}
	if len(got) != 4 {
		t.Errorf("got %d instances with exclusion off, want 4", len(got))
	}
}

func TestModifyVolume(t *testing.T) {
	fake := &fakeEC2SDK{}
	c := &Clients{EC2: fake}
	if err := c.ModifyVolume(context.Background(), "vol-9", 220); err != nil {
		t.Fatalf("ModifyVolume error: %v", err)
	}
	if aws.ToString(fake.modifyInput.VolumeId) != "vol-9" || aws.ToInt32(fake.modifyInput.Size) != 220 {
		t.Errorf("ModifyVolume input = %+v, want vol-9/220", fake.modifyInput)
	}
}

func TestDescribeLastModificationNone(t *testing.T) {
	c := &Clients{EC2: &fakeEC2SDK{modifications: &ec2.DescribeVolumesModificationsOutput{}}}
	m, err := c.DescribeLastModification(context.Background(), "vol-1")
	if err != nil {
		t.Fatalf("error: %v", err)
	}
	if m != nil {
		t.Errorf("got %+v, want nil for no modifications", m)
	}
}

// A volume that has never been modified makes EC2 return
// InvalidVolumeModification.NotFound; it must be treated as "no modification",
// not as a reconcile failure.
func TestDescribeLastModificationNotFound(t *testing.T) {
	c := &Clients{EC2: &fakeEC2SDK{modificationsErr: &smithy.GenericAPIError{
		Code:    "InvalidVolumeModification.NotFound",
		Message: "Modification for volume 'vol-1' does not exist.",
	}}}
	m, err := c.DescribeLastModification(context.Background(), "vol-1")
	if err != nil {
		t.Fatalf("got error %v, want nil for never-modified volume", err)
	}
	if m != nil {
		t.Errorf("got %+v, want nil for never-modified volume", m)
	}
}

func TestDescribeLastModificationOtherError(t *testing.T) {
	c := &Clients{EC2: &fakeEC2SDK{modificationsErr: &smithy.GenericAPIError{
		Code:    "UnauthorizedOperation",
		Message: "not allowed",
	}}}
	if _, err := c.DescribeLastModification(context.Background(), "vol-1"); err == nil {
		t.Error("got nil error, want failure for non-NotFound API error")
	}
}

func TestWaitForModificationReachesOptimizing(t *testing.T) {
	fake := &fakeEC2SDK{
		modificationsSequence: []*ec2.DescribeVolumesModificationsOutput{
			{VolumesModifications: []ec2types.VolumeModification{{ModificationState: ec2types.VolumeModificationStateModifying}}},
			{VolumesModifications: []ec2types.VolumeModification{{ModificationState: ec2types.VolumeModificationStateOptimizing}}},
		},
	}
	c := &Clients{EC2: fake, PollInterval: time.Millisecond}
	if err := c.WaitForModification(context.Background(), "vol-1", time.Second); err != nil {
		t.Fatalf("WaitForModification error: %v", err)
	}
}

func TestWaitForModificationFails(t *testing.T) {
	fake := &fakeEC2SDK{
		modifications: &ec2.DescribeVolumesModificationsOutput{
			VolumesModifications: []ec2types.VolumeModification{{ModificationState: ec2types.VolumeModificationStateFailed}},
		},
	}
	c := &Clients{EC2: fake, PollInterval: time.Millisecond}
	if err := c.WaitForModification(context.Background(), "vol-1", time.Second); err == nil {
		t.Error("WaitForModification = nil error, want failure")
	}
}
