// Package config loads and validates runtime configuration from a single YAML file.
// The Slack tokens (Secret) and Pod identity (downward API) come from the
// environment instead, since neither belongs in a plain ConfigMap.
package config

import (
	"fmt"
	"os"
	"time"

	"sigs.k8s.io/yaml"

	"github.com/younsl/o/box/kubernetes/aws-vpn-maintenance-handler/internal/promx"
)

// DefaultConfigFile is the config file path used when CONFIG_FILE is unset.
const DefaultConfigFile = "/etc/aws-vpn-maintenance-handler/config.yaml"

// TagFilter is a single EC2 tag key/value pair used to scope target VPN
// connections. An empty Value matches any value for that key.
type TagFilter struct {
	Key   string `json:"key"`
	Value string `json:"value,omitempty"`
}

// Targets selects which VPN connections this controller owns. Opting in by tag is
// deliberate: a new VPN is never eligible until someone tags it.
type Targets struct {
	// TagFilters must all match (AND). Required and non-empty.
	TagFilters []TagFilter `json:"tagFilters,omitempty"`
	// ExcludeConnectionIDs drops specific connections even if their tags match.
	ExcludeConnectionIDs []string `json:"excludeConnectionIDs,omitempty"`
}

// Window is the maintenance window during which replacements may start. Each firing
// of CronSchedule opens the window for Duration; cron alone only names instants.
type Window struct {
	// Timezone is an IANA name (e.g. Asia/Seoul), so the window follows DST.
	Timezone string `json:"timezone,omitempty"`
	// CronSchedule is a standard 5-field expression: minute hour dom month dow.
	CronSchedule string `json:"cronSchedule,omitempty"`
	// Duration is how long the window stays open after each firing.
	Duration Duration `json:"duration,omitempty"`
	// MinRemaining refuses to start with less than this much window left, so
	// verification finishes before it closes. Left unset it becomes
	// safety.verifyTimeout, which is the only value that makes the guarantee it
	// exists for: a replacement may not start unless the window can still contain
	// the verification of it.
	MinRemaining Duration `json:"minRemaining,omitempty"`
}

// Safety holds the preflight and verification thresholds that make an irreversible
// ReplaceVpnTunnel call safe to automate.
type Safety struct {
	// PeerMinStableFor requires the surviving tunnel to have held UP this long,
	// since a peer that just came up may be flapping. Measured against the AWS
	// LastStatusChange, so an IKE, IPsec, or BGP flip restarts the clock. The
	// default 5m is the window a post-replacement flap shows up in; it is also the
	// wait the sibling tunnel serves before it may be chained, which is the only
	// place this value costs time.
	PeerMinStableFor Duration `json:"peerMinStableFor,omitempty"`
	// PeerMinAcceptedRoutes is the minimum BGP route count on the surviving
	// tunnel. Skipped on static-routes-only connections.
	PeerMinAcceptedRoutes int32 `json:"peerMinAcceptedRoutes,omitempty"`
	// PerConnectionCooldown blocks a second replacement on the same connection.
	PerConnectionCooldown Duration `json:"perConnectionCooldown,omitempty"`
	// ChainSiblingTunnel lets the connection's other tunnel skip the cooldown once
	// the first was replaced successfully, so both tunnels finish in one window
	// instead of a day apart. The peer checks still gate it: the sibling waits until
	// the freshly replaced tunnel is UP and stable for PeerMinStableFor, so the wait
	// is enforced by measuring the tunnel rather than by the clock. A replacement
	// that ended badly is never chained from.
	ChainSiblingTunnel bool `json:"chainSiblingTunnel,omitempty"`
	// VerifyTimeout bounds the wait for the tunnel to come back UP.
	VerifyTimeout Duration `json:"verifyTimeout,omitempty"`
	// VerifyPollInterval is the delay between telemetry polls while verifying.
	VerifyPollInterval Duration `json:"verifyPollInterval,omitempty"`
	// EscalateBefore raises severity once the AWS auto-apply deadline is nearer
	// than this, so an unanswered approval is not silently ignored.
	EscalateBefore Duration `json:"escalateBefore,omitempty"`
}

// Approval configures the human gate in front of every replacement.
type Approval struct {
	// SlackUserIDs receive the DM and may approve. Required; user IDs
	// (Uxxxxxxxx), not display names.
	SlackUserIDs []string `json:"slackUserIDs,omitempty"`
	// Timeout expires an unanswered request; the tunnel is left alone.
	Timeout Duration `json:"timeout,omitempty"`
	// ProgressHeartbeat is how often to post a "still waiting" thread update
	// while verifying, even when nothing changed.
	ProgressHeartbeat Duration `json:"progressHeartbeat,omitempty"`
}

// TrafficGate consults Prometheus or Mimir so a replacement only runs while the
// tunnel is actually quiet. The cron window says when maintenance is permitted; a
// fixed schedule cannot know that this particular window happens to be busy.
//
// Only the window and one percentile are configured. Everything else, including which
// exporter publishes the metric and how much traffic is normal for this connection at
// this time of day, is measured rather than declared.
type TrafficGate struct {
	// Enabled turns the gate on. Off, only the window and the peer checks apply.
	Enabled bool `json:"enabled,omitempty"`
	// Endpoint is the query API base URL, the part before /api/v1/query. For Mimir
	// that is usually the .../prometheus path.
	Endpoint string `json:"endpoint,omitempty"`
	// Headers are sent with every query, for tenant selectors like X-Scope-OrgID.
	Headers map[string]string `json:"headers,omitempty"`
	// Timeout bounds a single query.
	Timeout Duration `json:"timeout,omitempty"`
	// QuietPercentile is the share of this connection's own traffic during past
	// maintenance windows that counts as quiet. 20 proposes the replacement once
	// traffic falls into the quietest fifth of what the window normally carries.
	//
	// Lower waits for a calmer moment and may not find one; higher acts sooner. It
	// needs no knowledge of the connection: every VPN, busy or idle, has a quietest
	// fifth of its own history.
	QuietPercentile float64 `json:"quietPercentile,omitempty"`
	// OnError is "block" or "allow": what an unreadable metric source means.
	OnError string `json:"onError,omitempty"`
}

// Config holds all runtime settings.
type Config struct {
	// Region is the AWS region to operate in. Required.
	Region string `json:"region,omitempty"`
	// ReconcileInterval is how often to poll VPN telemetry and maintenance
	// status.
	ReconcileInterval Duration `json:"reconcileInterval,omitempty"`
	// DryRun asks for approval as usual, but sends the AWS DryRun flag, which
	// validates permissions and arguments without replacing anything.
	DryRun bool `json:"dryRun,omitempty"`

	Targets           Targets     `json:"targets"`
	MaintenanceWindow Window      `json:"maintenanceWindow"`
	Safety            Safety      `json:"safety"`
	Approval          Approval    `json:"approval"`
	TrafficGate       TrafficGate `json:"trafficGate"`

	// LeaderElect reconciles only on the Lease holder. Required above one
	// replica, since two could replace both tunnels of one connection.
	LeaderElect bool   `json:"leaderElect,omitempty"`
	LeaseName   string `json:"leaseName,omitempty"`
	// StateConfigMapName holds in-flight and cooldown state, so a restart neither
	// loses a running replacement nor re-proposes one it just made.
	StateConfigMapName string `json:"stateConfigMapName,omitempty"`

	HealthPort  int    `json:"healthPort,omitempty"`
	MetricsPort int    `json:"metricsPort,omitempty"`
	LogLevel    string `json:"logLevel,omitempty"`
	LogFormat   string `json:"logFormat,omitempty"`

	// Runtime-injected, not part of the YAML file.

	// SlackBotToken (xoxb-) authorizes conversations.open, chat.postMessage, and
	// chat.update. From SLACK_BOT_TOKEN.
	SlackBotToken string `json:"-"`
	// SlackAppToken (xapp-) opens the Socket Mode connection that delivers clicks
	// over an outbound WebSocket. From SLACK_APP_TOKEN.
	SlackAppToken string `json:"-"`

	PodName      string `json:"-"`
	PodNamespace string `json:"-"`
	PodUID       string `json:"-"`
}

// Duration is a time.Duration that unmarshals from a YAML string like "5m", so
// durations are written with units.
type Duration time.Duration

// UnmarshalJSON parses the duration string. sigs.k8s.io/yaml converts YAML to JSON
// first, so this is the hook YAML parsing goes through.
//
// A null or empty value leaves the default in place. The Helm chart declares the
// tunable durations with no value so they are visible in values.yaml without being
// set, and that renders as null; treating it as "unset" is what makes the listing
// and the default agree.
func (d *Duration) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	var s string
	if err := yaml.Unmarshal(b, &s); err != nil {
		return fmt.Errorf("duration must be a quoted string like \"5m\": %w", err)
	}
	if s == "" {
		return nil
	}
	parsed, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("invalid duration %q: %w", s, err)
	}
	*d = Duration(parsed)
	return nil
}

// D returns the value as a time.Duration.
func (d Duration) D() time.Duration { return time.Duration(d) }

// String renders the duration in Go duration syntax.
func (d Duration) String() string { return time.Duration(d).String() }

// defaults fails closed on purpose: dry run on, a 24h cooldown, and a 5m peer
// stability requirement.
func defaults() Config {
	return Config{
		ReconcileInterval:  Duration(5 * time.Minute),
		DryRun:             true,
		LeaderElect:        true,
		LeaseName:          "aws-vpn-maintenance-handler",
		StateConfigMapName: "aws-vpn-maintenance-handler-state",
		HealthPort:         8081,
		MetricsPort:        9090,
		LogLevel:           "info",
		LogFormat:          "json",
		MaintenanceWindow: Window{
			Timezone:     "UTC",
			CronSchedule: "0 2 * * *",
			Duration:     Duration(3 * time.Hour),
		},
		Safety: Safety{
			PeerMinStableFor:      Duration(5 * time.Minute),
			PeerMinAcceptedRoutes: 1,
			PerConnectionCooldown: Duration(24 * time.Hour),
			ChainSiblingTunnel:    true,
			VerifyTimeout:         Duration(30 * time.Minute),
			VerifyPollInterval:    Duration(10 * time.Second),
			// A week, because the useful signal is "this needs a window soon"
			// rather than "this is about to happen": with a weekly window, 72h
			// could leave only one occurrence to act in.
			EscalateBefore: Duration(168 * time.Hour),
		},
		Approval: Approval{
			Timeout:           Duration(time.Hour),
			ProgressHeartbeat: Duration(5 * time.Minute),
		},
		TrafficGate: TrafficGate{
			Timeout: Duration(10 * time.Second),
			// Unreadable metrics mean no evidence the tunnel is quiet, so the
			// default withholds the replacement rather than assuming it.
			OnError:         string(promx.OnErrorBlock),
			QuietPercentile: promx.DefaultPercentile,
		},
	}
}

// Load reads the YAML file at path over the defaults, applies the env-injected
// values, and validates the result.
func Load(path string) (*Config, error) {
	if path == "" {
		path = getEnv("CONFIG_FILE", DefaultConfigFile)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config file: %w", err)
	}

	cfg := defaults()
	// Strict, so a typo in a safety threshold is a startup error rather than a
	// silently ignored field.
	if err := yaml.UnmarshalStrict(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse config file %s: %w", path, err)
	}

	cfg.SlackBotToken = os.Getenv("SLACK_BOT_TOKEN")
	cfg.SlackAppToken = os.Getenv("SLACK_APP_TOKEN")
	cfg.PodName = os.Getenv("POD_NAME")
	cfg.PodNamespace = os.Getenv("POD_NAMESPACE")
	cfg.PodUID = os.Getenv("POD_UID")

	if v := os.Getenv("LOG_LEVEL"); v != "" {
		cfg.LogLevel = v
	}
	if v := os.Getenv("LOG_FORMAT"); v != "" {
		cfg.LogFormat = v
	}
	if v := os.Getenv("AWS_REGION"); v != "" && cfg.Region == "" {
		cfg.Region = v
	}

	// Derived rather than defaulted: a fixed number here would silently disagree
	// with a verifyTimeout somebody tuned, and the two only mean anything together.
	if cfg.MaintenanceWindow.MinRemaining == 0 {
		cfg.MaintenanceWindow.MinRemaining = cfg.Safety.VerifyTimeout
	}

	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
