package main

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/config"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/promx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
)

// verifyDependencies refuses to start when the controller could not do its job.
//
// The failure this prevents is the quiet one. A missing IAM permission or an
// unreachable metric endpoint does not crash a running controller: it turns every
// pass into a logged error or a blocked candidate, and the tunnel is still handed to
// AWS at its own auto-apply time while the Pod reports Ready. Failing at startup
// makes that a CrashLoopBackOff, which someone notices.
func verifyDependencies(ctx context.Context, cfg *config.Config, vpn *awsx.Client, gate *promx.Gate, logger *slog.Logger) error {
	access, err := vpn.VerifyAccess(ctx, awsx.DiscoverInput{
		TagFilters: tagFilters(cfg),
		ExcludeIDs: cfg.Targets.ExcludeConnectionIDs,
	})
	if err != nil {
		logger.Error("AWS access check failed; refusing to start", "error", err,
			"hint", "check the IRSA or EKS Pod Identity association on this ServiceAccount and the role's EC2 permissions")
		return err
	}
	logger.Info("AWS access verified",
		"identity", access.Identity, "account", access.Account,
		"region", cfg.Region, "managed_connections", len(access.Connections))
	if len(access.Connections) == 0 {
		// Not fatal: an account with nothing enrolled yet is a legitimate state, and
		// the controller re-discovers every pass. It is a warning because the far more
		// likely cause is a tag filter that matches nothing.
		logger.Warn("no VPN connection matches the configured tag filters, so there is nothing to manage yet",
			"tag_filters", len(cfg.Targets.TagFilters))
	}

	if !gate.Enabled() {
		return nil
	}
	if err := gate.Verify(ctx, gateProbe(cfg, access.Connections)); err != nil {
		if gate.FailClosed() {
			logger.Error("traffic gate check failed; refusing to start", "error", err,
				"hint", "fix the endpoint, its headers, or the exporter, or set trafficGate.onError to allow")
			return err
		}
		// onError is allow, which is an explicit decision that an unavailable metric
		// source must not stop maintenance. Starting anyway is that same decision.
		logger.Warn("traffic gate could not be verified, and onError is allow, so replacements will proceed "+
			"without a traffic verdict until it recovers", "error", err)
	}
	return nil
}

// gateProbe picks the connection the gate is verified against. Any managed connection
// proves the exporter publishes the metric; the first one keeps startup to one query.
func gateProbe(cfg *config.Config, conns []awsx.Connection) promx.Vars {
	v := promx.Vars{Region: cfg.Region}
	if len(conns) == 0 {
		return v
	}
	conn := conns[0]
	v.VPNConnectionID = conn.ID
	v.VPNName = conn.Name
	if len(conn.Tunnels) > 0 {
		v.TunnelIP = conn.Tunnels[0].OutsideIP
	}
	if len(conn.Tunnels) > 1 {
		v.PeerIP = conn.Tunnels[1].OutsideIP
	}
	return v
}

// formatApprovers renders the approver list as "name (ID)" entries. Both halves are
// present on purpose: the name is what a reviewer recognizes, the ID is what actually
// authorizes a click and what appears in a Slack payload.
func formatApprovers(approvers []slackx.Approver) string {
	entries := make([]string, 0, len(approvers))
	for _, a := range approvers {
		if a.Name == a.ID {
			entries = append(entries, a.ID)
			continue
		}
		entries = append(entries, fmt.Sprintf("%s (%s)", a.Name, a.ID))
	}
	return strings.Join(entries, ", ")
}

// tagFilters converts the configured opt-in tags to the AWS filter form.
func tagFilters(cfg *config.Config) []awsx.TagFilter {
	filters := make([]awsx.TagFilter, 0, len(cfg.Targets.TagFilters))
	for _, f := range cfg.Targets.TagFilters {
		filters = append(filters, awsx.TagFilter{Key: f.Key, Value: f.Value})
	}
	return filters
}
