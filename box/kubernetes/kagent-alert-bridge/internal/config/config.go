// Package config loads bridge settings from environment variables.
package config

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// DefaultInstructions is appended to every prompt sent to the agent. It is
// deliberately generic: deployment-specific wording (language, runbook links,
// escalation policy) belongs in ANALYSIS_INSTRUCTIONS or in the agent's own
// system message, not in this binary.
const DefaultInstructions = `Investigate the alert above with the tools available to you.
Inspect only; never create, modify, or delete any resource.
Reply in Slack mrkdwn: *bold* uses single asterisks, no markdown headings, no tables.
Keep the whole reply under 3000 characters and use exactly these sections:
*Summary* - one or two sentences on what is broken.
*Evidence* - the queries or commands you ran and what they returned.
*Likely cause* - at most three ranked hypotheses.
*Next actions* - concrete steps for the on-call engineer.
*Confidence* - high, medium, or low, with the reason.`

// Parent message strategies.
const (
	// ParentModeLookup leaves the alert notification to Alertmanager and finds
	// it again in the channel to thread under. Alertmanager keeps its
	// slack_configs and its templates.
	ParentModeLookup = "lookup"
	// ParentModePost makes the bridge publish the alert itself, which yields
	// the thread timestamp directly. Alertmanager sends only the webhook.
	ParentModePost = "post"
)

// Config holds all runtime settings for the bridge.
type Config struct {
	// Slack
	SlackToken       string
	SlackAPIURL      string
	SlackChannel     string
	SlackChannelMap  map[string]string
	ChannelLabel     string
	SlackMaxTextRune int
	ParentMode       string
	LookupWindow     time.Duration
	LookupAttempts   int
	// InvestigatingReaction is the emoji (without colons) the bridge puts on
	// the alert notification while the agent works, and removes when the
	// analysis lands. Empty disables the reaction. Needs reactions:write.
	InvestigatingReaction string
	// CompletedReaction replaces InvestigatingReaction once the analysis has
	// been posted. Empty disables it. Needs reactions:write.
	CompletedReaction string

	// kagent A2A
	KagentURL       string
	KagentNamespace string
	// KagentAgent is the agent used when the routing label is absent or names
	// no mapped agent.
	KagentAgent string
	// KagentAgentRoutingLabel is the alert label that selects the agent. It
	// defaults to ChannelLabel, because a deployment that already routes alerts
	// to per-topic Slack channels usually wants the same split across agents.
	KagentAgentRoutingLabel string
	// KagentAgentRoutingMap routes a label value to the agent that handles it,
	// so one bridge can feed several specialised agents. Unlike SlackChannelMap
	// it is not an alias table: a value it does not carry falls back to
	// KagentAgent rather than being used as an agent name.
	KagentAgentRoutingMap map[string]string
	KagentUserID          string
	// KagentTimeout is the deadline for one whole analysis: queueing for a
	// slot, the parent lookup, and the polled agent run.
	KagentTimeout time.Duration
	// KagentRequestTimeout bounds a single HTTP call to the controller
	// (submit, poll, or cancel), not the analysis.
	KagentRequestTimeout time.Duration
	// KagentPollInterval is the wait between two tasks/get reads.
	KagentPollInterval time.Duration

	// Analysis gating
	AnalyzeSeverities map[string]bool
	AnalyzeLabel      string
	AnalyzeResolved   bool
	DedupeTTL         time.Duration
	MaxAlertsInPrompt int
	MaxConcurrent     int
	Instructions      string

	// Serving
	WebhookPath  string
	WebhookToken string
	ListenPort   int
	MetricsPort  int
	LogLevel     string
	LogFormat    string
}

// Load reads configuration from environment variables and applies defaults.
func Load() (Config, error) {
	cfg := Config{
		SlackToken:   os.Getenv("SLACK_BOT_TOKEN"),
		SlackAPIURL:  getEnv("SLACK_API_URL", "https://slack.com/api"),
		SlackChannel: os.Getenv("SLACK_DEFAULT_CHANNEL"),
		ChannelLabel: getEnv("SLACK_CHANNEL_LABEL", "slack_channel"),
		// Headroom over the 3000 characters the instructions ask for: agents
		// overrun that regularly, and truncation is a safety net rather than a
		// formatter. 8000 also stays inside the Slack attachment text limit.
		SlackMaxTextRune:      8000,
		ParentMode:            getEnv("SLACK_PARENT_MODE", ParentModeLookup),
		LookupWindow:          15 * time.Minute,
		LookupAttempts:        3,
		InvestigatingReaction: "telescope",
		CompletedReaction:     "white_check_mark",
		KagentURL:             getEnv("KAGENT_URL", "http://kagent-controller.kagent:8083"),
		KagentNamespace:       getEnv("KAGENT_NAMESPACE", "kagent"),
		KagentAgent:           getEnv("KAGENT_AGENT", "alert-triage-agent"),
		KagentUserID:          getEnv("KAGENT_USER_ID", "alert-bridge@kagent.dev"),
		KagentTimeout:         120 * time.Second,
		KagentRequestTimeout:  30 * time.Second,
		KagentPollInterval:    5 * time.Second,
		AnalyzeLabel:          getEnv("ANALYZE_LABEL", "analyze"),
		DedupeTTL:             12 * time.Hour,
		MaxAlertsInPrompt:     5,
		MaxConcurrent:         2,
		Instructions:          getEnv("ANALYSIS_INSTRUCTIONS", DefaultInstructions),
		WebhookPath:           getEnv("WEBHOOK_PATH", "/alert"),
		WebhookToken:          os.Getenv("WEBHOOK_BEARER_TOKEN"),
		ListenPort:            8080,
		MetricsPort:           8081,
		LogLevel:              getEnv("LOG_LEVEL", "info"),
		LogFormat:             getEnv("LOG_FORMAT", "json"),
	}

	if cfg.SlackToken == "" {
		return Config{}, fmt.Errorf("SLACK_BOT_TOKEN is required")
	}
	if cfg.SlackChannel == "" {
		return Config{}, fmt.Errorf("SLACK_DEFAULT_CHANNEL is required")
	}
	if !strings.HasPrefix(cfg.WebhookPath, "/") {
		return Config{}, fmt.Errorf("WEBHOOK_PATH %q must start with /", cfg.WebhookPath)
	}
	if cfg.ParentMode != ParentModeLookup && cfg.ParentMode != ParentModePost {
		return Config{}, fmt.Errorf("invalid SLACK_PARENT_MODE %q: must be %q or %q",
			cfg.ParentMode, ParentModeLookup, ParentModePost)
	}
	cfg.KagentAgentRoutingLabel = getEnv("KAGENT_AGENT_ROUTING_LABEL", cfg.ChannelLabel)

	// LookupEnv keeps an explicitly empty value meaningful: it turns the
	// reaction off, while an unset variable keeps the default.
	if v, ok := os.LookupEnv("SLACK_INVESTIGATING_REACTION"); ok {
		cfg.InvestigatingReaction = strings.Trim(strings.TrimSpace(v), ":")
	}
	if v, ok := os.LookupEnv("SLACK_COMPLETED_REACTION"); ok {
		cfg.CompletedReaction = strings.Trim(strings.TrimSpace(v), ":")
	}

	var err error
	if cfg.SlackChannelMap, err = pairsEnv("SLACK_CHANNEL_MAP"); err != nil {
		return Config{}, err
	}
	if cfg.KagentAgentRoutingMap, err = pairsEnv("KAGENT_AGENT_ROUTING_MAP"); err != nil {
		return Config{}, err
	}
	if cfg.AnalyzeSeverities, err = setEnv("ANALYZE_SEVERITIES", "critical"); err != nil {
		return Config{}, err
	}
	if cfg.AnalyzeResolved, err = boolEnv("ANALYZE_RESOLVED", false); err != nil {
		return Config{}, err
	}
	if cfg.KagentTimeout, err = durationEnv("KAGENT_TIMEOUT", cfg.KagentTimeout, time.Second); err != nil {
		return Config{}, err
	}
	if cfg.KagentRequestTimeout, err = durationEnv("KAGENT_REQUEST_TIMEOUT", cfg.KagentRequestTimeout, time.Second); err != nil {
		return Config{}, err
	}
	if cfg.KagentPollInterval, err = durationEnv("KAGENT_POLL_INTERVAL", cfg.KagentPollInterval, time.Second); err != nil {
		return Config{}, err
	}
	if cfg.DedupeTTL, err = durationEnv("DEDUPE_TTL", cfg.DedupeTTL, 0); err != nil {
		return Config{}, err
	}
	if cfg.MaxAlertsInPrompt, err = intEnv("MAX_ALERTS_IN_PROMPT", cfg.MaxAlertsInPrompt, 1, 100); err != nil {
		return Config{}, err
	}
	if cfg.MaxConcurrent, err = intEnv("MAX_CONCURRENT_ANALYSES", cfg.MaxConcurrent, 1, 64); err != nil {
		return Config{}, err
	}
	if cfg.SlackMaxTextRune, err = intEnv("SLACK_MAX_TEXT", cfg.SlackMaxTextRune, 500, 39000); err != nil {
		return Config{}, err
	}
	if cfg.LookupWindow, err = durationEnv("SLACK_LOOKUP_WINDOW", cfg.LookupWindow, time.Minute); err != nil {
		return Config{}, err
	}
	if cfg.LookupAttempts, err = intEnv("SLACK_LOOKUP_ATTEMPTS", cfg.LookupAttempts, 1, 10); err != nil {
		return Config{}, err
	}
	if cfg.ListenPort, err = intEnv("LISTEN_PORT", cfg.ListenPort, 1, 65535); err != nil {
		return Config{}, err
	}
	if cfg.MetricsPort, err = intEnv("METRICS_PORT", cfg.MetricsPort, 1, 65535); err != nil {
		return Config{}, err
	}
	if cfg.ListenPort == cfg.MetricsPort {
		return Config{}, fmt.Errorf("LISTEN_PORT and METRICS_PORT must differ, both are %d", cfg.ListenPort)
	}
	return cfg, nil
}

// Agents returns every agent the bridge may route to, the default first and
// the mapped ones sorted after it. It exists for startup logging: the agent a
// given alert reaches is otherwise only visible once one fires.
func (c Config) Agents() []string {
	agents := []string{c.KagentAgent}
	seen := map[string]bool{c.KagentAgent: true}
	for _, agent := range c.KagentAgentRoutingMap {
		if !seen[agent] {
			seen[agent] = true
			agents = append(agents, agent)
		}
	}
	sort.Strings(agents[1:])
	return agents
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func intEnv(key string, fallback, min, max int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < min || n > max {
		return 0, fmt.Errorf("invalid %s %q: must be an integer between %d and %d", key, v, min, max)
	}
	return n, nil
}

func boolEnv(key string, fallback bool) (bool, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return false, fmt.Errorf("invalid %s %q: must be a boolean", key, v)
	}
	return b, nil
}

func durationEnv(key string, fallback, min time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return fallback, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("invalid %s %q: %w", key, v, err)
	}
	if d < min {
		return 0, fmt.Errorf("%s must be at least %s, got %s", key, min, d)
	}
	return d, nil
}

// setEnv parses a comma-separated list into a lookup set. An explicitly empty
// value disables the filter, which callers read as "match everything".
func setEnv(key, fallback string) (map[string]bool, error) {
	v, ok := os.LookupEnv(key)
	if !ok {
		v = fallback
	}
	set := map[string]bool{}
	for item := range strings.SplitSeq(v, ",") {
		if item = strings.TrimSpace(item); item != "" {
			set[item] = true
		}
	}
	return set, nil
}

// pairsEnv parses a "key=value,key=value" list into a map.
func pairsEnv(key string) (map[string]string, error) {
	v := os.Getenv(key)
	pairs := map[string]string{}
	if v == "" {
		return pairs, nil
	}
	for item := range strings.SplitSeq(v, ",") {
		if item = strings.TrimSpace(item); item == "" {
			continue
		}
		k, val, ok := strings.Cut(item, "=")
		k, val = strings.TrimSpace(k), strings.TrimSpace(val)
		if !ok || k == "" || val == "" {
			return nil, fmt.Errorf("invalid %s entry %q: expected key=value", key, item)
		}
		pairs[k] = val
	}
	return pairs, nil
}
