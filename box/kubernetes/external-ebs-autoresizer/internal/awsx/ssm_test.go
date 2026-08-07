package awsx

import (
	"context"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

type fakeSSMSDK struct {
	sendOut     *ssm.SendCommandOutput
	invSequence []*ssm.GetCommandInvocationOutput
	invIdx      int
}

func (f *fakeSSMSDK) SendCommand(context.Context, *ssm.SendCommandInput, ...func(*ssm.Options)) (*ssm.SendCommandOutput, error) {
	return f.sendOut, nil
}
func (f *fakeSSMSDK) GetCommandInvocation(context.Context, *ssm.GetCommandInvocationInput, ...func(*ssm.Options)) (*ssm.GetCommandInvocationOutput, error) {
	out := f.invSequence[f.invIdx]
	if f.invIdx < len(f.invSequence)-1 {
		f.invIdx++
	}
	return out, nil
}

func sendOut() *ssm.SendCommandOutput {
	return &ssm.SendCommandOutput{Command: &ssmtypes.Command{CommandId: aws.String("cmd-1")}}
}

func TestRunScriptSuccess(t *testing.T) {
	fake := &fakeSSMSDK{
		sendOut: sendOut(),
		invSequence: []*ssm.GetCommandInvocationOutput{
			{Status: ssmtypes.CommandInvocationStatusInProgress},
			{Status: ssmtypes.CommandInvocationStatusSuccess, StandardOutputContent: aws.String("73\n"), ResponseCode: 0},
		},
	}
	c := &Clients{SSM: fake, PollInterval: time.Millisecond}
	res, err := c.RunScript(context.Background(), "i-1", "df ...", time.Second)
	if err != nil {
		t.Fatalf("RunScript error: %v", err)
	}
	if res.Stdout != "73\n" || res.Status != string(ssmtypes.CommandInvocationStatusSuccess) {
		t.Errorf("result = %+v, unexpected", res)
	}
}

func TestRunScriptFailure(t *testing.T) {
	fake := &fakeSSMSDK{
		sendOut: sendOut(),
		invSequence: []*ssm.GetCommandInvocationOutput{
			{Status: ssmtypes.CommandInvocationStatusFailed, StandardErrorContent: aws.String("boom"), ResponseCode: 1},
		},
	}
	c := &Clients{SSM: fake, PollInterval: time.Millisecond}
	if _, err := c.RunScript(context.Background(), "i-1", "bad", time.Second); err == nil {
		t.Error("RunScript = nil error, want failure")
	}
}

func TestRunScriptContextCancel(t *testing.T) {
	fake := &fakeSSMSDK{
		sendOut: sendOut(),
		invSequence: []*ssm.GetCommandInvocationOutput{
			{Status: ssmtypes.CommandInvocationStatusInProgress},
		},
	}
	c := &Clients{SSM: fake, PollInterval: 10 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.RunScript(ctx, "i-1", "df", time.Second); err == nil {
		t.Error("RunScript = nil error, want context cancellation")
	}
}
