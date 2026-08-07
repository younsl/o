package config

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/promx"
	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/window"
)

// Validate reports every configuration problem that would make automated tunnel
// replacement unsafe or impossible. All of them fail startup: a controller with no
// working approval channel would replace tunnels with nobody watching.
func (c *Config) Validate() error {
	var errs []error

	if c.Region == "" {
		errs = append(errs, errors.New("region is required"))
	}
	if len(c.Targets.TagFilters) == 0 {
		errs = append(errs, errors.New("targets.tagFilters must list at least one tag; "+
			"managed VPN connections are opted in explicitly, never by default"))
	}
	for i, f := range c.Targets.TagFilters {
		if f.Key == "" {
			errs = append(errs, fmt.Errorf("targets.tagFilters[%d].key is required", i))
		}
	}

	if len(c.Approval.SlackUserIDs) == 0 {
		errs = append(errs, errors.New("approval.slackUserIDs must list at least one Slack user ID; "+
			"replacements require a human approver"))
	}
	for i, id := range c.Approval.SlackUserIDs {
		if !strings.HasPrefix(id, "U") && !strings.HasPrefix(id, "W") {
			errs = append(errs, fmt.Errorf("approval.slackUserIDs[%d] = %q is not a Slack user ID "+
				"(expected Uxxxxxxxx or Wxxxxxxxx, not a display name)", i, id))
		}
	}
	if c.SlackBotToken == "" {
		errs = append(errs, errors.New("SLACK_BOT_TOKEN is required (xoxb- bot token)"))
	}
	if c.SlackAppToken == "" {
		errs = append(errs, errors.New("SLACK_APP_TOKEN is required (xapp- app-level token for Socket Mode)"))
	} else if !strings.HasPrefix(c.SlackAppToken, "xapp-") {
		errs = append(errs, errors.New("SLACK_APP_TOKEN must be an app-level token starting with xapp-; "+
			"Socket Mode does not accept a bot token"))
	}

	if err := c.MaintenanceWindow.validate(); err != nil {
		errs = append(errs, err)
	}
	if err := c.TrafficGate.validate(); err != nil {
		errs = append(errs, err)
	}

	if c.ReconcileInterval.D() <= 0 {
		errs = append(errs, errors.New("reconcileInterval must be positive"))
	}
	if c.Safety.VerifyTimeout.D() <= 0 {
		errs = append(errs, errors.New("safety.verifyTimeout must be positive"))
	}
	if c.Safety.VerifyPollInterval.D() <= 0 {
		errs = append(errs, errors.New("safety.verifyPollInterval must be positive"))
	}
	if c.Safety.VerifyPollInterval.D() >= c.Safety.VerifyTimeout.D() {
		errs = append(errs, fmt.Errorf("safety.verifyPollInterval (%s) must be shorter than safety.verifyTimeout (%s)",
			c.Safety.VerifyPollInterval, c.Safety.VerifyTimeout))
	}
	if c.Safety.PeerMinAcceptedRoutes < 0 {
		errs = append(errs, errors.New("safety.peerMinAcceptedRoutes must not be negative"))
	}
	if c.Approval.Timeout.D() <= 0 {
		errs = append(errs, errors.New("approval.timeout must be positive"))
	}
	// A minRemaining longer than the window itself can never be satisfied, so the
	// controller would poll forever without acting.
	if span := c.MaintenanceWindow.Duration.D(); span > 0 && c.MaintenanceWindow.MinRemaining.D() > span {
		errs = append(errs, fmt.Errorf("maintenanceWindow.minRemaining (%s) exceeds maintenanceWindow.duration (%s); "+
			"no replacement could ever start", c.MaintenanceWindow.MinRemaining, span))
	}
	// A window shorter than the verification it has to contain would leave every
	// replacement spilling past the window it was authorized in.
	if d := c.MaintenanceWindow.Duration.D(); d > 0 && c.Safety.VerifyTimeout.D() > d {
		errs = append(errs, fmt.Errorf("safety.verifyTimeout (%s) exceeds maintenanceWindow.duration (%s); "+
			"verification could not finish inside the window", c.Safety.VerifyTimeout, d))
	}
	// This is the check that actually enforces what minRemaining is for. Without it,
	// a replacement started at the boundary verifies past the window close, which is
	// exactly the spill the setting exists to prevent.
	if mr, vt := c.MaintenanceWindow.MinRemaining.D(), c.Safety.VerifyTimeout.D(); mr > 0 && vt > 0 && mr < vt {
		errs = append(errs, fmt.Errorf("maintenanceWindow.minRemaining (%s) is shorter than safety.verifyTimeout (%s); "+
			"a replacement started at the window boundary would verify past the close", mr, vt))
	}

	if c.LeaderElect && c.PodName == "" {
		errs = append(errs, errors.New("leaderElect requires POD_NAME (downward API)"))
	}
	if c.PodNamespace == "" {
		errs = append(errs, errors.New("POD_NAMESPACE is required (downward API); "+
			"it locates the Lease, the state ConfigMap, and emitted Events"))
	}
	if c.StateConfigMapName == "" {
		errs = append(errs, errors.New("stateConfigMapName is required"))
	}
	if c.HealthPort == c.MetricsPort {
		errs = append(errs, fmt.Errorf("healthPort and metricsPort must differ (both %d)", c.HealthPort))
	}

	return errors.Join(errs...)
}

// validate checks the traffic gate. The whole block is only meaningful when
// enabled, so a disabled gate with half-filled fields is not an error.
func (t TrafficGate) validate() error {
	if _, err := promx.ParseOnError(t.OnError); err != nil {
		return fmt.Errorf("trafficGate.%w", err)
	}
	if !t.Enabled {
		return nil
	}

	var errs []error
	if strings.TrimSpace(t.Endpoint) == "" {
		errs = append(errs, errors.New("trafficGate.endpoint is required when the gate is enabled"))
	}
	if t.Timeout.D() <= 0 {
		errs = append(errs, errors.New("trafficGate.timeout must be positive"))
	}
	// 100 would allow every moment, including the busiest one ever recorded, which
	// reads as a configured gate while being none.
	if t.QuietPercentile <= 0 || t.QuietPercentile >= 100 {
		errs = append(errs, fmt.Errorf("trafficGate.quietPercentile must be above 0 and below 100, got %v; "+
			"it is the share of this window's own traffic that counts as quiet", t.QuietPercentile))
	}
	return errors.Join(errs...)
}

func (w Window) validate() error {
	var errs []error
	if _, err := time.LoadLocation(w.Timezone); err != nil {
		errs = append(errs, fmt.Errorf("maintenanceWindow.timezone %q is not a valid IANA name: %w", w.Timezone, err))
	}
	if _, err := window.Parse(w.CronSchedule); err != nil {
		errs = append(errs, fmt.Errorf("maintenanceWindow.cronSchedule: %w", err))
	}
	if w.Duration.D() <= 0 {
		errs = append(errs, errors.New("maintenanceWindow.duration must be positive; "+
			"a cron schedule names instants, so the duration is what makes it a window"))
	}
	return errors.Join(errs...)
}
