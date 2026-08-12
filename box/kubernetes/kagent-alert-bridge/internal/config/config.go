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

// DefaultChatInstructions is appended to every mention prompt. A question has
// no alert sections to fill, so it asks for a direct answer rather than the
// analysis layout ANALYSIS_INSTRUCTIONS prescribes.
const DefaultChatInstructions = `Answer the question above with the tools available to you.
Inspect only; never create, modify, or delete any resource.
Reply in Slack mrkdwn: *bold* uses single asterisks, no markdown headings, no tables.
Keep the reply under 2000 characters and answer directly, without restating the question.
Say so plainly when the tools cannot answer, instead of guessing.`

// Built-in ephemeral hints. Both are sent to the asker alone, so the rule is
// discoverable without the channel paying for it. The denied hint never names
// the channels that are served.
const (
	DefaultThreadHint = "스레드 안에서만 답변합니다. 질문할 스레드에서 다시 멘션해 주세요."
	DefaultDeniedHint = "이 채널에서는 답변하지 않습니다."
)

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

	// Slack mention invocation
	//
	// SlackAppToken is the app-level token (xapp-...) that opens the Socket
	// Mode connection. Empty leaves the whole mention path off, so the binary
	// behaves exactly as it did before the feature existed.
	SlackAppToken string
	// ChatAgent answers mentions that ChatAgentMap does not route elsewhere.
	ChatAgent string
	// ChatAgentMap routes a channel (name or ID) to a specialised agent.
	ChatAgentMap map[string]string
	// ChatChannels is the channel allow list, holding names or IDs. Empty
	// allows every channel the bot is a member of.
	ChatChannels []string
	// ChatAllowedUsers is the Slack member ID allow list. Empty allows everyone
	// in the allowed channels.
	ChatAllowedUsers map[string]bool
	ChatInstructions string
	// ChatTimeout is the deadline for one whole turn, including queueing.
	ChatTimeout time.Duration
	// ChatSessionTTL is how long a thread keeps its A2A contextId after its
	// last turn.
	ChatSessionTTL time.Duration
	// ChatStatusInterval is how often the in-thread status message is rewritten
	// while the agent works.
	ChatStatusInterval time.Duration
	// ChatThreadHint and ChatDeniedHint are the ephemeral hints for the two
	// drops a person cannot tell from an outage. Empty restores a silent drop.
	ChatThreadHint     string
	ChatDeniedHint     string
	MaxConcurrentChats int

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
		SlackAppToken:         os.Getenv("SLACK_APP_TOKEN"),
		ChatInstructions:      getEnv("CHAT_INSTRUCTIONS", DefaultChatInstructions),
		ChatTimeout:           180 * time.Second,
		ChatSessionTTL:        2 * time.Hour,
		ChatStatusInterval:    10 * time.Second,
		ChatThreadHint:        DefaultThreadHint,
		ChatDeniedHint:        DefaultDeniedHint,
		MaxConcurrentChats:    2,
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
	// An explicitly empty hint is meaningful too: it turns that hint off and
	// restores the silent drop for that case alone.
	if v, ok := os.LookupEnv("CHAT_THREAD_HINT"); ok {
		cfg.ChatThreadHint = strings.TrimSpace(v)
	}
	if v, ok := os.LookupEnv("CHAT_DENIED_HINT"); ok {
		cfg.ChatDeniedHint = strings.TrimSpace(v)
	}
	// The chat agent defaults to the alert agent, so enabling mentions needs no
	// second agent name in the common deployment.
	cfg.ChatAgent = getEnv("CHAT_AGENT", cfg.KagentAgent)
	cfg.ChatChannels = listEnv("CHAT_CHANNELS")

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
	if cfg.ChatAgentMap, err = pairsEnv("CHAT_AGENT_MAP"); err != nil {
		return Config{}, err
	}
	if cfg.ChatAllowedUsers, err = setEnv("CHAT_ALLOWED_USERS", ""); err != nil {
		return Config{}, err
	}
	if cfg.ChatTimeout, err = durationEnv("CHAT_TIMEOUT", cfg.ChatTimeout, time.Second); err != nil {
		return Config{}, err
	}
	if cfg.ChatSessionTTL, err = durationEnv("CHAT_SESSION_TTL", cfg.ChatSessionTTL, 0); err != nil {
		return Config{}, err
	}
	// Slack rate limits chat.update, and a status line that is rewritten more
	// often than every second buys the reader nothing.
	if cfg.ChatStatusInterval, err = durationEnv("CHAT_STATUS_INTERVAL", cfg.ChatStatusInterval, time.Second); err != nil {
		return Config{}, err
	}
	if cfg.MaxConcurrentChats, err = intEnv("MAX_CONCURRENT_CHATS", cfg.MaxConcurrentChats, 1, 64); err != nil {
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

// ChatEnabled reports whether mention invocation is configured. Without an
// app-level token there is no Socket Mode connection to receive a mention on,
// so every other chat setting is inert.
func (c Config) ChatEnabled() bool { return c.SlackAppToken != "" }

// Agents returns every agent the bridge may route to, the default first and
// the mapped ones sorted after it. It exists for startup logging: the agent a
// given alert reaches is otherwise only visible once one fires.
func (c Config) Agents() []string {
	agents := []string{c.KagentAgent}
	seen := map[string]bool{c.KagentAgent: true}
	maps := []map[string]string{c.KagentAgentRoutingMap}
	if c.ChatEnabled() {
		if !seen[c.ChatAgent] {
			seen[c.ChatAgent] = true
			agents = append(agents, c.ChatAgent)
		}
		maps = append(maps, c.ChatAgentMap)
	}
	for _, table := range maps {
		for _, agent := range table {
			if !seen[agent] {
				seen[agent] = true
				agents = append(agents, agent)
			}
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

// listEnv parses a comma-separated list into a slice, keeping the order and
// the original spelling. Unlike setEnv it is used where the entries are not
// compared literally, the channel allow list above all: an entry may be a name
// or an ID and has to be resolved before it can be matched.
func listEnv(key string) []string {
	var items []string
	for item := range strings.SplitSeq(os.Getenv(key), ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
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
