package promx

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// OnError decides what an unavailable metric source means.
type OnError string

const (
	// OnErrorBlock treats a failed or empty query as "do not replace". The safe
	// default: no data means no evidence the moment is quiet.
	OnErrorBlock OnError = "block"
	// OnErrorAllow falls through to the other gates when metrics are unavailable,
	// for setups where Mimir being down should not stop maintenance.
	OnErrorAllow OnError = "allow"
)

// DefaultPercentile is the share of the window's traffic distribution that counts as
// quiet when none is configured.
const DefaultPercentile = 20

// GateConfig configures the traffic gate.
type GateConfig struct {
	// Enabled turns the gate on. Off, every candidate passes.
	Enabled bool
	// Percentile is the only threshold: the share of this connection's own traffic
	// during past maintenance windows that counts as quiet. 20 means "propose the
	// replacement once traffic drops into the quietest fifth of what this window
	// normally carries".
	//
	// A percentile rather than a byte figure or a ratio because it is the one form
	// that needs nothing known about the connection in advance: a busy VPN and an
	// idle one both have a quietest fifth, and neither has to be measured by hand
	// first. It also moves with the connection, so a tenfold traffic growth does not
	// silently turn the gate into a permanent block.
	Percentile float64
	// OnError decides what a failed or empty query means.
	OnError OnError
}

// Assessment is the gate's verdict on one tunnel.
type Assessment struct {
	// Allowed reports whether the replacement may proceed.
	Allowed bool
	// Evaluated is false when the gate is disabled, so callers can tell "passed"
	// from "not checked".
	Evaluated bool
	// Detail explains the verdict, for logs and the Slack card.
	Detail string
	// Current is the traffic the tunnel is carrying now, and Threshold the value at
	// the configured percentile of this window's history.
	Current   float64
	Threshold float64
	// Rank is where Current falls in that history, in percent.
	Rank float64
	// Samples is how many historical points the distribution was built from.
	Samples int
	// HasHistory is false when the verdict could not be drawn from a distribution,
	// so a caller can tell a measured verdict from an onError one.
	HasHistory bool
	// Ratio is Current over Threshold, for the metric that tracks how far the gate
	// is from opening.
	Ratio float64
	// RecommendedAt is the clock time of the window's habitually calmest slot, for
	// telling an approver when the next opportunity is expected. Empty when unknown.
	RecommendedAt string
	// RecommendedLevel is the median traffic of that slot.
	RecommendedLevel float64
}

// Gate answers whether a tunnel is quiet enough to replace right now, and when this
// window's calmest moment usually is.
//
// The maintenance window says when maintenance is permitted; a fixed schedule cannot
// know whether this particular window is busy. This closes that gap by asking the
// metric store where the present moment sits in the traffic the connection normally
// carries during that same window.
type Gate struct {
	client *Client
	cfg    GateConfig
	logger *slog.Logger

	// mu guards the detected profile, which is resolved on first use and reused.
	mu       sync.Mutex
	profile  *Profile
	detected bool
}

// NewGate builds a Gate. A nil client is only valid when the gate is disabled.
func NewGate(client *Client, cfg GateConfig, logger *slog.Logger) (*Gate, error) {
	if cfg.Percentile == 0 {
		cfg.Percentile = DefaultPercentile
	}
	if logger == nil {
		logger = slog.Default()
	}
	if cfg.Enabled {
		if client == nil {
			return nil, errors.New("traffic gate is enabled but no metric endpoint was configured")
		}
		if cfg.Percentile < 0 || cfg.Percentile > 100 {
			return nil, fmt.Errorf("traffic gate percentile must be between 0 and 100, got %v", cfg.Percentile)
		}
	}
	return &Gate{client: client, cfg: cfg, logger: logger}, nil
}

// Vars describe the tunnel being judged and the window it would be replaced in.
type Vars struct {
	VPNConnectionID string
	VPNName         string
	TunnelIP        string
	PeerIP          string
	Region          string
	// InWindow reports whether a past instant fell inside a maintenance window. It
	// is what restricts the distribution to comparable moments; without it the whole
	// lookback is used, which mixes business hours with nights and yields a target
	// no daytime window ever reaches.
	InWindow func(time.Time) bool
	// Loc is the timezone recommended clock times are rendered in.
	Loc *time.Location
	// Urgent relaxes the target to the median, for a tunnel whose AWS auto-apply
	// deadline is close enough that holding out for the quietest slot risks letting
	// AWS pick the moment instead.
	Urgent bool
}

// Evaluate runs the query and returns the verdict. It never returns an error: a metric
// source that cannot answer is itself a verdict, decided by OnError, and the caller
// needs the explanation more than the error value.
func (g *Gate) Evaluate(ctx context.Context, v Vars) Assessment {
	if !g.cfg.Enabled {
		return Assessment{Allowed: true}
	}

	profile, err := g.resolveProfile(ctx, v)
	if err != nil {
		return g.onQueryFailure("metric discovery", err)
	}

	// One range query answers both halves of the question, so the current value and
	// the distribution it is judged against can never drift apart.
	now := time.Now()
	samples, err := g.client.QueryRange(ctx, profile.TrafficQuery(v), now.Add(-lookback), now, step)
	if err != nil {
		return g.onQueryFailure("traffic history", err)
	}

	current, ok := sustainedNow(samples, now)
	if !ok {
		return g.onQueryFailure("current traffic", fmt.Errorf(
			"no sample in the last %s, so the exporter is not reporting rather than the tunnel being idle", sustain))
	}

	h := newHistory(samples, v.InWindow, v.Loc)
	if len(h.values) < minSamples {
		return g.onQueryFailure("traffic history", fmt.Errorf(
			"only %d sample(s) fall inside past maintenance windows and %d are needed before a percentile means "+
				"anything; the window or the exporter may be new", len(h.values), minSamples))
	}

	target := g.cfg.Percentile
	relaxed := false
	if v.Urgent && target < urgentPercentile {
		target, relaxed = urgentPercentile, true
	}

	a := Assessment{
		Evaluated:  true,
		Current:    current,
		Threshold:  h.percentile(target),
		Rank:       h.rank(current),
		Samples:    len(h.values),
		HasHistory: true,
	}
	if a.Threshold > 0 {
		a.Ratio = current / a.Threshold
	}
	if at, level, found := h.quietest(); found {
		a.RecommendedAt, a.RecommendedLevel = at, level
	}
	// At or below, so a connection that is genuinely idle during its window passes on
	// a threshold of zero instead of waiting for traffic to go negative.
	a.Allowed = current <= a.Threshold
	a.Detail = g.explain(a, target, relaxed, v, now)
	return a
}

// explain renders the verdict the way an approver has to be able to check it: the
// measured value, where it sits, and what it was compared against.
func (g *Gate) explain(a Assessment, target float64, relaxed bool, v Vars, now time.Time) string {
	var b strings.Builder
	days := int(lookback.Hours() / 24)
	if a.Allowed {
		fmt.Fprintf(&b, "traffic is %s, inside the quietest %.0f%% of what this connection carries during this "+
			"window (P%.0f is %s across %d samples from the last %d days)",
			formatValue(a.Current), target, target, formatValue(a.Threshold), a.Samples, days)
	} else {
		fmt.Fprintf(&b, "traffic is %s, at P%.0f of what this connection carries during this window, above the "+
			"P%.0f target of %s",
			formatValue(a.Current), a.Rank, target, formatValue(a.Threshold))
		if a.RecommendedAt != "" {
			fmt.Fprintf(&b, "; this window is usually calmest around %s, at %s",
				formatClock(a.RecommendedAt, v.Loc, now), formatValue(a.RecommendedLevel))
		}
	}
	if relaxed {
		fmt.Fprintf(&b, "; the AWS deadline is near, so the target was relaxed from P%.0f to the median",
			g.cfg.Percentile)
	}
	return b.String()
}

// Enabled reports whether the gate is active.
func (g *Gate) Enabled() bool { return g.cfg.Enabled }

// Percentile reports the configured quiet target.
func (g *Gate) Percentile() float64 { return g.cfg.Percentile }

// FailClosed reports whether an unusable metric source blocks replacements. When it
// does, a metric source that cannot answer at startup is not a warning: every
// candidate would be blocked for as long as it stays that way.
func (g *Gate) FailClosed() bool { return g.cfg.Enabled && g.cfg.OnError == OnErrorBlock }

// Verify proves at startup that the gate can actually answer, rather than finding out
// during the first maintenance window.
//
// v may name a real connection or be zero. With a connection the check goes all the
// way through detection and the real query, which is the only way to know the exporter
// is present; without one it can only prove the endpoint answers, since both the
// profile probe and the query need an ID to select on.
func (g *Gate) Verify(ctx context.Context, v Vars) error {
	if !g.cfg.Enabled {
		return nil
	}

	// vector(1) needs no exporter and no tenant data, so a failure here is the
	// endpoint, the network, or the headers, and nothing else.
	if _, err := g.client.Query(ctx, "vector(1)"); err != nil {
		return fmt.Errorf("the metric endpoint did not answer a trivial query, so the endpoint, its headers, "+
			"or network access to it is wrong: %w", err)
	}
	if v.VPNConnectionID == "" {
		g.logger.Warn("traffic gate endpoint answered, but no managed VPN connection was available to probe " +
			"the traffic metric with; the exporter is verified on the first evaluation instead")
		return nil
	}

	profile, err := g.resolveProfile(ctx, v)
	if err != nil {
		return fmt.Errorf("no usable VPN traffic metric for %s: %w", v.VPNConnectionID, err)
	}
	query := profile.TrafficQuery(v)
	if _, err := g.client.Query(ctx, query); err != nil {
		return fmt.Errorf("the traffic query for %s returned nothing usable (%s): %w", v.VPNConnectionID, query, err)
	}
	g.logger.Info("traffic gate verified",
		"vpn_connection_id", v.VPNConnectionID, "query", query, "percentile", g.cfg.Percentile)
	return nil
}

// resolveProfile returns the detected exporter profile, detecting it on first use.
//
// The exporter convention is detected once and reused: probing on every pass would
// multiply queries against the metric store for an answer that does not change while
// the exporter stays the same.
func (g *Gate) resolveProfile(ctx context.Context, v Vars) (Profile, error) {
	g.mu.Lock()
	defer g.mu.Unlock()

	if g.detected && g.profile != nil {
		return *g.profile, nil
	}

	profile, err := Detect(ctx, g.client, v.VPNConnectionID)
	if err != nil {
		// Left undetected so a later pass retries: the metric may simply not have
		// been scraped yet when the controller started.
		return Profile{}, err
	}
	g.profile, g.detected = &profile, true
	g.logger.Info("detected VPN traffic metric for the traffic gate",
		"profile", profile.String(), "vpn_connection_id", v.VPNConnectionID)
	return profile, nil
}

// onQueryFailure turns an unusable metric source into a verdict.
func (g *Gate) onQueryFailure(what string, err error) Assessment {
	allowed := g.cfg.OnError == OnErrorAllow
	reason := err.Error()
	if errors.Is(err, ErrNoData) {
		reason = "query returned no data"
	}
	detail := fmt.Sprintf("%s query failed (%s); ", what, reason)
	if allowed {
		detail += "onError is allow, so the traffic gate is skipped"
	} else {
		detail += "onError is block, so the replacement is held until metrics are readable"
	}
	return Assessment{Allowed: allowed, Evaluated: true, Detail: detail}
}

// formatValue renders a metric value compactly. The unit is whatever the query
// returns, so none is printed.
func formatValue(v float64) string {
	switch {
	case v == 0:
		return "0"
	case v >= 1e9:
		return fmt.Sprintf("%.2fG", v/1e9)
	case v >= 1e6:
		return fmt.Sprintf("%.2fM", v/1e6)
	case v >= 1e3:
		return fmt.Sprintf("%.2fk", v/1e3)
	default:
		return fmt.Sprintf("%.2f", v)
	}
}

// ParseOnError validates an onError setting.
func ParseOnError(s string) (OnError, error) {
	switch OnError(strings.ToLower(strings.TrimSpace(s))) {
	case "", OnErrorBlock:
		return OnErrorBlock, nil
	case OnErrorAllow:
		return OnErrorAllow, nil
	default:
		return "", fmt.Errorf("onError must be %q or %q, got %q", OnErrorBlock, OnErrorAllow, s)
	}
}

// DefaultTimeout is the per-query timeout used when none is configured.
const DefaultTimeout = 10 * time.Second
