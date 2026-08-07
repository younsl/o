// Package controller is the reconcile loop that owns Site-to-Site VPN tunnel
// endpoint maintenance: read telemetry and pending maintenance, apply the safety
// rules, ask a human over Slack, then replace and verify.
//
// Discovery keeps polling on its interval while an approved replacement runs in
// its own worker, which may outlive several passes. A busy flag allows one worker
// at a time; with leader election and the persisted in-flight record, that makes
// "one replacement at a time" hold across passes, replicas, and restarts.
package controller

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync/atomic"
	"time"

	"github.com/slack-go/slack"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/approval"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/config"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/executor"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/observability"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/planner"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/promx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/slackx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/state"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/window"
)

// VPNAPI is the AWS surface the controller reads.
type VPNAPI interface {
	Discover(ctx context.Context, in awsx.DiscoverInput) ([]awsx.Connection, error)
	Describe(ctx context.Context, connectionID string) (awsx.Connection, error)
	Statuses(ctx context.Context, conn awsx.Connection) ([]awsx.TunnelStatus, error)
}

// Notifier is the Slack surface the controller needs. *slackx.Client satisfies it.
type Notifier interface {
	Broadcast(ctx context.Context, channelIDs []string, fallback string, blocks []slack.Block) []slackx.MessageRef
	Reply(ctx context.Context, refs []slackx.MessageRef, n slackx.Notice)
	Update(ctx context.Context, refs []slackx.MessageRef, fallback string, blocks []slack.Block)
}

// Recorder publishes the audit trail. *events.Emitter satisfies it.
type Recorder interface {
	Normal(reason, format string, args ...any)
	Warning(reason, format string, args ...any)
}

// Replacer performs an approved replacement. *executor.Executor satisfies it.
type Replacer interface {
	Run(ctx context.Context, req executor.Request, r executor.Reporter) executor.Result
}

// Controller reconciles VPN tunnel maintenance.
type Controller struct {
	cfg     *config.Config
	aws     VPNAPI
	exec    Replacer
	store   *state.Store
	slack   Notifier
	broker  *approval.Broker
	window  *window.Window
	traffic *promx.Gate
	metrics *observability.Metrics
	events  Recorder
	logger  *slog.Logger

	// dmChannels are the resolved DM channel IDs of the approvers.
	dmChannels []string
	// busy is held for the whole approve-and-replace cycle.
	busy atomic.Bool
}

// Options bundles the controller's collaborators.
type Options struct {
	Config  *config.Config
	AWS     VPNAPI
	Exec    Replacer
	Store   *state.Store
	Slack   Notifier
	Broker  *approval.Broker
	Window  *window.Window
	Traffic *promx.Gate
	Metrics *observability.Metrics
	Events  Recorder
	Logger  *slog.Logger
	// DMChannels are the approvers' DM channels, resolved once at startup.
	DMChannels []string
}

// New builds a Controller.
func New(o Options) *Controller {
	return &Controller{
		cfg: o.Config, aws: o.AWS, exec: o.Exec, store: o.Store,
		slack: o.Slack, broker: o.Broker, window: o.Window, traffic: o.Traffic,
		metrics: o.Metrics, events: o.Events, logger: o.Logger,
		dmChannels: o.DMChannels,
	}
}

// Run reconciles until ctx is cancelled. Recovering an interrupted replacement
// comes first: that tunnel is down with nobody watching it.
func (c *Controller) Run(ctx context.Context) {
	c.resumeInFlight(ctx)

	ticker := time.NewTicker(c.cfg.ReconcileInterval.D())
	defer ticker.Stop()

	c.reconcileOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			c.logger.Info("reconcile loop stopped")
			return
		case <-ticker.C:
			c.reconcileOnce(ctx)
		}
	}
}

func (c *Controller) reconcileOnce(ctx context.Context) {
	c.metrics.ObserveReconcile()
	if err := c.reconcile(ctx); err != nil && ctx.Err() == nil {
		c.logger.Error("reconcile pass failed", "error", err)
	}
}

// reconcile runs one pass: discover, read status, publish metrics, evaluate, and
// hand off at most one candidate to the maintenance worker.
func (c *Controller) reconcile(ctx context.Context) error {
	now := time.Now()

	open, windowDetail := c.window.Open(now)
	c.metrics.SetWindow(open, c.window.Remaining(now))

	conns, err := c.aws.Discover(ctx, awsx.DiscoverInput{
		TagFilters: c.tagFilters(),
		ExcludeIDs: c.cfg.Targets.ExcludeConnectionIDs,
	})
	if err != nil {
		c.metrics.ObserveReconcileError("discover")
		return err
	}
	c.metrics.SetConnections(len(conns))
	c.metrics.ResetTunnels()

	statuses := make(map[string][]awsx.TunnelStatus, len(conns))
	for _, conn := range conns {
		st, err := c.aws.Statuses(ctx, conn)
		if err != nil {
			// Skip this connection rather than blinding the pass to the others.
			c.metrics.ObserveReconcileError("maintenance_status")
			c.logger.Error("failed to read tunnel maintenance status",
				"vpn_connection_id", conn.ID, "error", err)
			continue
		}
		statuses[conn.ID] = st
		for _, s := range st {
			c.metrics.SetTunnel(observability.TunnelSample{
				ConnectionID:     conn.ID,
				ConnectionName:   conn.Name,
				TunnelIP:         s.Tunnel.OutsideIP,
				Up:               s.Tunnel.Up,
				Routes:           s.Tunnel.AcceptedRoutes,
				Pending:          s.Maintenance.Pending,
				Deadline:         s.Maintenance.AutoAppliedAfter,
				LifecycleControl: s.Tunnel.LifecycleControl,
			})
		}
	}

	snap, err := c.store.Load(ctx)
	if err != nil {
		c.metrics.ObserveReconcileError("state_load")
		return err
	}
	c.metrics.SetInFlight(snap.InFlight != nil)

	plan := planner.Evaluate(planner.Input{
		Now:                 now,
		Connections:         conns,
		Statuses:            statuses,
		WindowOpen:          open,
		WindowDetail:        windowDetail,
		ReplacementInFlight: snap.InFlight != nil || c.busy.Load(),
		AwaitingApproval:    c.broker.Pending(),
		History:             historyFrom(snap),
		Thresholds: planner.Thresholds{
			PeerMinStableFor:      c.cfg.Safety.PeerMinStableFor.D(),
			PeerMinAcceptedRoutes: c.cfg.Safety.PeerMinAcceptedRoutes,
			PerConnectionCooldown: c.cfg.Safety.PerConnectionCooldown.D(),
			EscalateBefore:        c.cfg.Safety.EscalateBefore.D(),
			ChainSiblingTunnel:    c.cfg.Safety.ChainSiblingTunnel,
		},
	})

	for _, b := range plan.Held() {
		c.metrics.ObserveBlocked(string(b.Reason))
		if b.Reason == planner.ReasonLifecycleControlDisabled {
			// Not transient: this tunnel can never be taken over until someone
			// changes its options, so it is a warning rather than an info line.
			c.logger.Warn("tunnel cannot be managed: endpoint lifecycle control is disabled",
				"vpn_connection_id", b.ConnectionID, "tunnel_ip", b.TunnelIP)
			continue
		}
		c.logger.Info("pending maintenance held back by a preflight rule",
			"vpn_connection_id", b.ConnectionID, "tunnel_ip", b.TunnelIP,
			"reason", b.Reason, "detail", b.Detail)
	}

	// Serialized, so only one candidate is acted on; the rest are re-evaluated next
	// pass against fresh telemetry rather than queued against data going stale. An
	// empty candidate list takes the same path and simply clears nothing.
	cand, assessment, ok := c.quietestCandidate(ctx, plan.Candidates)
	if ok {
		if len(plan.Candidates) > 1 {
			c.logger.Info("multiple tunnels are eligible; taking the most urgent quiet one",
				"eligible", len(plan.Candidates), "selected", cand.Label())
		}
		c.startMaintenance(ctx, cand, assessment)
	}

	// Last, and after the handoff: a notice is a courtesy, and its Slack and ConfigMap
	// calls must not sit in front of the replacement that this pass exists to start.
	proposing := ""
	if ok {
		proposing = cand.RequestID
	}
	c.notifyDetected(ctx, plan, snap, proposing)
	return nil
}

// quietestCandidate walks the candidates in urgency order and returns the first one
// the traffic gate clears.
//
// The gate needs a network call, so it cannot live in the planner. Walking in order
// rather than picking the globally quietest tunnel keeps the AWS deadline as the
// primary priority: being quiet is a permission, not a ranking.
func (c *Controller) quietestCandidate(ctx context.Context, candidates []planner.Candidate) (planner.Candidate, promx.Assessment, bool) {
	for _, cand := range candidates {
		assessment := c.traffic.Evaluate(ctx, c.trafficVars(cand))
		if assessment.Evaluated {
			c.metrics.ObserveTrafficGate(assessment.Allowed, assessment.Ratio, assessment.Rank, assessment.HasHistory)
		}
		if assessment.Allowed {
			return cand, assessment, true
		}
		c.metrics.ObserveBlocked(string(planner.ReasonTrafficHigh))
		c.logger.Info("candidate held back by the traffic gate",
			"vpn_connection_id", cand.Connection.ID, "tunnel_ip", cand.Tunnel.OutsideIP,
			"detail", assessment.Detail)
	}
	return planner.Candidate{}, promx.Assessment{}, false
}

// trafficVars describes a candidate to the traffic gate.
//
// The window travels with the request because the gate compares the present moment
// against past window moments only: a midday value judged against a distribution that
// includes every night would never look quiet. Escalate carries over as urgency, so a
// tunnel AWS is about to take over itself stops holding out for the calmest slot.
func (c *Controller) trafficVars(cand planner.Candidate) promx.Vars {
	return promx.Vars{
		VPNConnectionID: cand.Connection.ID,
		VPNName:         cand.Connection.Name,
		TunnelIP:        cand.Tunnel.OutsideIP,
		PeerIP:          cand.Peer.OutsideIP,
		Region:          c.cfg.Region,
		InWindow:        c.window.Contains,
		Loc:             c.window.Location(),
		Urgent:          cand.Escalate,
	}
}

// startMaintenance launches the approve-and-replace worker unless one is running.
// CompareAndSwap stops two overlapping passes both starting one.
func (c *Controller) startMaintenance(ctx context.Context, cand planner.Candidate, assessment promx.Assessment) {
	if !c.busy.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer c.busy.Store(false)
		c.runMaintenance(ctx, cand, assessment)
	}()
}

func (c *Controller) tagFilters() []awsx.TagFilter {
	filters := make([]awsx.TagFilter, 0, len(c.cfg.Targets.TagFilters))
	for _, f := range c.cfg.Targets.TagFilters {
		filters = append(filters, awsx.TagFilter{Key: f.Key, Value: f.Value})
	}
	return filters
}

func historyFrom(snap state.Snapshot) map[string]planner.ConnectionState {
	history := make(map[string]planner.ConnectionState, len(snap.Connections))
	for id, rec := range snap.Connections {
		history[id] = planner.ConnectionState{
			LastReplacementAt: rec.LastReplacementAt,
			LastTunnelIP:      rec.LastTunnelIP,
			// Derived from the executor's own verdict rather than by string
			// comparison, so a new outcome cannot silently become chainable.
			LastSucceeded: executor.Outcome(rec.LastResult).Healthy(),
		}
	}
	return history
}

// LogScope reports which VPN connections and tunnels this controller manages.
//
// It runs at startup on every replica, before leader election, because the most
// expensive mistake here is a silent one: a wrong tag filter or a tunnel without
// lifecycle control both look exactly like "nothing needed doing". Printing the scope
// once turns that into something visible in the Pod's first log lines.
//
// A failure is not fatal. The reconcile loop retries on its own interval, and refusing
// to start over one throttled DescribeVpnConnections would be worse than starting
// without the summary.
func (c *Controller) LogScope(ctx context.Context) {
	conns, err := c.aws.Discover(ctx, awsx.DiscoverInput{
		TagFilters: c.tagFilters(),
		ExcludeIDs: c.cfg.Targets.ExcludeConnectionIDs,
	})
	if err != nil {
		c.logger.Warn("could not list managed VPN connections at startup; the reconcile loop will retry",
			"error", err)
		return
	}
	if len(conns) == 0 {
		c.logger.Warn("no VPN connections match the configured tag filters, so nothing is managed",
			"tag_filters", c.tagFilterSummary(), "excluded", len(c.cfg.Targets.ExcludeConnectionIDs))
		return
	}

	unmanaged := 0
	for _, conn := range conns {
		statuses, err := c.aws.Statuses(ctx, conn)
		if err != nil {
			c.logger.Warn("could not read tunnel maintenance status at startup",
				"vpn_connection_id", conn.ID, "error", err)
			continue
		}

		tunnels := make([]string, 0, len(statuses))
		for _, s := range statuses {
			state := "lifecycle_control=on"
			if !s.Tunnel.LifecycleControl {
				state = "lifecycle_control=OFF"
				unmanaged++
			}
			if s.Maintenance.Pending {
				state += " maintenance_pending"
			}
			tunnels = append(tunnels, fmt.Sprintf("%s (%s %s)", s.Tunnel.OutsideIP, upDown(s.Tunnel.Up), state))
		}
		c.logger.Info("managing VPN connection",
			"vpn_connection_id", conn.ID, "name", conn.Name,
			"routing", routingMode(conn), "gateway", gatewayOf(conn),
			"tunnels", strings.Join(tunnels, ", "))
	}

	c.logger.Info("scope resolved", "connections", len(conns), "tag_filters", c.tagFilterSummary())
	if unmanaged > 0 {
		// Not transient: these tunnels can never be taken over until someone changes
		// their options, and without this line the controller would simply look idle.
		c.logger.Warn("some tunnels have endpoint lifecycle control disabled and can never be replaced early; "+
			"enable it with ModifyVpnTunnelOptions (EnableTunnelLifecycleControl)",
			"tunnels", unmanaged)
	}
}

// tagFilterSummary renders the tag filters for a log line.
func (c *Controller) tagFilterSummary() string {
	parts := make([]string, 0, len(c.cfg.Targets.TagFilters))
	for _, f := range c.cfg.Targets.TagFilters {
		if f.Value == "" {
			parts = append(parts, f.Key+"=<any>")
			continue
		}
		parts = append(parts, f.Key+"="+f.Value)
	}
	return strings.Join(parts, ", ")
}

func upDown(up bool) string {
	if up {
		return "UP"
	}
	return "DOWN"
}

func routingMode(conn awsx.Connection) string {
	if conn.StaticRoutesOnly {
		return "static"
	}
	return "bgp"
}
