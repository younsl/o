package awsx

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	ec2types "github.com/aws/aws-sdk-go-v2/service/ec2/types"
)

type fakeEC2SDK struct {
	describeInstances     *ec2.DescribeInstancesOutput
	describeVolumes       *ec2.DescribeVolumesOutput
	modifications         *ec2.DescribeVolumesModificationsOutput
	modificationsSequence []*ec2.DescribeVolumesModificationsOutput
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

	got, err := c.DescribeTargetInstances(context.Background(), []TagFilter{{Key: "App", Value: "web"}})
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
