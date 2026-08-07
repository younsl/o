package executor

import (
	"context"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/awsx"
)

const (
	targetIP = "203.0.113.10"
	peerIP   = "203.0.113.20"
)

// fakeVPN serves a scripted sequence of telemetry snapshots. The last snapshot
// repeats once the script runs out, so a test can describe a settled end state
// without counting polls.
type fakeVPN struct {
	mu sync.Mutex

	replaceErr   error
	replaceCalls int

	snapshots     []awsx.Connection
	describeErrs  []error
	describeCalls int
}

func (f *fakeVPN) Replace(_ context.Context, _, _ string, _ bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replaceCalls++
	return f.replaceErr
}

func (f *fakeVPN) Describe(_ context.Context, _ string) (awsx.Connection, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := f.describeCalls
	f.describeCalls++
	if i < len(f.describeErrs) && f.describeErrs[i] != nil {
		return awsx.Connection{}, f.describeErrs[i]
	}
	if len(f.snapshots) == 0 {
		return awsx.Connection{}, nil
	}
	if i >= len(f.snapshots) {
		return f.snapshots[len(f.snapshots)-1], nil
	}
	return f.snapshots[i], nil
}

func (f *fakeVPN) calls() (replace, describe int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.replaceCalls, f.describeCalls
}

// recorder collects the narrative the executor would post to Slack.
type recorder struct {
	mu       sync.Mutex
	progress []string
	alerts   []string
	// levels records the level of every reported message, in order, so a test can
	// assert that a step was classified and not only that it was mentioned.
	levels []string
}

func (r *recorder) record(bucket *[]string, level, msg string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	*bucket = append(*bucket, msg)
	r.levels = append(r.levels, level)
}

func (r *recorder) Info(_ context.Context, msg string)     { r.record(&r.progress, "INFO", msg) }
func (r *recorder) Success(_ context.Context, msg string)  { r.record(&r.progress, "SUCCESS", msg) }
func (r *recorder) Warn(_ context.Context, msg string)     { r.record(&r.alerts, "WARN", msg) }
func (r *recorder) Error(_ context.Context, msg string)    { r.record(&r.alerts, "ERROR", msg) }
func (r *recorder) Critical(_ context.Context, msg string) { r.record(&r.alerts, "CRITICAL", msg) }

func (r *recorder) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append(append([]string{}, r.progress...), r.alerts...)
}

func (r *recorder) reportedLevels() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.levels...)
}

func (r *recorder) mentions(substr string) bool {
	for _, m := range r.all() {
		if strings.Contains(m, substr) {
			return true
		}
	}
	return false
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func opts() Options {
	return Options{
		VerifyTimeout:     2 * time.Second,
		PollInterval:      5 * time.Millisecond,
		MinAcceptedRoutes: 1,
		Heartbeat:         time.Hour,
	}
}

// snapshot builds a two-tunnel connection in a given state. changedAt drives
// LastStatusChange on the target tunnel.
func snapshot(targetUp bool, targetRoutes int32, peerUp bool, changedAt time.Time) awsx.Connection {
	return awsx.Connection{
		ID:    "vpn-a",
		State: "available",
		Tunnels: []awsx.Tunnel{
			{OutsideIP: targetIP, Up: targetUp, AcceptedRoutes: targetRoutes, LastStatusChange: changedAt},
			{OutsideIP: peerIP, Up: peerUp, AcceptedRoutes: 12, LastStatusChange: changedAt},
		},
	}
}

func request(conn awsx.Connection) Request {
	return Request{Connection: conn, TunnelIP: targetIP, PeerIP: peerIP}
}

func TestRunDryRunDoesNotVerify(t *testing.T) {
	fake := &fakeVPN{replaceErr: awsx.ErrDryRunSucceeded}
	rec := &recorder{}

	req := request(snapshot(true, 9, true, time.Now()))
	req.DryRun = true
	result := New(fake, opts(), discardLogger()).Run(context.Background(), req, rec)

	if result.Outcome != OutcomeDryRun {
		t.Fatalf("Outcome = %s, want %s", result.Outcome, OutcomeDryRun)
	}
	if !result.Outcome.Healthy() {
		t.Fatal("a dry run needs no follow-up and should count as healthy")
	}
	_, describes := fake.calls()
	if describes != 0 {
		t.Fatalf("a dry run replaced nothing, so it must not verify; %d Describe calls", describes)
	}
}

func TestRunReportsARejectedRequest(t *testing.T) {
	fake := &fakeVPN{replaceErr: context.DeadlineExceeded}
	rec := &recorder{}

	result := New(fake, opts(), discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, time.Now())), rec)

	if result.Outcome != OutcomeRequestFailed {
		t.Fatalf("Outcome = %s, want %s", result.Outcome, OutcomeRequestFailed)
	}
	if !rec.mentions("Nothing was replaced") {
		t.Fatalf("the operator must be told nothing changed; messages: %v", rec.all())
	}
	if _, describes := fake.calls(); describes != 0 {
		t.Fatalf("a rejected request must not be verified; %d Describe calls", describes)
	}
}

func TestRunVerifiesARecoveredTunnel(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{snapshots: []awsx.Connection{
		snapshot(false, 0, true, started),                      // tunnel dropped
		snapshot(false, 0, true, started),                      // still down
		snapshot(true, 5, true, started.Add(time.Millisecond)), // back up with routes
	}}
	rec := &recorder{}

	result := New(fake, opts(), discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, started)), rec)

	if result.Outcome != OutcomeSucceeded {
		t.Fatalf("Outcome = %s (%s), want %s", result.Outcome, result.Detail, OutcomeSucceeded)
	}
	if result.PeerDropped {
		t.Fatal("the peer never dropped in this scenario")
	}
	if replaces, _ := fake.calls(); replaces != 1 {
		t.Fatalf("expected exactly one ReplaceVpnTunnel call, got %d", replaces)
	}
	if !rec.mentions("is back UP") {
		t.Fatalf("success should be reported; messages: %v", rec.all())
	}
}

// Verification must require evidence the tunnel actually cycled. Reading the
// pre-replacement UP state and declaring success would report a replacement
// verified before the tunnel had even dropped.
func TestRunDoesNotAcceptTheStaleUpState(t *testing.T) {
	started := time.Now()
	stale := snapshot(true, 9, true, started.Add(-time.Hour))
	fake := &fakeVPN{snapshots: []awsx.Connection{stale}}
	rec := &recorder{}

	o := opts()
	o.VerifyTimeout = 60 * time.Millisecond
	result := New(fake, o, discardLogger()).Run(context.Background(), request(stale), rec)

	if result.Outcome != OutcomeVerifyTimeout {
		t.Fatalf("Outcome = %s, want %s: an unchanged UP tunnel is not proof of a completed replacement",
			result.Outcome, OutcomeVerifyTimeout)
	}
}

// A tunnel that comes back UP but carries no routes is not healthy: IKE up with
// no routes still blackholes traffic.
func TestRunRequiresRoutesOnABGPConnection(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{snapshots: []awsx.Connection{
		snapshot(false, 0, true, started),
		snapshot(true, 0, true, started.Add(time.Millisecond)),
	}}

	o := opts()
	o.VerifyTimeout = 60 * time.Millisecond
	result := New(fake, o, discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, started)), &recorder{})

	if result.Outcome != OutcomeVerifyTimeout {
		t.Fatalf("Outcome = %s, want %s for an UP tunnel with 0 routes", result.Outcome, OutcomeVerifyTimeout)
	}
}

// Static-routes-only connections never report accepted routes, so requiring them
// would make every such replacement time out.
func TestRunAcceptsZeroRoutesOnStaticRoutesOnly(t *testing.T) {
	started := time.Now()
	down := snapshot(false, 0, true, started)
	down.StaticRoutesOnly = true
	up := snapshot(true, 0, true, started.Add(time.Millisecond))
	up.StaticRoutesOnly = true

	fake := &fakeVPN{snapshots: []awsx.Connection{down, up}}
	initial := snapshot(true, 0, true, started)
	initial.StaticRoutesOnly = true

	result := New(fake, opts(), discardLogger()).Run(context.Background(), request(initial), &recorder{})
	if result.Outcome != OutcomeSucceeded {
		t.Fatalf("Outcome = %s (%s), want %s", result.Outcome, result.Detail, OutcomeSucceeded)
	}
}

// The surviving tunnel dropping is the failure every preflight check exists to
// prevent, so it must be alerted the moment it is seen, not at the end.
func TestRunAlertsWhenThePeerDrops(t *testing.T) {
	started := time.Now()
	peerDown := snapshot(false, 0, false, started)
	peerDown.Tunnels[1].StatusMessage = "IPSEC IS DOWN"

	fake := &fakeVPN{snapshots: []awsx.Connection{
		peerDown,
		snapshot(true, 4, true, started.Add(time.Millisecond)),
	}}
	rec := &recorder{}

	result := New(fake, opts(), discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, started)), rec)

	if result.Outcome != OutcomeSucceeded {
		t.Fatalf("Outcome = %s, want %s once the tunnel recovered", result.Outcome, OutcomeSucceeded)
	}
	if !result.PeerDropped {
		t.Fatal("PeerDropped must be recorded even when the run ends successfully")
	}
	if !rec.mentions("no healthy tunnel") {
		t.Fatalf("the peer drop must be alerted; messages: %v", rec.all())
	}
	if !rec.mentions("IPSEC IS DOWN") {
		t.Fatalf("the AWS status message should be surfaced; messages: %v", rec.all())
	}
	if !rec.mentions("is back UP") {
		t.Fatalf("the peer recovery should also be reported; messages: %v", rec.all())
	}
	// Losing the surviving tunnel is the one failure that leaves the connection with
	// no path, so it must not be reported at the same level as a routine step.
	if !slices.Contains(rec.reportedLevels(), "CRITICAL") {
		t.Fatalf("the peer drop must be reported as CRITICAL; levels: %v", rec.reportedLevels())
	}
}

// Every reported step carries a level. A message without one reads as unclassified
// in the approval thread, which is what the levels exist to prevent.
func TestEveryReportedStepCarriesALevel(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{snapshots: []awsx.Connection{
		snapshot(false, 0, true, started),
		snapshot(true, 9, true, started.Add(time.Millisecond)),
	}}
	rec := &recorder{}

	New(fake, opts(), discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, started)), rec)

	msgs, levels := rec.all(), rec.reportedLevels()
	if len(msgs) == 0 {
		t.Fatal("a replacement must report something")
	}
	if len(levels) != len(msgs) {
		t.Fatalf("%d messages carried %d levels", len(msgs), len(levels))
	}
	for i, l := range levels {
		if l == "" {
			t.Fatalf("message %d carried no level", i)
		}
	}
}

func TestRunTimesOutWhenTheTunnelStaysDown(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{snapshots: []awsx.Connection{snapshot(false, 0, true, started)}}
	rec := &recorder{}

	o := opts()
	o.VerifyTimeout = 60 * time.Millisecond
	result := New(fake, o, discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, started)), rec)

	if result.Outcome != OutcomeVerifyTimeout {
		t.Fatalf("Outcome = %s, want %s", result.Outcome, OutcomeVerifyTimeout)
	}
	if result.Outcome.Healthy() {
		t.Fatal("a timeout is not healthy")
	}
	if !rec.mentions("cannot be rolled back") {
		t.Fatalf("the operator must be told this cannot be undone; messages: %v", rec.all())
	}
}

// A resumed run must not re-issue the AWS call: it may already have happened, and
// calling again could trigger a second replacement.
func TestRunResumingSkipsTheAWSCall(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{snapshots: []awsx.Connection{
		snapshot(false, 0, true, started),
		snapshot(true, 6, true, started.Add(time.Millisecond)),
	}}
	rec := &recorder{}

	req := request(snapshot(true, 9, true, started))
	req.Resuming = true
	result := New(fake, opts(), discardLogger()).Run(context.Background(), req, rec)

	if replaces, _ := fake.calls(); replaces != 0 {
		t.Fatalf("a resumed run must not call ReplaceVpnTunnel, got %d calls", replaces)
	}
	if result.Outcome != OutcomeSucceeded {
		t.Fatalf("Outcome = %s, want %s", result.Outcome, OutcomeSucceeded)
	}
	if !rec.mentions("Resuming verification") {
		t.Fatalf("a resumed run should say so; messages: %v", rec.all())
	}
}

// The reported duration is how long the tunnel was out, so a resumed run counts from
// when the replacement really began rather than from the restart. Counting from the
// restart would report a multi-hour outage as a few seconds of work.
func TestRunResumingReportsTheDurationSinceTheReplacementBegan(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{snapshots: []awsx.Connection{
		snapshot(false, 0, true, started),
		snapshot(true, 6, true, started.Add(time.Millisecond)),
	}}
	rec := &recorder{}

	req := request(snapshot(true, 9, true, started))
	req.Resuming = true
	req.StartedAt = started.Add(-20 * time.Minute)
	result := New(fake, opts(), discardLogger()).Run(context.Background(), req, rec)

	if result.Duration < 20*time.Minute {
		t.Fatalf("Duration = %s, want at least the 20m since StartedAt", result.Duration)
	}
	if !rec.mentions("20m") {
		t.Fatalf("the thread should name how long the tunnel has been out; messages: %v", rec.all())
	}
}

// A fresh run has no StartedAt, so it must not inherit the zero time and report a
// duration measured from year one.
func TestRunWithoutStartedAtMeasuresFromNow(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{snapshots: []awsx.Connection{
		snapshot(false, 0, true, started),
		snapshot(true, 6, true, started.Add(time.Millisecond)),
	}}

	result := New(fake, opts(), discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, started)), &recorder{})
	if result.Duration > time.Minute {
		t.Fatalf("Duration = %s, want the time this run actually took", result.Duration)
	}
}

// Shutdown mid-verification leaves a real replacement unverified, which the
// controller must be able to tell apart from a finished run.
func TestRunAbortsOnShutdown(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{snapshots: []awsx.Connection{snapshot(false, 0, true, started)}}
	rec := &recorder{}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()

	result := New(fake, opts(), discardLogger()).Run(ctx, request(snapshot(true, 9, true, started)), rec)
	if result.Outcome != OutcomeAborted {
		t.Fatalf("Outcome = %s, want %s", result.Outcome, OutcomeAborted)
	}
	if result.Outcome.Terminal() {
		t.Fatal("an aborted run is not terminal: the replacement still needs verifying")
	}
}

// The outside IP survives an endpoint replacement, so losing it means the
// connection changed underneath the run.
func TestRunReportsADisappearingTunnel(t *testing.T) {
	started := time.Now()
	orphan := awsx.Connection{ID: "vpn-a", State: "available", Tunnels: []awsx.Tunnel{
		{OutsideIP: peerIP, Up: true, AcceptedRoutes: 12},
	}}
	fake := &fakeVPN{snapshots: []awsx.Connection{orphan}}
	rec := &recorder{}

	result := New(fake, opts(), discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, started)), rec)
	if result.Outcome != OutcomeVerifyTimeout {
		t.Fatalf("Outcome = %s, want %s", result.Outcome, OutcomeVerifyTimeout)
	}
	if !strings.Contains(result.Detail, "no longer reported") {
		t.Fatalf("Detail = %q, want it to explain the tunnel vanished", result.Detail)
	}
}

// A transient telemetry read failure is not a verdict; the run keeps polling.
func TestRunToleratesATransientDescribeFailure(t *testing.T) {
	started := time.Now()
	fake := &fakeVPN{
		describeErrs: []error{context.DeadlineExceeded, nil, nil},
		snapshots: []awsx.Connection{
			{}, // consumed by the failing call
			snapshot(false, 0, true, started),
			snapshot(true, 3, true, started.Add(time.Millisecond)),
		},
	}

	result := New(fake, opts(), discardLogger()).Run(context.Background(), request(snapshot(true, 9, true, started)), &recorder{})
	if result.Outcome != OutcomeSucceeded {
		t.Fatalf("Outcome = %s (%s), want %s", result.Outcome, result.Detail, OutcomeSucceeded)
	}
}
