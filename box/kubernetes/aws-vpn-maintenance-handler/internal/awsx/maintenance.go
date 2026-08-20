package awsx

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
	"github.com/aws/smithy-go"
)

// pendingMaintenanceAvailable is the PendingMaintenance value AWS reports when a
// replacement is queued and can be triggered early. The other is "NOT_AVAILABLE".
const pendingMaintenanceAvailable = "AVAILABLE"

// MaintenanceStatus reads one tunnel's pending endpoint maintenance. This is the
// authoritative source, so a missed AWS Health notification cannot hide queued work.
func (c *Client) MaintenanceStatus(ctx context.Context, connectionID, outsideIP string) (Maintenance, error) {
	out, err := c.api.GetVpnTunnelReplacementStatus(ctx, &ec2.GetVpnTunnelReplacementStatusInput{
		VpnConnectionId:           aws.String(connectionID),
		VpnTunnelOutsideIpAddress: aws.String(outsideIP),
	})
	if err != nil {
		return Maintenance{}, fmt.Errorf("get vpn tunnel replacement status %s/%s: %w", connectionID, outsideIP, err)
	}

	var m Maintenance
	if d := out.MaintenanceDetails; d != nil {
		m.Pending = strings.EqualFold(aws.ToString(d.PendingMaintenance), pendingMaintenanceAvailable)
		if d.MaintenanceAutoAppliedAfter != nil {
			m.AutoAppliedAfter = *d.MaintenanceAutoAppliedAfter
		}
		if d.LastMaintenanceApplied != nil {
			m.LastApplied = *d.LastMaintenanceApplied
		}
	}
	return m, nil
}

// Statuses reads maintenance state for every tunnel. One call per tunnel: the API
// has no batch form.
func (c *Client) Statuses(ctx context.Context, conn Connection) ([]TunnelStatus, error) {
	statuses := make([]TunnelStatus, 0, len(conn.Tunnels))
	for _, t := range conn.Tunnels {
		m, err := c.MaintenanceStatus(ctx, conn.ID, t.OutsideIP)
		if err != nil {
			return nil, err
		}
		statuses = append(statuses, TunnelStatus{Tunnel: t, Maintenance: m})
	}
	return statuses, nil
}

// ErrDryRunSucceeded reports that a dry-run call was accepted, so arguments and IAM
// permissions are valid. AWS signals this with the DryRunOperation error code, so
// success arrives as an error and is translated back here.
var ErrDryRunSucceeded = errors.New("dry run succeeded: ReplaceVpnTunnel would have been accepted")

// ErrReplaceUncertain reports that the ReplaceVpnTunnel call did not come back with
// a definite answer, so the replacement may or may not be under way. The caller must
// verify rather than report that nothing changed.
var ErrReplaceUncertain = errors.New("replacement request outcome is unknown")

// Replace triggers the pending endpoint maintenance for one tunnel.
//
// Irreversible: there is no API to undo it or restore the old endpoint, so every
// safety check belongs before this call. The tunnel goes DOWN for the duration, so
// the caller must have confirmed the peer is carrying traffic. With dryRun, AWS
// validates and changes nothing, returning ErrDryRunSucceeded.
func (c *Client) Replace(ctx context.Context, connectionID, outsideIP string, dryRun bool) error {
	_, err := c.api.ReplaceVpnTunnel(ctx, &ec2.ReplaceVpnTunnelInput{
		VpnConnectionId:           aws.String(connectionID),
		VpnTunnelOutsideIpAddress: aws.String(outsideIP),
		ApplyPendingMaintenance:   aws.Bool(true),
		DryRun:                    aws.Bool(dryRun),
	})
	if err != nil {
		if isDryRunSuccess(err) {
			return ErrDryRunSucceeded
		}
		if !isDefiniteRejection(err) {
			return fmt.Errorf("%w: replace vpn tunnel %s/%s: %w",
				ErrReplaceUncertain, connectionID, outsideIP, err)
		}
		return fmt.Errorf("replace vpn tunnel %s/%s: %w", connectionID, outsideIP, err)
	}
	return nil
}

// isDefiniteRejection reports whether AWS answered and refused.
//
// Only a client-fault API error proves the replacement did not start: the service
// received the request, evaluated it, and rejected it. A timeout, a cancelled
// context, a connection failure, or a server-fault response leaves the outcome
// unknown, because the request may have been accepted and only the answer lost.
// Treating those as "nothing happened" is how a real replacement ends up with
// nobody watching it.
func isDefiniteRejection(err error) bool {
	var ae smithy.APIError
	if !errors.As(err, &ae) {
		return false
	}
	return ae.ErrorFault() == smithy.FaultClient
}

// isDryRunSuccess reports whether err is the DryRunOperation code AWS returns
// when a dry-run request would have been permitted.
func isDryRunSuccess(err error) bool {
	if ae, ok := errors.AsType[smithy.APIError](err); ok {
		return ae.ErrorCode() == "DryRunOperation"
	}
	return false
}
