// Package awsx wraps the AWS SDK with the narrow EC2 and SSM operations the
// resizer needs, and centralizes credential resolution.
package awsx

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
)

// EC2Client is the subset of the EC2 SDK client used here. The concrete
// *ec2.Client satisfies it; tests provide fakes.
type EC2Client interface {
	DescribeInstances(context.Context, *ec2.DescribeInstancesInput, ...func(*ec2.Options)) (*ec2.DescribeInstancesOutput, error)
	DescribeVolumes(context.Context, *ec2.DescribeVolumesInput, ...func(*ec2.Options)) (*ec2.DescribeVolumesOutput, error)
	ModifyVolume(context.Context, *ec2.ModifyVolumeInput, ...func(*ec2.Options)) (*ec2.ModifyVolumeOutput, error)
	DescribeVolumesModifications(context.Context, *ec2.DescribeVolumesModificationsInput, ...func(*ec2.Options)) (*ec2.DescribeVolumesModificationsOutput, error)
}

// SSMClient is the subset of the SSM SDK client used here.
type SSMClient interface {
	SendCommand(context.Context, *ssm.SendCommandInput, ...func(*ssm.Options)) (*ssm.SendCommandOutput, error)
	GetCommandInvocation(context.Context, *ssm.GetCommandInvocationInput, ...func(*ssm.Options)) (*ssm.GetCommandInvocationOutput, error)
}

// Clients bundles the AWS service clients used by the resizer.
type Clients struct {
	EC2 EC2Client
	SSM SSMClient
	// PollInterval is the delay between status polls for volume modifications
	// and SSM command invocations. Defaults to defaultPollInterval when zero.
	PollInterval time.Duration
}

const defaultPollInterval = 1 * time.Second

func (c *Clients) pollInterval() time.Duration {
	if c.PollInterval > 0 {
		return c.PollInterval
	}
	return defaultPollInterval
}

// New builds AWS service clients for the given region. Credentials resolve via
// the default chain, which in-cluster is the pod's own IRSA role; the pod
// always operates under its own identity.
func New(ctx context.Context, region string) (*Clients, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, fmt.Errorf("load aws config: %w", err)
	}

	return &Clients{
		EC2: ec2.NewFromConfig(cfg),
		SSM: ssm.NewFromConfig(cfg),
	}, nil
}
