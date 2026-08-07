package awsx

import (
	"context"
	"fmt"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	ssmtypes "github.com/aws/aws-sdk-go-v2/service/ssm/types"
)

// runShellDocument is the AWS-managed document for ad-hoc shell execution.
const runShellDocument = "AWS-RunShellScript"

// RunScript runs a shell script on the instance via SSM RunShellScript and
// polls until the invocation reaches a terminal state or the timeout elapses.
func (c *Clients) RunScript(ctx context.Context, instanceID, script string, timeout time.Duration) (CommandResult, error) {
	send, err := c.SSM.SendCommand(ctx, &ssm.SendCommandInput{
		InstanceIds:    []string{instanceID},
		DocumentName:   aws.String(runShellDocument),
		TimeoutSeconds: aws.Int32(int32(timeout.Seconds())),
		Parameters: map[string][]string{
			"commands": {script},
		},
	})
	if err != nil {
		return CommandResult{}, fmt.Errorf("send command to %s: %w", instanceID, err)
	}
	commandID := aws.ToString(send.Command.CommandId)

	deadline := time.Now().Add(timeout)
	for {
		select {
		case <-ctx.Done():
			return CommandResult{}, ctx.Err()
		case <-time.After(c.pollInterval()):
		}

		inv, err := c.SSM.GetCommandInvocation(ctx, &ssm.GetCommandInvocationInput{
			CommandId:  aws.String(commandID),
			InstanceId: aws.String(instanceID),
		})
		if err != nil {
			// The invocation may not be registered immediately after SendCommand.
			if time.Now().After(deadline) {
				return CommandResult{}, fmt.Errorf("get command invocation %s: %w", commandID, err)
			}
			continue
		}

		switch inv.Status {
		case ssmtypes.CommandInvocationStatusSuccess,
			ssmtypes.CommandInvocationStatusFailed,
			ssmtypes.CommandInvocationStatusCancelled,
			ssmtypes.CommandInvocationStatusTimedOut:
			res := CommandResult{
				Status:   string(inv.Status),
				ExitCode: inv.ResponseCode,
				Stdout:   aws.ToString(inv.StandardOutputContent),
				Stderr:   aws.ToString(inv.StandardErrorContent),
			}
			if inv.Status != ssmtypes.CommandInvocationStatusSuccess {
				return res, fmt.Errorf("command %s on %s ended with status %s (exit %d): %s",
					commandID, instanceID, inv.Status, inv.ResponseCode, res.Stderr)
			}
			return res, nil
		}

		if time.Now().After(deadline) {
			return CommandResult{}, fmt.Errorf("command %s on %s did not finish within %s", commandID, instanceID, timeout)
		}
	}
}
