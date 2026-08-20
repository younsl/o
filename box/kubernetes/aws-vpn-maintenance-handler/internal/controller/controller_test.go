package controller

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/slack-go/slack"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

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

const (
	connID   = "vpn-0123456789abcdef0"
	targetIP = "203.0.113.10"
	peerIP   = "203.0.113.20"
	approver = "U0APPROVER"
	testNS   = "kube-system"
)

// fakeVPN answers discovery and describe from a single mutable connection, so a test
// can change telemetry between calls to simulate the world moving.
type fakeVPN struct {
	mu sync.Mutex

	conn     awsx.Connection
	statuses []awsx.TunnelStatus
	// empty makes Discover return no connections, for the wrong-tag-filter case.
	empty       bool
	discoverErr error
	describeErr error
	statusesErr error

	discoverCalls int
	describeCalls int
}

func (f *fakeVPN) Discover(context.Context, awsx.DiscoverInput) ([]awsx.Connection, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.discoverCalls++
	if f.discoverErr != nil {
		return nil, f.discoverErr
	}
	if f.empty {
		return nil, nil
	}
	return []awsx.Connection{f.conn}, nil
}

func (f *fakeVPN) Describe(context.Context, string) (awsx.Connection, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.describeCalls++
	if f.describeErr != nil {
		return awsx.Connection{}, f.describeErr
	}
	return f.conn, nil
}

func (f *fakeVPN) Statuses(context.Context, awsx.Connection) ([]awsx.TunnelStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.statusesErr != nil {
		return nil, f.statusesErr
	}
	return f.statuses, nil
}

// set replaces the connection and its statuses under lock.
func (f *fakeVPN) set(conn awsx.Connection, statuses []awsx.TunnelStatus) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.conn, f.statuses = conn, statuses
}

// fakeSlack records what would have been posted.
type fakeSlack struct {
	mu         sync.Mutex
	broadcasts []string
	replies    []string
	updates    []string
	refs       []slackx.MessageRef
	// deliver is empty to simulate every approver being unreachable.
	deliver []slackx.MessageRef
}

func newFakeSlack() *fakeSlack {
	return &fakeSlack{deliver: []slackx.MessageRef{{ChannelID: "D1", TS: "1750000000.000100"}}}
}

func (f *fakeSlack) Broadcast(_ context.Context, _ []string, fallback string, _ []slack.Block) []slackx.MessageRef {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.broadcasts = append(f.broadcasts, fallback)
	f.refs = f.deliver
	return f.deliver
}

func (f *fakeSlack) Reply(_ context.Context, _ []slackx.MessageRef, n slackx.Notice) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replies = append(f.replies, n.Render())
}

func (f *fakeSlack) Update(_ context.Context, _ []slackx.MessageRef, fallback string, _ []slack.Block) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.updates = append(f.updates, fallback)
}

// messages is every string this fake was asked to post: card fallbacks, thread
// replies, and card rewrites.
func (f *fakeSlack) messages() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	all := append([]string{}, f.broadcasts...)
	all = append(all, f.replies...)
	return append(all, f.updates...)
}

func (f *fakeSlack) counts() (broadcasts, replies, updates int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.broadcasts), len(f.replies), len(f.updates)
}

// proposals and notices split the broadcasts by what the message asks for. Both go out
// on the same channels, so counting broadcasts alone cannot tell a card that wants a
// decision from a notice that only reports queued maintenance.
func (f *fakeSlack) proposals() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, m := range f.broadcasts {
		if strings.Contains(m, "replacement approval") {
			out = append(out, m)
		}
	}
	return out
}

func (f *fakeSlack) notices() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []string
	for _, m := range f.broadcasts {
		if !strings.Contains(m, "replacement approval") {
			out = append(out, m)
		}
	}
	return out
}

func (f *fakeSlack) said(substr string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, m := range append(append([]string{}, f.replies...), f.updates...) {
		if strings.Contains(m, substr) {
			return true
		}
	}
	return false
}

// fakeEvents records the Kubernetes Event audit trail.
type fakeEvents struct {
	mu       sync.Mutex
	reasons  []string
	warnings []string
}

func (f *fakeEvents) Normal(reason, _ string, _ ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reasons = append(f.reasons, reason)
}

func (f *fakeEvents) Warning(reason, _ string, _ ...any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reasons = append(f.reasons, reason)
	f.warnings = append(f.warnings, reason)
}

func (f *fakeEvents) saw(reason string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Contains(f.reasons, reason)
}

// fakeExec records the replacement requests it received.
type fakeExec struct {
	mu     sync.Mutex
	reqs   []executor.Request
	result executor.Result
	// onRun runs inside Run, which is the only place a test can look at the state
	// the controller persisted while a replacement is supposedly under way.
	onRun func(context.Context, executor.Request)
}

func (f *fakeExec) Run(ctx context.Context, req executor.Request, r executor.Reporter) executor.Result {
	f.mu.Lock()
	f.reqs = append(f.reqs, req)
	result := f.result
	onRun := f.onRun
	f.mu.Unlock()
	r.Info(context.Background(), "fake progress")
	if onRun != nil {
		onRun(ctx, req)
	}
	return result
}

func (f *fakeExec) calls() []executor.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]executor.Request{}, f.reqs...)
}

// harness bundles a controller with its fakes.
type harness struct {
	ctrl   *Controller
	vpn    *fakeVPN
	slack  *fakeSlack
	events *fakeEvents
	exec   *fakeExec
	broker *approval.Broker
	store  *state.Store
	// kube is kept so a test can build a second harness over the same state, which is
	// what a restart or a leader handover looks like from the ConfigMap's side.
	kube kubernetes.Interface
}

func healthyTunnel(ip string, routes int32) awsx.Tunnel {
	return awsx.Tunnel{
		OutsideIP:        ip,
		Up:               true,
		AcceptedRoutes:   routes,
		LastStatusChange: time.Now().Add(-6 * time.Hour),
		LifecycleControl: true,
	}
}

// pendingOn builds a connection whose target tunnel has maintenance queued and whose
// peer satisfies every safety rule.
func pendingOn(target string) (awsx.Connection, []awsx.TunnelStatus) {
	conn := awsx.Connection{
		ID:      connID,
		Name:    "prod-dc",
		State:   "available",
		Tunnels: []awsx.Tunnel{healthyTunnel(targetIP, 9), healthyTunnel(peerIP, 12)},
	}
	statuses := make([]awsx.TunnelStatus, 0, 2)
	for _, t := range conn.Tunnels {
		st := awsx.TunnelStatus{Tunnel: t}
		if t.OutsideIP == target {
			st.Maintenance = awsx.Maintenance{Pending: true, AutoAppliedAfter: time.Now().Add(200 * time.Hour)}
		}
		statuses = append(statuses, st)
	}
	return conn, statuses
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWithKube(t, fake.NewSimpleClientset())
}

// newHarnessWithKube lets a test control the Kubernetes client, which is the only way
// to exercise what happens when the state ConfigMap cannot be written.
func newHarnessWithKube(t *testing.T, kube kubernetes.Interface) *harness {
	t.Helper()

	cfg := &config.Config{
		Region:             "ap-northeast-2",
		ReconcileInterval:  config.Duration(time.Minute),
		StateConfigMapName: "aws-vpn-maintenance-handler-state",
		PodNamespace:       testNS,
		Targets:            config.Targets{TagFilters: []config.TagFilter{{Key: "managed", Value: "true"}}},
		Safety: config.Safety{
			PeerMinStableFor:      config.Duration(15 * time.Minute),
			PeerMinAcceptedRoutes: 1,
			PerConnectionCooldown: config.Duration(24 * time.Hour),
			VerifyTimeout:         config.Duration(30 * time.Minute),
			VerifyPollInterval:    config.Duration(time.Second),
			EscalateBefore:        config.Duration(72 * time.Hour),
		},
		Approval: config.Approval{
			SlackUserIDs:      []string{approver},
			Timeout:           config.Duration(2 * time.Second),
			ProgressHeartbeat: config.Duration(time.Minute),
		},
	}

	// Fires every minute and stays open an hour, so the window never gets in the way
	// of a test that is about something else.
	win, err := window.New(window.Config{
		Timezone: "UTC", CronSchedule: "* * * * *", Duration: time.Hour, MinRemaining: time.Minute,
	})
	if err != nil {
		t.Fatalf("window.New: %v", err)
	}
	gate, err := promx.NewGate(nil, promx.GateConfig{Enabled: false}, discardLogger())
	if err != nil {
		t.Fatalf("promx.NewGate: %v", err)
	}

	conn, statuses := pendingOn(targetIP)
	h := &harness{
		vpn:    &fakeVPN{conn: conn, statuses: statuses},
		slack:  newFakeSlack(),
		events: &fakeEvents{},
		exec:   &fakeExec{result: executor.Result{Outcome: executor.OutcomeSucceeded, Detail: "tunnel UP with 9 routes"}},
		broker: approval.New([]string{approver}, discardLogger()),
		store:  state.NewStore(kube, testNS, cfg.StateConfigMapName),
		kube:   kube,
	}
	h.ctrl = New(Options{
		Config: cfg, AWS: h.vpn, Exec: h.exec, Store: h.store,
		Slack: h.slack, Broker: h.broker, Window: win, Traffic: gate,
		Metrics: observability.NewMetrics(), Events: h.events, Logger: discardLogger(),
		DMChannels: []string{"D1"},
	})
	return h
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// awaitApproval waits for the approval request to be registered, then clicks it.
func (h *harness) awaitApproval(t *testing.T, approved bool) {
	t.Helper()
	for range 400 {
		for id := range h.broker.Pending() {
			h.broker.Handle(slackx.Interaction{RequestID: id, Approved: approved, UserID: approver, UserName: "tester"})
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("no approval request was registered")
}

// awaitIdle waits for the maintenance worker to finish.
func (h *harness) awaitIdle(t *testing.T) {
	t.Helper()
	for range 800 {
		if !h.ctrl.busy.Load() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the maintenance worker never finished")
}

func TestReconcileDoesNothingWithoutPendingMaintenance(t *testing.T) {
	h := newHarness(t)
	conn, _ := pendingOn("none")
	statuses := []awsx.TunnelStatus{{Tunnel: conn.Tunnels[0]}, {Tunnel: conn.Tunnels[1]}}
	h.vpn.set(conn, statuses)

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	if b, _, _ := h.slack.counts(); b != 0 {
		t.Fatalf("nothing is queued, so nothing should be proposed; %d broadcasts", b)
	}
}

// Lifecycle control off is reported rather than looking like "nothing to do".
func TestReconcileReportsLifecycleControlDisabled(t *testing.T) {
	h := newHarness(t)
	conn, statuses := pendingOn(targetIP)
	for i := range conn.Tunnels {
		conn.Tunnels[i].LifecycleControl = false
		statuses[i].Tunnel.LifecycleControl = false
	}
	h.vpn.set(conn, statuses)

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	if p := h.slack.proposals(); len(p) != 0 {
		t.Fatalf("a tunnel without lifecycle control must not be proposed: %v", p)
	}
	// Reported, not silent: nobody can enable lifecycle control from a log line.
	notices := h.slack.notices()
	if len(notices) == 0 {
		t.Fatal("a tunnel that cannot be managed must be reported to the approvers")
	}
	if !strings.Contains(notices[0], "cannot be taken over") {
		t.Fatalf("the notice must say the maintenance cannot be taken over: %q", notices[0])
	}
	if !strings.Contains(notices[0], slackx.LevelWarn.Tag()) {
		t.Fatalf("a configuration gap is not an INFO notice: %q", notices[0])
	}
}

// The full path: propose, approve, replace, then close the loop in state, Slack, and
// the Event trail.
func TestReconcileApproveAndReplace(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	calls := h.exec.calls()
	if len(calls) != 1 {
		t.Fatalf("expected one replacement, got %d", len(calls))
	}
	if calls[0].TunnelIP != targetIP || calls[0].PeerIP != peerIP {
		t.Fatalf("replaced the wrong tunnel: %+v", calls[0])
	}
	if calls[0].Resuming {
		t.Fatal("a fresh replacement must not be marked as resuming")
	}

	// State: in-flight cleared and the cooldown started, so the sibling tunnel is not
	// eligible on the next pass.
	snap, err := h.store.Load(ctx)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if snap.InFlight != nil {
		t.Fatal("in-flight should be cleared")
	}
	rec, ok := snap.Connections[connID]
	if !ok || rec.LastResult != string(executor.OutcomeSucceeded) {
		t.Fatalf("cooldown record = %+v", rec)
	}
	if len(snap.Approvals) != 0 {
		t.Fatalf("the approval record should be gone: %+v", snap.Approvals)
	}

	if !h.slack.said("Replaced") {
		t.Fatal("the outcome must reach the thread and the card")
	}
	_, _, updates := h.slack.counts()
	if updates == 0 {
		t.Fatal("the card must be rewritten so it cannot be clicked again")
	}
	for _, reason := range []string{"ApprovalRequested", "ReplacementApproved", "ReplacingTunnel", "TunnelReplaced"} {
		if !h.events.saw(reason) {
			t.Fatalf("missing Event %q", reason)
		}
	}
}

// Every message names its level and its VPN connection. A reply is read on a phone,
// one line at a time, often for a controller that manages several connections: a step
// that says neither how bad it is nor which VPN it concerns cannot be acted on.
func TestEveryMessageCarriesItsLevelAndConnection(t *testing.T) {
	h := newHarness(t)

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	levels := []string{
		string(slackx.LevelInfo), string(slackx.LevelSuccess), string(slackx.LevelAction),
		string(slackx.LevelWarn), string(slackx.LevelError), string(slackx.LevelCritical),
	}
	for _, msg := range h.slack.messages() {
		if !strings.Contains(msg, "prod-dc") {
			t.Fatalf("message does not name the VPN connection: %q", msg)
		}
		levelled := false
		for _, l := range levels {
			if strings.HasPrefix(msg, "["+l+"]") {
				levelled = true
				break
			}
		}
		if !levelled {
			t.Fatalf("message carries no level: %q", msg)
		}
	}
}

// A card whose decision has already been consumed must not stay clickable. The broker
// has stopped listening, so pressing it again would do nothing and say nothing, and the
// operator could not tell that from a slow controller.
func TestUnwritableStateClosesTheCardInsteadOfLeavingItClickable(t *testing.T) {
	kube := fake.NewSimpleClientset()
	// The approval record is created first and must succeed; the in-flight write is
	// an update, and that is the one being failed here.
	kube.PrependReactor("update", "configmaps", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("etcd is unavailable")
	})
	h := newHarnessWithKube(t, kube)

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if len(h.exec.calls()) != 0 {
		t.Fatal("a replacement that cannot be recorded must not be started")
	}
	if !h.slack.said("Closed without replacing anything") {
		t.Fatalf("the card must be closed rather than left live: %v", h.slack.messages())
	}
	if _, _, updates := h.slack.counts(); updates == 0 {
		t.Fatal("the card must be rewritten so its buttons are gone")
	}
	if !h.slack.said("could not record") {
		t.Fatalf("the thread must say why: %v", h.slack.messages())
	}
	if !h.events.saw("MaintenanceHeldBack") {
		t.Fatal("refusing to replace belongs in the audit trail")
	}
}

func TestReconcileDenialLeavesTheTunnelAlone(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, false)
	h.awaitIdle(t)

	if len(h.exec.calls()) != 0 {
		t.Fatal("a denial must not replace anything")
	}
	if !h.slack.said("Denied") {
		t.Fatal("the denial should be stated on the card")
	}
	snap, _ := h.store.Load(ctx)
	if len(snap.Approvals) != 0 {
		t.Fatal("a denied request must be dropped from state")
	}
	if !h.events.saw("ReplacementDenied") {
		t.Fatal("the denial belongs in the audit trail")
	}
}

// Not answering is a valid outcome: the tunnel is left alone and re-proposed later.
func TestReconcileApprovalTimeout(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitIdle(t)

	if len(h.exec.calls()) != 0 {
		t.Fatal("an expired request must not replace anything")
	}
	if !h.slack.said("Expired") {
		t.Fatal("the expiry should be stated on the card")
	}
	snap, _ := h.store.Load(ctx)
	if len(snap.Approvals) != 0 {
		t.Fatal("an expired request must be dropped from state")
	}
	if !h.events.saw("ApprovalTimedOut") {
		t.Fatal("the expiry belongs in the audit trail")
	}
}

// The re-check is the point: an approval can be an hour old, and the peer may have
// dropped since.
func TestApprovalIsRecheckedBeforeReplacing(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}

	// The peer dies while the approver is deciding.
	conn, statuses := pendingOn(targetIP)
	conn.Tunnels[1].Up = false
	statuses[1].Tunnel.Up = false
	h.vpn.set(conn, statuses)

	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if len(h.exec.calls()) != 0 {
		t.Fatal("the replacement must be abandoned when the peer is no longer healthy")
	}
	if !h.slack.said("Not replacing") {
		t.Fatal("the abort must be reported into the thread")
	}
	if !h.events.saw("MaintenanceHeldBack") {
		t.Fatal("the abort belongs in the audit trail")
	}
	snap, _ := h.store.Load(ctx)
	if snap.InFlight != nil {
		t.Fatal("nothing was replaced, so nothing should be in flight")
	}
}

// With no reachable approver there is no authorization path, so the candidate is
// dropped rather than replaced unattended.
func TestUnreachableApproverBlocksTheReplacement(t *testing.T) {
	h := newHarness(t)
	h.slack.deliver = nil

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitIdle(t)

	if len(h.exec.calls()) != 0 {
		t.Fatal("nothing may be replaced when no approver could be reached")
	}
}

// A restart mid-replacement must verify, not re-issue the AWS call.
func TestResumeInFlightVerifiesWithoutReplacingAgain(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.store.SetInFlight(ctx, state.InFlight{
		RequestID:    planner.RequestID(connID, targetIP, awsx.Maintenance{}),
		ConnectionID: connID,
		TunnelIP:     targetIP,
		PeerIP:       peerIP,
		Phase:        state.PhaseVerifying,
		StartedAt:    time.Now().Add(-time.Minute),
		ApprovedBy:   approver,
		Thread:       []slackx.MessageRef{{ChannelID: "D1", TS: "1750000000.000100"}},
	}); err != nil {
		t.Fatalf("SetInFlight: %v", err)
	}

	h.ctrl.resumeInFlight(ctx)
	h.awaitIdle(t)

	calls := h.exec.calls()
	if len(calls) != 1 {
		t.Fatalf("expected verification to resume, got %d runs", len(calls))
	}
	if !calls[0].Resuming {
		t.Fatal("a resumed run must be marked so the AWS call is not repeated")
	}
	if b, _, _ := h.slack.counts(); b != 0 {
		t.Fatal("resuming must not post a new approval card")
	}
	snap, _ := h.store.Load(ctx)
	if snap.InFlight != nil {
		t.Fatal("the finished run should clear in-flight")
	}
}

// An outstanding approval is adopted with its original thread, so the approver does not
// end up with two cards where only one works.
func TestAdoptApprovalsReusesTheExistingCard(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	_, statuses := pendingOn(targetIP)
	requestID := planner.RequestID(connID, targetIP, statuses[0].Maintenance)
	if err := h.store.AddApproval(ctx, state.Approval{
		RequestID: requestID,
		PostedAt:  time.Now().Add(-time.Second),
		Thread:    []slackx.MessageRef{{ChannelID: "D1", TS: "1750000000.000100"}},
	}); err != nil {
		t.Fatalf("AddApproval: %v", err)
	}

	h.ctrl.resumeInFlight(ctx)
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if b, _, _ := h.slack.counts(); b != 0 {
		t.Fatal("adopting must reuse the posted card, not broadcast a new one")
	}
	if len(h.exec.calls()) != 1 {
		t.Fatalf("the adopted approval should still lead to a replacement, got %d", len(h.exec.calls()))
	}
}

// An approval too old to still be valid is dropped rather than adopted.
func TestAdoptApprovalsDropsAnExpiredRequest(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.store.AddApproval(ctx, state.Approval{
		RequestID: "vpn-a|1.1.1.1|0",
		PostedAt:  time.Now().Add(-time.Hour),
		Thread:    []slackx.MessageRef{{ChannelID: "D1", TS: "1"}},
	}); err != nil {
		t.Fatalf("AddApproval: %v", err)
	}

	h.ctrl.resumeInFlight(ctx)

	snap, _ := h.store.Load(ctx)
	if len(snap.Approvals) != 0 {
		t.Fatalf("an expired approval must be dropped, got %+v", snap.Approvals)
	}
}

// An unparsable request ID cannot be resolved back to a tunnel, so it is discarded.
func TestAdoptApprovalsDropsAnUnparsableRequest(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.store.AddApproval(ctx, state.Approval{
		RequestID: "garbage",
		PostedAt:  time.Now(),
		Thread:    []slackx.MessageRef{{ChannelID: "D1", TS: "1"}},
	}); err != nil {
		t.Fatalf("AddApproval: %v", err)
	}

	h.ctrl.resumeInFlight(ctx)

	snap, _ := h.store.Load(ctx)
	if len(snap.Approvals) != 0 {
		t.Fatal("an unparsable approval must be dropped")
	}
}

// An aborted run keeps its in-flight record, so the next leader resumes it instead of
// finding a clean slate.
func TestAbortedRunKeepsItsInFlightRecord(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.exec.result = executor.Result{Outcome: executor.OutcomeAborted, Detail: "shutdown"}

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	snap, _ := h.store.Load(ctx)
	if snap.InFlight == nil {
		t.Fatal("an aborted run must stay in flight for the next leader")
	}
}

// A replacement that came back unhealthy is a warning, and still starts the cooldown.
func TestUnhealthyOutcomeIsRecordedAsAWarning(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.exec.result = executor.Result{
		Outcome: executor.OutcomeVerifyTimeout, Detail: "still down", PeerDropped: true,
	}

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if !h.events.saw("TunnelReplaceFailed") || !h.events.saw("PeerTunnelLost") {
		t.Fatalf("expected failure and peer-loss Events, got %+v", h.events.warnings)
	}
	snap, _ := h.store.Load(ctx)
	if snap.Connections[connID].LastReplacementAt.IsZero() {
		t.Fatal("a failed replacement must still start the cooldown")
	}
}

// One replacement at a time: a second pass while a worker is running must not start
// another.
func TestOnlyOneMaintenanceWorkerRuns(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	// A second pass while the first is still waiting for approval.
	if err := h.ctrl.reconcile(ctx); err != nil {
		t.Fatalf("second reconcile returned error: %v", err)
	}
	h.awaitApproval(t, true)
	h.awaitIdle(t)

	if b, _, _ := h.slack.counts(); b != 1 {
		t.Fatalf("expected exactly one approval card, got %d", b)
	}
	if len(h.exec.calls()) != 1 {
		t.Fatalf("expected exactly one replacement, got %d", len(h.exec.calls()))
	}
}

func TestReconcilePropagatesDiscoveryFailure(t *testing.T) {
	h := newHarness(t)
	h.vpn.discoverErr = errors.New("throttled")

	if err := h.ctrl.reconcile(context.Background()); err == nil {
		t.Fatal("a discovery failure must be reported")
	}
}

// One connection failing to report must not blind the pass to the others.
func TestReconcileSurvivesAStatusFailure(t *testing.T) {
	h := newHarness(t)
	h.vpn.statusesErr = errors.New("throttled")

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile should skip the connection, not fail: %v", err)
	}
	if b, _, _ := h.slack.counts(); b != 0 {
		t.Fatal("a connection with unreadable status must not be proposed")
	}
}

// The traffic gate is consulted before anything is proposed.
func TestTrafficGateBlocksBeforeProposing(t *testing.T) {
	h := newHarness(t)
	// A gate whose client cannot be reached, with onError block.
	client, err := promx.New(promx.Config{Endpoint: "http://127.0.0.1:1", Timeout: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("promx.New: %v", err)
	}
	gate, err := promx.NewGate(client, promx.GateConfig{
		Enabled: true, Percentile: 20, OnError: promx.OnErrorBlock,
	}, discardLogger())
	if err != nil {
		t.Fatalf("promx.NewGate: %v", err)
	}
	h.ctrl.traffic = gate

	if err := h.ctrl.reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile returned error: %v", err)
	}
	if p := h.slack.proposals(); len(p) != 0 {
		t.Fatalf("a blocked traffic gate must stop the proposal: %v", p)
	}
	// The gate can hold a tunnel for the whole window, so this is exactly the case the
	// notice exists for: eligible, deferred, and otherwise unannounced.
	if len(h.slack.notices()) != 1 {
		t.Fatalf("a candidate the traffic gate deferred must be notified about once, got %v", h.slack.notices())
	}
}

func TestQuietestCandidateSkipsBlockedOnes(t *testing.T) {
	h := newHarness(t)
	_, statuses := pendingOn(targetIP)
	cand := planner.Candidate{
		Connection:  h.vpn.conn,
		Tunnel:      statuses[0].Tunnel,
		Peer:        statuses[1].Tunnel,
		Maintenance: statuses[0].Maintenance,
		RequestID:   planner.RequestID(connID, targetIP, statuses[0].Maintenance),
	}

	got, assessment, ok := h.ctrl.quietestCandidate(context.Background(), []planner.Candidate{cand})
	if !ok {
		t.Fatal("a disabled gate must clear every candidate")
	}
	if got.RequestID != cand.RequestID {
		t.Fatalf("selected the wrong candidate: %s", got.RequestID)
	}
	if assessment.Evaluated {
		t.Fatal("a disabled gate must report that it did not evaluate")
	}
}

func TestRunStopsOnContextCancel(t *testing.T) {
	h := newHarness(t)
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.ctrl.Run(ctx)
	}()

	// Let the first pass happen, then shut down.
	for range 200 {
		h.vpn.mu.Lock()
		calls := h.vpn.discoverCalls
		h.vpn.mu.Unlock()
		if calls > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not stop on cancellation")
	}
}

func TestHistoryFromSnapshot(t *testing.T) {
	at := time.Now().UTC()
	history := historyFrom(state.Snapshot{Connections: map[string]state.Connection{
		"vpn-a": {LastReplacementAt: at},
	}})
	if got := history["vpn-a"].LastReplacementAt; !got.Equal(at) {
		t.Fatalf("LastReplacementAt = %s, want %s", got, at)
	}
}

func TestOutcomeSummary(t *testing.T) {
	// The level matters as much as the text: it is what separates "read this later"
	// from "the connection has no path right now" in a phone notification.
	tests := []struct {
		result executor.Result
		want   string
		level  slackx.Level
	}{
		{executor.Result{Outcome: executor.OutcomeSucceeded, Detail: "tunnel UP"}, "Replaced", slackx.LevelSuccess},
		{executor.Result{Outcome: executor.OutcomeSucceeded, PeerDropped: true}, "without a healthy path", slackx.LevelWarn},
		{executor.Result{Outcome: executor.OutcomeDryRun, Detail: "accepted"}, "Dry run complete", slackx.LevelSuccess},
		{executor.Result{Outcome: executor.OutcomeRequestFailed, Detail: "denied"}, "Rejected by AWS", slackx.LevelError},
		{executor.Result{Outcome: executor.OutcomeVerifyTimeout, Detail: "down"}, "not healthy", slackx.LevelError},
		{executor.Result{Outcome: executor.OutcomePeerLost, Detail: "both down"}, "Both tunnels", slackx.LevelCritical},
		{executor.Result{Outcome: executor.OutcomeAborted, Detail: "shutdown"}, "aborted", slackx.LevelWarn},
	}
	for _, tc := range tests {
		level, got := outcomeSummary(tc.result)
		if !strings.Contains(got, tc.want) {
			t.Fatalf("outcomeSummary(%s) = %q, want it to mention %q", tc.result.Outcome, got, tc.want)
		}
		if level != tc.level {
			t.Fatalf("outcomeSummary(%s) level = %s, want %s", tc.result.Outcome, level, tc.level)
		}
	}
}

func TestProposalCarriesTheDecisionInputs(t *testing.T) {
	h := newHarness(t)
	_, statuses := pendingOn(targetIP)
	cand := planner.Candidate{
		Connection:  h.vpn.conn,
		Tunnel:      statuses[0].Tunnel,
		Peer:        statuses[1].Tunnel,
		Maintenance: statuses[0].Maintenance,
		RequestID:   "req",
		DeadlineIn:  200 * time.Hour,
	}

	p := h.ctrl.proposal(cand)
	if p.TunnelIP != targetIP || p.PeerIP != peerIP {
		t.Fatalf("proposal = %+v", p)
	}
	if p.PeerRoutes != 12 {
		t.Fatalf("PeerRoutes = %d, want the peer's count", p.PeerRoutes)
	}
	if p.Region != "ap-northeast-2" || p.Window == "" {
		t.Fatalf("proposal is missing context: %+v", p)
	}
}

func TestProposalFromInFlight(t *testing.T) {
	h := newHarness(t)
	conn := awsx.Connection{ID: connID, Name: "prod-dc", VpnGatewayID: "vgw-1"}
	p := h.ctrl.proposalFromInFlight(conn, state.InFlight{
		RequestID: "req", TunnelIP: targetIP, PeerIP: peerIP,
	})
	if p.TunnelIP != targetIP || p.PeerIP != peerIP || p.Gateway != "vgw-1" {
		t.Fatalf("proposal = %+v", p)
	}
}

func TestGatewayOfPrefersTheTransitGateway(t *testing.T) {
	if got := gatewayOf(awsx.Connection{TransitGatewayID: "tgw-1", VpnGatewayID: "vgw-1"}); got != "tgw-1" {
		t.Fatalf("gatewayOf = %q, want tgw-1", got)
	}
	if got := gatewayOf(awsx.Connection{VpnGatewayID: "vgw-1"}); got != "vgw-1" {
		t.Fatalf("gatewayOf = %q, want vgw-1", got)
	}
}

// logCapture collects log records so a test can assert on what an operator would see.
type logCapture struct {
	mu      sync.Mutex
	records []string
}

func (l *logCapture) Handle(_ context.Context, r slog.Record) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	line := r.Level.String() + " " + r.Message
	r.Attrs(func(a slog.Attr) bool {
		line += " " + a.Key + "=" + a.Value.String()
		return true
	})
	l.records = append(l.records, line)
	return nil
}

func (l *logCapture) Enabled(context.Context, slog.Level) bool { return true }
func (l *logCapture) WithAttrs([]slog.Attr) slog.Handler       { return l }
func (l *logCapture) WithGroup(string) slog.Handler            { return l }

func (l *logCapture) contains(substr string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, r := range l.records {
		if strings.Contains(r, substr) {
			return true
		}
	}
	return false
}

func (l *logCapture) dump() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.records, "\n")
}

// withCapturedLogs rebuilds the controller so its logger is observable.
func (h *harness) withCapturedLogs(t *testing.T) *logCapture {
	t.Helper()
	cap := &logCapture{}
	h.ctrl.logger = slog.New(cap)
	return cap
}

// The startup summary is what makes a wrong tag filter or a tunnel without lifecycle
// control visible, instead of looking like a controller with nothing to do.
func TestLogScopeNamesEveryManagedConnection(t *testing.T) {
	h := newHarness(t)
	logs := h.withCapturedLogs(t)

	h.ctrl.LogScope(context.Background())

	for _, want := range []string{
		"managing VPN connection",
		connID,
		"prod-dc",
		targetIP,
		peerIP,
		"lifecycle_control=on",
		"maintenance_pending",
		"scope resolved",
	} {
		if !logs.contains(want) {
			t.Fatalf("startup log is missing %q; got:\n%s", want, logs.dump())
		}
	}
}

// A tunnel that can never be taken over has to be called out, and as a warning: it is a
// configuration gap, not a passing condition.
func TestLogScopeWarnsAboutDisabledLifecycleControl(t *testing.T) {
	h := newHarness(t)
	conn, statuses := pendingOn(targetIP)
	for i := range conn.Tunnels {
		conn.Tunnels[i].LifecycleControl = false
		statuses[i].Tunnel.LifecycleControl = false
	}
	h.vpn.set(conn, statuses)
	logs := h.withCapturedLogs(t)

	h.ctrl.LogScope(context.Background())

	if !logs.contains("lifecycle_control=OFF") {
		t.Fatalf("the per-tunnel state must say so; got:\n%s", logs.dump())
	}
	if !logs.contains("WARN") || !logs.contains("can never be replaced early") {
		t.Fatalf("expected a warning about lifecycle control; got:\n%s", logs.dump())
	}
}

// An empty scope is almost always a wrong tag filter, so it is a warning naming the
// filters rather than silence.
func TestLogScopeWarnsWhenNothingMatches(t *testing.T) {
	h := newHarness(t)
	h.vpn.empty = true
	logs := h.withCapturedLogs(t)

	h.ctrl.LogScope(context.Background())

	if !logs.contains("no VPN connections match") || !logs.contains("managed=true") {
		t.Fatalf("expected a warning naming the tag filters; got:\n%s", logs.dump())
	}
}

// Discovery failing at startup must not stop the process: the reconcile loop retries.
func TestLogScopeToleratesADiscoveryFailure(t *testing.T) {
	h := newHarness(t)
	h.vpn.discoverErr = errors.New("throttled")
	logs := h.withCapturedLogs(t)

	h.ctrl.LogScope(context.Background())

	if !logs.contains("will retry") {
		t.Fatalf("expected a non-fatal warning; got:\n%s", logs.dump())
	}
}
